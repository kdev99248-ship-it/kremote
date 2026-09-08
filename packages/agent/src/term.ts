import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';

// Owns the node-pty processes for this agent. Emits `data` / `exit` per
// terminal; the WS layer turns those into term.data / term.exit frames.

export interface TermInfo {
  termId: string;
  shell: string;
  cwd: string;
}

export const DEFAULT_SHELL = process.platform === 'win32'
  ? (process.env.KREMOTE_SHELL ?? 'powershell.exe')
  : (process.env.SHELL ?? '/bin/bash');

export const DEFAULT_ARGS = process.platform === 'win32'
  ? ['-NoLogo']
  : [];

export class TermManager extends EventEmitter {
  private terms = new Map<string, { proc: pty.IPty; info: TermInfo }>();
  private seq = 0;

  get size(): number { return this.terms.size; }

  list(): TermInfo[] {
    return [...this.terms.values()].map(t => t.info);
  }

  open(opts: { shell?: string; args?: string[]; cols?: number; rows?: number; cwd?: string } = {}): TermInfo {
    const shell = opts.shell ?? DEFAULT_SHELL;
    const args = opts.args ?? DEFAULT_ARGS;
    const cwd = opts.cwd ?? process.env.USERPROFILE ?? process.cwd();
    const termId = `t${++this.seq}_${Date.now().toString(36)}`;

    const proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: clampInt(opts.cols, 1, 500, 80),
      rows: clampInt(opts.rows, 1, 200, 24),
      cwd,
      env: process.env as Record<string, string>,
    });

    this.terms.set(termId, { proc, info: { termId, shell, cwd } });

    proc.onData(data => this.emit('data', termId, data));
    proc.onExit(({ exitCode, signal }) => {
      this.terms.delete(termId);
      this.emit('exit', termId, signal == null ? exitCode : null);
    });

    return { termId, shell, cwd };
  }

  input(termId: string, data: string): boolean {
    const t = this.terms.get(termId);
    if (!t) return false;
    try { t.proc.write(data); } catch { return false; }
    return true;
  }

  resize(termId: string, cols: number, rows: number): boolean {
    const t = this.terms.get(termId);
    if (!t) return false;
    try {
      t.proc.resize(clampInt(cols, 1, 500, t.proc.cols), clampInt(rows, 1, 200, t.proc.rows));
    } catch { return false; }
    return true;
  }

  close(termId: string): boolean {
    const t = this.terms.get(termId);
    if (!t) return false;
    this.terms.delete(termId);
    try { t.proc.kill(); } catch {}
    return true;
  }

  closeAll(): void {
    for (const id of [...this.terms.keys()]) this.close(id);
  }
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? Math.trunc(v) : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
