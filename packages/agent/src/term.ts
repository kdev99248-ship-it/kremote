import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as pty from 'node-pty';

// Owns the node-pty processes for this agent. Emits `data` / `exit` per
// terminal; the WS layer turns those into term.data / term.exit frames.

export interface TermInfo {
  termId: string;
  shell: string;
  cwd: string;
}

/**
 * Shell to spawn. On Windows we prefer PowerShell 7+ (pwsh.exe — UTF-8 native)
 * and fall back to Windows PowerShell 5.1 wrapped in a `chcp 65001` cmd so
 * Vietnamese/Unicode text survives the legacy OEM codepage. KREMOTE_SHELL
 * overrides everything (spawned verbatim, no wrapper).
 */
export function resolveShell(): { shell: string; args: string[]; label: string } {
  if (process.platform !== 'win32') {
    return { shell: process.env.SHELL ?? '/bin/bash', args: [], label: process.env.SHELL ?? '/bin/bash' };
  }
  const override = process.env.KREMOTE_SHELL;
  if (override) return { shell: override, args: [], label: override };

  const pwsh = join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  if (existsSync(pwsh)) return { shell: pwsh, args: ['-NoLogo'], label: pwsh };

  // cmd wrapper: chcp 65001 switches the ConPTY console to UTF-8 for the whole
  // chain, so PSReadLine round-trips Vietnamese through pty.write() intact.
  return {
    shell: 'cmd.exe',
    args: ['/d', '/c', 'chcp 65001 >nul && powershell.exe -NoLogo'],
    label: 'powershell.exe',
  };
}

// Kept for backwards compatibility (config/tests may import it).
export const DEFAULT_SHELL = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL ?? '/bin/bash');
export const DEFAULT_ARGS = process.platform === 'win32' ? ['-NoLogo'] : [];

// Per-terminal scrollback kept so a browser that reconnects can replay recent
// output instead of facing a blank screen. Capped by bytes (a rough proxy for
// characters) with a hard slice on overflow — cheap and good enough.
const SCROLLBACK_LIMIT = 256 * 1024;

interface TermEntry { proc: pty.IPty; info: TermInfo; buffer: string }

export class TermManager extends EventEmitter {
  private terms = new Map<string, TermEntry>();
  private seq = 0;

  get size(): number { return this.terms.size; }

  list(): TermInfo[] {
    return [...this.terms.values()].map(t => t.info);
  }

  /** Recent output for `termId`, for replay on reconnect. '' if unknown. */
  scrollback(termId: string): string {
    return this.terms.get(termId)?.buffer ?? '';
  }

  get(termId: string): TermInfo | undefined {
    return this.terms.get(termId)?.info;
  }

  open(opts: { shell?: string; args?: string[]; cols?: number; rows?: number; cwd?: string } = {}): TermInfo {
    let shell: string;
    let args: string[];
    let label: string;
    if (opts.shell) {
      shell = opts.shell;
      args = opts.args ?? DEFAULT_ARGS;
      label = opts.shell;
    } else {
      const resolved = resolveShell();
      shell = resolved.shell;
      args = opts.args ?? resolved.args;
      label = resolved.label;
    }
    const cwd = opts.cwd ?? process.env.USERPROFILE ?? process.cwd();
    const termId = `t${++this.seq}_${Date.now().toString(36)}`;

    const proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: clampInt(opts.cols, 1, 500, 80),
      rows: clampInt(opts.rows, 1, 200, 24),
      cwd,
      env: process.env as Record<string, string>,
    });

    const entry: TermEntry = { proc, info: { termId, shell: label, cwd }, buffer: '' };
    this.terms.set(termId, entry);

    proc.onData(data => {
      entry.buffer += data;
      if (entry.buffer.length > SCROLLBACK_LIMIT) {
        entry.buffer = entry.buffer.slice(entry.buffer.length - SCROLLBACK_LIMIT);
      }
      this.emit('data', termId, data);
    });
    proc.onExit(({ exitCode, signal }) => {
      this.terms.delete(termId);
      this.emit('exit', termId, signal == null ? exitCode : null);
    });

    return { termId, shell: label, cwd };
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
