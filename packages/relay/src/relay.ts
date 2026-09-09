import { EventEmitter } from 'node:events';
import { PROTOCOL_VERSION, decode, encode } from '@kremote/shared';
import {
  accessKeyHash, deviceKeyHash, sessionTokenHash,
  genAccessKey, genSessionToken,
} from './crypto.ts';
import { Store } from './store.ts';
import type { AnyFrame } from '@kremote/shared';

// Pairing core: authenticates peers, matches browser↔agent, pumps frames.
// Transport-agnostic (Peer interface) so tests can drive it with fakes.

export interface Peer {
  readonly id: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface RelayConfig {
  accessKeyTtlMs?: number;   // default 5 min
  sessionTtlMs?: number;     // default 12 h
  idleTimeoutMs?: number;    // default 30 min no frames
  maxSessionsPerDevice?: number; // default 4
}

const DEFAULTS: Required<RelayConfig> = {
  accessKeyTtlMs: 5 * 60_000,
  sessionTtlMs: 12 * 3_600_000,
  idleTimeoutMs: 30 * 60_000,
  maxSessionsPerDevice: 4,
};

interface AccessKeyEntry { keyHash: string; deviceId: string; expiresAt: number; used: boolean }

interface DeviceConn { peer: Peer; deviceId: string; lastFrameAt: number }
interface ClientConn {
  peer: Peer; deviceId: string; tokenId?: string; lastFrameAt: number;
  paired: boolean;
}

export class Relay extends EventEmitter {
  private cfg: Required<RelayConfig>;
  private store: Store;
  private accessKeys = new Map<string, AccessKeyEntry>(); // keyed by keyHash
  private devices = new Map<string, DeviceConn>();       // keyed by deviceId
  private clients = new Map<string, ClientConn>();       // keyed by peer.id

  constructor(store: Store, cfg: RelayConfig = {}) {
    super();
    this.store = store;
    this.cfg = { ...DEFAULTS, ...cfg };
  }

  get stats() {
    return {
      devices: this.devices.size,
      clients: this.clients.size,
      accessKeys: this.accessKeys.size,
    };
  }

