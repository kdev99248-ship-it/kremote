// Live file tail (`tail -f`) for the agent: watches a file inside root and
// streams appended bytes to the browser as `tail.data` frames.
//
// Windows notes (this is a Windows-first agent):
//  - fs.watch on Win10 fires rename/change events generously; we never trust
//    the event type — we just re-stat and read whatever grew.
//  - Log rotation (rename + recreate) is detected by inode/size heuristic:
//    if size shrinks below our offset, we restart from 0 (log was truncated
//    or rotated).

import { watch, type FSWatcher } from 'node:fs';
import { open as fsopen, stat } from 'node:fs/promises';
import { MAX_TAIL_WATCHES, TAIL_LAST_BYTES } from '@kremote/shared';
import { resolveInRootSafe } from './pathguard.ts';

export interface TailHandle {
  watchId: string;
  path: string;      // agent-relative path, as requested
  close(): void;
}

export class TailError extends Error {}

export class TailManager {
  private seq = 0;
  private watches = new Map<string, { path: string; abs: string; offset: number; fh: Awaited<ReturnType<typeof fsopen>> | null; watcher: FSWatcher; dead: boolean; notify: RegExp | null }>();

  private readonly root: string;
  private readonly onChunk: (watchId: string, chunk: string) => void;
  private readonly onDead: (watchId: string, reason: string) => void;
  private readonly onMatch: (watchId: string, path: string, line: string) => void;

  constructor(
    root: string,
    onChunk: (watchId: string, chunk: string) => void,
    onDead: (watchId: string, reason: string) => void,
    onMatch: (watchId: string, path: string, line: string) => void = () => {},
  ) {
    this.root = root;
    this.onChunk = onChunk;
    this.onDead = onDead;
    this.onMatch = onMatch;
  }

  /** Set (or clear) the server-side alert regex for a live watch. Returns false
   *  if the watch is unknown, or the pattern is an invalid regex. */
  setNotify(watchId: string, pattern?: string): boolean {
    const e = this.watches.get(watchId);
    if (!e) return false;
    if (!pattern) { e.notify = null; return true; }
    try { e.notify = new RegExp(pattern, 'i'); return true; }
    catch { e.notify = null; return false; }
  }

  get size(): number { return this.watches.size; }

  /** Start following `relPath`. Returns a handle used to stop. */
  async watch(relPath: string, opts: { fromEnd?: boolean; lastBytes?: number } = {}): Promise<TailHandle> {
    if (this.watches.size >= MAX_TAIL_WATCHES) {
      throw new TailError(`too many tail watches (max ${MAX_TAIL_WATCHES})`);
    }
    const abs = await resolveInRootSafe(this.root, relPath);

    let offset = 0;
    const st = await stat(abs).catch(() => null);
    if (!st?.isFile()) throw new TailError('not a file');
    offset = st.size;
    if (!opts.fromEnd) {
      const back = Math.min(opts.lastBytes ?? TAIL_LAST_BYTES, st.size);
      offset = st.size - back;
    }

    const watchId = `tw${++this.seq}_${Date.now().toString(36)}`;
    const entry = { path: relPath, abs, offset, fh: null as Awaited<ReturnType<typeof fsopen>> | null, watcher: null as unknown as FSWatcher, dead: false, notify: null as RegExp | null };
    this.watches.set(watchId, entry);

    entry.watcher = watch(abs, { persistent: false }, () => {
      if (!entry.dead) void this.pump(watchId);
    });
    entry.watcher.on('error', (err: Error) => {
      // File deleted / watcher failed: report and tear down this watch.
      this.drop(watchId, err.message);
    });

    return {
      watchId,
      path: relPath,
      close: () => this.drop(watchId, 'closed'),
    };
  }

  /** Emit whatever already sits between the watch offset and EOF. The caller
   *  must invoke this AFTER acknowledging the watch to the client (the
   *  response frame is what tells the client its watchId — data arriving
   *  before it would be dropped). */
  async initialReplay(watchId: string): Promise<void> {
    await this.pump(watchId);
  }

  unwatch(watchId: string): boolean {
    const e = this.watches.get(watchId);
    if (!e) return false;
    this.drop(watchId, 'closed');
    return true;
  }

  closeAll(): void {
    for (const id of [...this.watches.keys()]) this.drop(id, 'shutdown');
  }

  /** Read everything past our offset and emit it. Handles rotation. */
  private async pump(watchId: string): Promise<void> {
    const e = this.watches.get(watchId);
    if (!e || e.dead) return;
    try {
      const st = await stat(e.abs).catch(() => null);
      if (!st) { this.drop(watchId, 'file gone'); return; }
      if (st.size < e.offset) {
        // Shrunk: rotated/truncated log — restart from 0.
        e.offset = 0;
      }
      if (st.size === e.offset) return;
      e.fh ??= await fsopen(e.abs, 'r');
      const len = st.size - e.offset;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await e.fh.read(buf, 0, len, e.offset);
      if (bytesRead > 0) {
        e.offset += bytesRead;
        const chunk = buf.subarray(0, bytesRead).toString('utf8');
        this.onChunk(watchId, chunk);
        // Server-side alert: notify on the first matching line per chunk, so a
        // burst of matches is one push, not a flood.
        if (e.notify) {
          for (const line of chunk.split('\n')) {
            if (e.notify.test(line)) { this.onMatch(watchId, e.path, line); break; }
          }
        }
      }
    } catch (err: any) {
      this.drop(watchId, err?.message ?? 'read failed');
    }
  }

  private drop(watchId: string, reason: string): void {
    const e = this.watches.get(watchId);
    if (!e) return;
    e.dead = true;
    try { e.watcher?.close(); } catch { /* already closed */ }
    try { e.fh?.close(); } catch { /* already closed */ }
    this.watches.delete(watchId);
    this.onDead(watchId, reason);
  }
}
