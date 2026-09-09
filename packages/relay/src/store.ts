import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { deviceKeyHash, genDeviceKey } from './crypto.ts';

// Relay-side state: hashed device keys + hashed session tokens.
// A JSON file on the VPS is enough for a single-owner personal tool.

export interface DeviceRecord {
  deviceId: string;
  name: string;
  keyHash: string;      // sha256 of DEVICE_KEY
  createdAt: string;
  lastSeenAt?: string;
}

export interface SessionRecord {
  tokenId: string;
  keyHash: string;      // sha256 of SESSION_TOKEN
  deviceId: string;
  createdAt: string;
  expiresAt: string;
  label?: string;
}

export interface StoreShape {
  devices: DeviceRecord[];
  sessions: SessionRecord[];
}

export function defaultStorePath(): string {
  const base = process.env.KREMOTE_RELAY_HOME ?? join(homedir(), '.kremote-relay');
  return join(base, 'store.json');
}

const EMPTY: StoreShape = { devices: [], sessions: [] };

export class Store {
  private data: StoreShape = { devices: [], sessions: [] };
  private writes: Promise<void> = Promise.resolve();
  readonly path: string;

  constructor(path: string) { this.path = path; }

  static async load(path = defaultStorePath()): Promise<Store> {
    const s = new Store(path);
    try {
      s.data = { ...EMPTY, ...JSON.parse(await readFile(path, 'utf8')) };
      s.data.devices ??= [];
      s.data.sessions ??= [];
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
      s.data = { devices: [], sessions: [] };
    }
    return s;
  }

  get devices(): readonly DeviceRecord[] { return this.data.devices; }
  get sessions(): readonly SessionRecord[] { return this.data.sessions; }

  deviceByKeyHash(keyHash: string): DeviceRecord | undefined {
    return this.data.devices.find(d => d.keyHash === keyHash);
  }

  sessionByTokenHash(tokenHash: string): SessionRecord | undefined {
    return this.data.sessions.find(s => s.keyHash === tokenHash);
  }

  /** Register a brand-new device; returns {device, key} with plaintext key. */
  async addDevice(name: string): Promise<{ device: DeviceRecord; key: string }> {
    const key = genDeviceKey();
    const device: DeviceRecord = {
      deviceId: `dev_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name,
      keyHash: deviceKeyHash(key),
      createdAt: new Date().toISOString(),
    };
    this.data.devices.push(device);
    await this.flush();
    return { device, key };
  }

  touchDevice(deviceId: string): Promise<void> {
    const d = this.data.devices.find(x => x.deviceId === deviceId);
    if (d) d.lastSeenAt = new Date().toISOString();
    return this.flush();
  }

  addSession(rec: SessionRecord): Promise<void> {
    this.data.sessions.push(rec);
    return this.flush();
  }

  removeSession(tokenId: string): Promise<void> {
    this.data.sessions = this.data.sessions.filter(s => s.tokenId !== tokenId);
    return this.flush();
  }

  /** Slide a session's expiry forward (called when a browser reconnects with it). */
  touchSession(tokenId: string, expiresAt: string): Promise<void> {
    const s = this.data.sessions.find(x => x.tokenId === tokenId);
    if (!s) return Promise.resolve();
    s.expiresAt = expiresAt;
    return this.flush();
  }

  /** Drop sessions past expiresAt. */
  async pruneSessions(now = Date.now()): Promise<number> {
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter(s => Date.parse(s.expiresAt) > now);
    const removed = before - this.data.sessions.length;
    if (removed > 0) await this.flush();
    return removed;
  }

  sessionsForDevice(deviceId: string): SessionRecord[] {
    return this.data.sessions.filter(s => s.deviceId === deviceId);
  }

  /** Serialize writes so concurrent mutations can't clobber each other. */
  private flush(): Promise<void> {
    const next = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path, JSON.stringify(this.data, null, 2), 'utf8');
    });
    this.writes = next.catch(() => {});
    return next;
  }
}
