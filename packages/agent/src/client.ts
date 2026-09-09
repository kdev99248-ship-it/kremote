import { WebSocket } from 'ws';
import { decode, encode, PROTOCOL_VERSION } from '@kremote/shared';
import type { AnyFrame, ClientToAgent } from '@kremote/shared';
import { TermManager, DEFAULT_SHELL } from './term.ts';
import { FsError, FsHandlers } from './fs.ts';
import { GitRunner } from './git.ts';
import type { AgentConfig } from './config.ts';

// Dials the relay, stays connected (exponential backoff reconnect), and
// bridges protocol frames ↔ TermManager / FsHandlers / GitRunner. Terminal
// content is never parsed.

export class AgentClient {
  private ws: WebSocket | null = null;
  private retry = 0;
  private closed = false;
  private terms = new TermManager();
  private readonly fs: FsHandlers;
  private readonly git: GitRunner;
  private pendingAccessKey = new Map<string, (r: { key: string; url: string; expiresMs: number }) => void>();
  private accessKeySeq = 0;
  private readonly cfg: AgentConfig;
  /** Fired each time the relay accepts our hello (i.e. relay is up + authed). */
  onHelloOk: (() => void) | null = null;

  constructor(cfg: AgentConfig) {
    this.cfg = cfg;
    this.fs = new FsHandlers(cfg.root ?? process.cwd());
    this.git = new GitRunner(this.fs, cfg.gitCredentials);
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

  private async handle(frame: AnyFrame): Promise<void> {
    switch (frame.type) {
      case 'hello.res':
        if (!frame.ok) console.error(`[agent] relay rejected hello: ${frame.error}`);
        else this.onHelloOk?.();
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

      case 'term.attach': {
        const f = frame as any;
        const info = this.terms.get(f.termId);
        if (!info) {
          this.send({ type: 'term.attach.res', id: f.id, ok: false, error: 'no such terminal' } as AnyFrame);
          return;
        }
        // Resize the pty to the reconnecting browser's viewport, then replay.
        if (typeof f.cols === 'number' && typeof f.rows === 'number') {
          this.terms.resize(f.termId, f.cols, f.rows);
        }
        this.send({
          type: 'term.attach.res', id: f.id, ok: true, termId: f.termId,
          data: this.terms.scrollback(f.termId), cwd: info.cwd, shell: info.shell,
        } as AnyFrame);
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

      // ── Files ──────────────────────────────────────────────────────────
      case 'fs.list': {
        const f = frame as any;
        try {
          const r = await this.fs.list(f.path);
          this.send({ type: 'fs.list.res', id: f.id, ok: true, ...r } as AnyFrame);
        } catch (e) { this.send(this.fsErr('fs.list.res', f.id, e)); }
        return;
      }

      case 'fs.read': {
        const f = frame as any;
        try {
          const r = await this.fs.read(f.path);
          this.send({ type: 'fs.read.res', id: f.id, ok: true, ...r } as AnyFrame);
        } catch (e) { this.send(this.fsErr('fs.read.res', f.id, e)); }
        return;
      }

      case 'fs.write': {
        const f = frame as any;
        try {
          const r = await this.fs.write(f.path, f.content, f.baseMtimeMs);
          this.send({ type: 'fs.write.res', id: f.id, ok: true, ...r } as AnyFrame);
        } catch (e) {
          const res = this.fsErr('fs.write.res', f.id, e);
          if (e instanceof FsError && e.conflict) {
            (res as any).conflict = true;
            (res as any).serverMtimeMs = e.serverMtimeMs;
          }
          this.send(res);
        }
        return;
      }

      case 'fs.mkdir': {
        const f = frame as any;
        try {
          await this.fs.mkdir(f.path);
          this.send({ type: 'fs.mkdir.res', id: f.id, ok: true } as AnyFrame);
        } catch (e) { this.send(this.fsErr('fs.mkdir.res', f.id, e)); }
        return;
      }

      case 'fs.rename': {
        const f = frame as any;
        try {
          await this.fs.rename(f.from, f.to);
          this.send({ type: 'fs.rename.res', id: f.id, ok: true } as AnyFrame);
        } catch (e) { this.send(this.fsErr('fs.rename.res', f.id, e)); }
        return;
      }

      case 'fs.delete': {
        const f = frame as any;
        try {
          await this.fs.delete(f.path, f.recursive);
          this.send({ type: 'fs.delete.res', id: f.id, ok: true } as AnyFrame);
        } catch (e) { this.send(this.fsErr('fs.delete.res', f.id, e)); }
        return;
      }

      // ── Git ────────────────────────────────────────────────────────────
      case 'git.status': {
        const f = frame as any;
        try {
          const r = await this.git.status(f.repo);
          this.send({ type: 'git.status.res', id: f.id, ok: true, repo: f.repo, ...r } as AnyFrame);
        } catch (e) { this.send(this.gitErr('git.status.res', f.id, e)); }
        return;
      }

      case 'git.diff': {
        const f = frame as any;
        try {
          const diff = await this.git.diff(f.repo, { staged: f.staged, path: f.path });
          this.send({ type: 'git.diff.res', id: f.id, ok: true, diff } as AnyFrame);
        } catch (e) { this.send(this.gitErr('git.diff.res', f.id, e)); }
        return;
      }

      case 'git.commit': {
        const f = frame as any;
        try {
          await this.git.commit(f.repo, f.message, f.all);
          this.send({ type: 'git.commit.res', id: f.id, ok: true } as AnyFrame);
        } catch (e) { this.send(this.gitErr('git.commit.res', f.id, e)); }
        return;
      }

      case 'git.push': {
        const f = frame as any;
        try {
          await this.git.push(f.repo);
          this.send({ type: 'git.push.res', id: f.id, ok: true } as AnyFrame);
        } catch (e) { this.send(this.gitErr('git.push.res', f.id, e)); }
        return;
      }

      case 'git.log': {
        const f = frame as any;
        try {
          const commits = await this.git.log(f.repo, f.limit);
          this.send({ type: 'git.log.res', id: f.id, ok: true, commits } as AnyFrame);
        } catch (e) { this.send(this.gitErr('git.log.res', f.id, e)); }
        return;
      }

      default:
        // Unknown/irrelevant frame — ignore.
        return;
    }
  }

  /** Normalize any throw into a `*.res` error frame. */
  private fsErr(type: string, id: string, e: unknown): AnyFrame {
    const error = e instanceof FsError ? e.message : (e as Error)?.message ?? String(e);
    return { type, id, ok: false, error } as AnyFrame;
  }

  private gitErr(type: string, id: string, e: unknown): AnyFrame {
    const error = (e as Error)?.message ?? String(e);
    return { type, id, ok: false, error } as AnyFrame;
  }

  private handleTermOpen(f: any): void {
    try {
      const info = this.terms.open({ shell: f.shell ?? DEFAULT_SHELL, cols: f.cols, rows: f.rows, cwd: f.cwd });
      this.send({ type: 'term.open.res', id: f.id, termId: info.termId, ok: true, cwd: info.cwd, shell: info.shell } as AnyFrame);
    } catch (e: any) {
      this.send({ type: 'term.open.res', id: f.id, ok: false, error: e?.message ?? 'spawn failed' } as AnyFrame);
    }
  }
}
