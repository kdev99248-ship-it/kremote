import { WebSocket } from 'ws';
import { decode, encode, PROTOCOL_VERSION } from '@kremote/shared';
import type { AnyFrame, ClientToAgent } from '@kremote/shared';
import { TermManager, DEFAULT_SHELL } from './term.ts';
import type { AgentConfig } from './config.ts';

// Dials the relay, stays connected (exponential backoff reconnect), and
// bridges protocol frames ↔ TermManager. Terminal content is never parsed.

export class AgentClient {
  private ws: WebSocket | null = null;
  private retry = 0;
  private closed = false;
  private terms = new TermManager();
  private pendingAccessKey = new Map<string, (r: { key: string; url: string; expiresMs: number }) => void>();
  private accessKeySeq = 0;
  private readonly cfg: AgentConfig;

  constructor(cfg: AgentConfig) {
    this.cfg = cfg;
    this.terms.on('data', (termId, data) => this.send({ type: 'term.data', termId, data } as AnyFrame));
    this.terms.on('exit', (termId, code) => this.send({ type: 'term.exit', termId, code } as AnyFrame));
  }

  connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.cfg.relayUrl, {
      headers: { 'user-agent': `kremote-agent/${this.cfg.label ?? 'win'}` },
    });
    this.ws = ws;

    ws.on('open', () => {
      this.retry = 0;
      console.log(`[agent] connected to ${this.cfg.relayUrl}`);
      this.send({ type: 'hello.agent', deviceKey: this.cfg.deviceKey, protocol: PROTOCOL_VERSION } as AnyFrame);
    });

    ws.on('message', (raw) => {
      let frame: AnyFrame;
      try { frame = decode(raw.toString()); } catch { return; }
      this.handle(frame);
    });

    ws.on('close', () => { this.ws = null; this.scheduleReconnect(); });
    ws.on('error', (e: Error) => {
      console.error(`[agent] ws error: ${e.message}`);
      this.ws = null;
      this.scheduleReconnect();
    });
  }

  stop(): void {
    this.closed = true;
    this.terms.closeAll();
    try { this.ws?.close(1000, 'shutdown'); } catch {}
    this.ws = null;
  }

  /** Ask the relay to mint a one-time ACCESS_KEY; resolves with key+url. */
  requestAccessKey(timeoutMs = 10_000): Promise<{ key: string; url: string; expiresMs: number }> {
    const id = `ak${++this.accessKeySeq}`;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pendingAccessKey.delete(id); rej(new Error('accesskey timeout')); }, timeoutMs);
      this.pendingAccessKey.set(id, (r) => { clearTimeout(t); res(r); });
      this.send({ type: 'accesskey.req', id } as AnyFrame);
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = Math.min(30_000, 500 * 2 ** this.retry++);
    console.log(`[agent] reconnecting in ${delay}ms`);
    setTimeout(() => this.connect(), delay);
  }

  private send(frame: AnyFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encode(frame));
  }

  private handle(frame: AnyFrame): void {
    switch (frame.type) {
      case 'hello.res':
        if (!frame.ok) console.error(`[agent] relay rejected hello: ${frame.error}`);
        return;

      case 'accesskey.res': {
        const cb = this.pendingAccessKey.get(frame.id);
        if (cb) { this.pendingAccessKey.delete(frame.id); cb(frame as any); }
        return;
      }

      case 'peer.gone':
        // Browser disconnected. Terminals stay alive (multi-session, resumable).
        console.log('[agent] client disconnected (peer.gone)');
        return;

      case 'term.open':
        return this.handleTermOpen(frame as ClientToAgent & { type: 'term.open' });

      case 'term.close': {
        const f = frame as any;
        const ok = this.terms.close(f.termId);
        this.send({ type: 'term.close.res', id: f.id, ok } as AnyFrame);
        return;
      }

      case 'term.list': {
        const f = frame as any;
        this.send({ type: 'term.list.res', id: f.id, terms: this.terms.list() } as AnyFrame);
        return;
      }

      case 'term.input': {
        const f = frame as any;
        this.terms.input(f.termId, f.data);
        return;
      }

      case 'term.resize': {
        const f = frame as any;
        this.terms.resize(f.termId, f.cols, f.rows);
        return;
      }

      default:
        // Unknown/irrelevant frame — ignore.
        return;
    }
  }

  private handleTermOpen(f: any): void {
    try {
      const info = this.terms.open({ shell: f.shell ?? DEFAULT_SHELL, cols: f.cols, rows: f.rows, cwd: f.cwd });
      this.send({ type: 'term.open.res', id: f.id, termId: info.termId, ok: true } as AnyFrame);
    } catch (e: any) {
      this.send({ type: 'term.open.res', id: f.id, ok: false, error: e?.message ?? 'spawn failed' } as AnyFrame);
    }
  }
}