  /** First frame from a new connection decides its role. */
  handleHello(peer: Peer, raw: string): void {
    let frame: AnyFrame;
    try { frame = decode(raw); } catch { return this.reject(peer, 'bad frame'); }

    if (frame.type === 'hello.agent') {
      if (frame.protocol !== PROTOCOL_VERSION) return this.reject(peer, 'protocol mismatch');
      const hash = deviceKeyHash(frame.deviceKey);
      const device = this.store.deviceByKeyHash(hash);
      if (!device) return this.reject(peer, 'unknown device key');
      if (this.devices.has(device.deviceId)) {
        // Reconnect: the old socket is stale (network drop); replace it.
        this.devices.get(device.deviceId)!.peer.close(4001, 'replaced');
        this.devices.delete(device.deviceId);
      }
      this.devices.set(device.deviceId, { peer, deviceId: device.deviceId, lastFrameAt: Date.now() });
      void this.store.touchDevice(device.deviceId);
      peer.send(encode({ type: 'hello.res', ok: true }));
      this.emit('agent-connected', device.deviceId);
      // Re-pair any clients waiting for this device and tell them the agent is
      // back, so they can reattach their surviving terminals.
      for (const c of this.clients.values()) {
        if (c.deviceId === device.deviceId && !c.paired) {
          this.tryPair(c);
          if (c.paired) c.peer.send(encode({ type: 'peer.back' } satisfies AnyFrame));
        }
      }
      return;
    }

    if (frame.type === 'hello.client') {
      if (frame.protocol !== PROTOCOL_VERSION) return this.reject(peer, 'protocol mismatch');
      const now = Date.now();

      // Silent reconnect: authenticate with a durable session token. The token
      // outlives the socket, so the browser can drop and re-pair without a new
      // ACCESS_KEY. We slide its expiry forward and re-pair with the agent.
      if (frame.session) {
        const rec = this.store.sessionByTokenHash(sessionTokenHash(frame.session));
        if (!rec || Date.parse(rec.expiresAt) < now) {
          return this.reject(peer, 'session expired');
        }
        const expiresAt = new Date(now + this.cfg.sessionTtlMs).toISOString();
        void this.store.touchSession(rec.tokenId, expiresAt);
        const conn: ClientConn = {
          peer, deviceId: rec.deviceId, tokenId: rec.tokenId, lastFrameAt: now, paired: false,
        };
        this.clients.set(peer.id, conn);
        // Echo the token so the browser can keep persisting the same one.
        peer.send(encode({ type: 'hello.res', ok: true, session: frame.session }));
        this.emit('client-authed', rec.deviceId);
        this.tryPair(conn); // pairs now if agent is up, else waits for reconnect
        return;
      }

      if (!frame.accessKey) return this.reject(peer, 'expected access key or session');
      const entry = this.accessKeys.get(accessKeyHash(frame.accessKey));
      if (!entry || entry.used || entry.expiresAt < now) {
        this.accessKeys.delete(accessKeyHash(frame.accessKey));
        return this.reject(peer, 'invalid or expired access key');
      }
      entry.used = true; // one-time
      this.accessKeys.delete(accessKeyHash(frame.accessKey));
      if (!this.devices.has(entry.deviceId)) {
        return this.reject(peer, 'agent offline');
      }
      if (this.countDeviceClients(entry.deviceId) >= this.cfg.maxSessionsPerDevice) {
        return this.reject(peer, 'too many sessions for this device');
      }
      const token = genSessionToken();
      const tokenId = `ses_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      void this.store.addSession({
        tokenId,
        keyHash: sessionTokenHash(token),
        deviceId: entry.deviceId,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + this.cfg.sessionTtlMs).toISOString(),
      });
      const conn: ClientConn = {
        peer, deviceId: entry.deviceId, tokenId, lastFrameAt: now, paired: false,
      };
      this.clients.set(peer.id, conn);
      // Hand the browser its durable token for persistent login + reconnect.
      peer.send(encode({ type: 'hello.res', ok: true, session: token }));
      this.emit('client-authed', entry.deviceId);
      this.tryPair(conn);
      return;
    }

    this.reject(peer, 'expected hello');
  }

  /** Frames after pairing: pump both ways, never parse terminal content. */
  handleFrame(peer: Peer, raw: string): void {
    const client = this.clients.get(peer.id);
    if (client) {
      client.lastFrameAt = Date.now();
      const dev = this.devices.get(client.deviceId);
      if (dev) { dev.lastFrameAt = Date.now(); dev.peer.send(raw); }
      return;
    }
    // Otherwise it must be a device peer; route to all its paired clients.
    for (const dev of this.devices.values()) {
      if (dev.peer.id !== peer.id) continue;
      dev.lastFrameAt = Date.now();
      for (const c of this.clients.values()) {
        if (c.deviceId === dev.deviceId && c.paired) {
          c.lastFrameAt = Date.now();
          c.peer.send(raw);
        }
      }
      return;
    }
    // Unpaired client frames (e.g. before agent reconnects) are dropped.
  }

  /** Agent asks relay to mint a one-time ACCESS_KEY for the browser. */
  handleAccessKeyReq(peer: Peer, id: string): { key: string; url: string; expiresMs: number } | null {
    const dev = [...this.devices.values()].find(d => d.peer.id === peer.id);
    if (!dev) return null;
    const key = genAccessKey();
    const expiresMs = this.cfg.accessKeyTtlMs;
    this.accessKeys.set(accessKeyHash(key), {
      keyHash: accessKeyHash(key), deviceId: dev.deviceId,
      expiresAt: Date.now() + expiresMs, used: false,
    });
    const url = (process.env.KREMOTE_PUBLIC_URL ?? '') + `/?key=${key}`;
    return { key, url, expiresMs };
  }

  handleClose(peer: Peer): void {
    const client = this.clients.get(peer.id);
    if (client) {
      this.clients.delete(peer.id);
      // Keep the session record: the browser may reconnect silently with its
      // durable token. Expired sessions are swept by tick()/pruneSessions.
      const dev = this.devices.get(client.deviceId);
      if (dev) dev.peer.send(encode({ type: 'peer.gone' } satisfies AnyFrame));
      this.emit('client-closed', client.deviceId);
      return;
    }
    for (const [deviceId, dev] of this.devices) {
      if (dev.peer.id !== peer.id) continue;
      this.devices.delete(deviceId);
      // Tell every paired client their agent went offline.
      for (const c of this.clients.values()) {
        if (c.deviceId === deviceId && c.paired) {
          c.paired = false;
          c.peer.send(encode({ type: 'peer.gone' } satisfies AnyFrame));
        }
      }
      this.emit('agent-disconnected', deviceId);
      return;
    }
  }

  /** Periodic sweep: idle timeouts + expired access keys/sessions. */
  tick(now = Date.now()): void {
    for (const [hash, e] of this.accessKeys) {
      if (e.expiresAt < now) this.accessKeys.delete(hash);
    }
    for (const [deviceId, dev] of this.devices) {
      if (now - dev.lastFrameAt > this.cfg.idleTimeoutMs) {
        dev.peer.close(4002, 'idle');
        this.devices.delete(deviceId);
      }
    }
    for (const [id, c] of this.clients) {
      if (now - c.lastFrameAt > this.cfg.idleTimeoutMs) {
        c.peer.close(4002, 'idle');
        this.clients.delete(id);
      }
    }
    void this.store.pruneSessions(now);
  }

  isAgent(peerId: string): boolean {
    return [...this.devices.values()].some(d => d.peer.id === peerId);
  }

  /** True once a peer has authed (device conn or client conn), paired or not. */
  hasClient(peerId: string): boolean {
    return this.clients.has(peerId);
  }

  isPairedClient(peerId: string): boolean {
    return this.clients.get(peerId)?.paired ?? false;
  }

  private countDeviceClients(deviceId: string): number {
    let n = 0;
    for (const c of this.clients.values()) if (c.deviceId === deviceId) n++;
    return n;
  }

  private tryPair(c: ClientConn): void {
    const dev = this.devices.get(c.deviceId);
    if (!dev) return; // wait for agent reconnect; hello.res already sent
    c.paired = true;
    this.emit('paired', c.deviceId, c.peer.id);
  }

  private reject(peer: Peer, error: string): void {
    // Single choke point for every hello failure. Emit before closing so the
    // transport layer can audit-log it and classify credential guesses toward
    // brute-force blocking (index.ts). Relay itself stays IP-agnostic.
    this.emit('rejected', peer.id, error);
    peer.send(encode({ type: 'hello.res', ok: false, error }));
    peer.close(4003, error);
  }
}
