import { readdir, readFile, stat, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  MAX_READ_BYTES, MAX_WRITE_BYTES,
} from '@kremote/shared';
import type { FsEntry, EntryKind } from '@kremote/shared';
import { PathEscapeError, resolveInRootSafe } from './pathguard.ts';

// fs.* handlers. Every path goes through resolveInRootSafe (lexical check +
// realpath check, so symlink/junction escapes are rejected). All results are
// plain values ready to drop into a response frame.

export class FsError extends Error {
  readonly code: string;
  readonly conflict: boolean;
  readonly serverMtimeMs?: number;
  constructor(message: string, opts: { code?: string; conflict?: boolean; serverMtimeMs?: number } = {}) {
    super(message);
    this.name = 'FsError';
    this.code = opts.code ?? 'error';
    this.conflict = opts.conflict ?? false;
    this.serverMtimeMs = opts.serverMtimeMs;
  }
}

/** Guard against a guard failure masquerading as a generic error. */
function wrap(err: unknown, ctx: string): never {
  if (err instanceof FsError) throw err;
  if (err instanceof PathEscapeError) {
    throw new FsError(err.message, { code: 'forbidden' });
  }
  const e = err as NodeJS.ErrnoException;
  throw new FsError(`${ctx}: ${e?.message ?? String(err)}`, { code: e?.code ?? 'error' });
}

function kindOf(st: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): EntryKind {
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'dir';
  if (st.isFile()) return 'file';
  return 'other';
}

/** Heuristic: reject binary content so we never ship garbage to CodeMirror. */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    // NUL is the strongest signal; also reject most C0 controls except \t \n \r \f \e.
    if (b === 0) return true;
    if (b < 9) return true;
    if (b > 13 && b < 32) return true;
  }
  return false;
}

export class FsHandlers {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  get rootPath(): string { return this.root; }

  async list(relPath: string): Promise<{ path: string; entries: FsEntry[] }> {
    let dir: string;
    try { dir = await resolveInRootSafe(this.root, relPath); }
    catch (e) { wrap(e, 'fs.list'); }

    let names: string[];
    try { names = await readdir(dir); }
    catch (e) { wrap(e, 'fs.list'); }

    const entries: FsEntry[] = [];
    for (const name of names) {
      const full = join(dir, name);
      try {
        // lstat so symlinks are reported as symlinks, not followed.
        const st = await lstat(full);
        entries.push({ name, kind: kindOf(st), size: st.isFile() ? st.size : 0, mtimeMs: st.mtimeMs });
      } catch {
        entries.push({ name, kind: 'other', size: 0, mtimeMs: 0 });
      }
    }

    // Dirs first, then files, each case-insensitive alphabetical.
    entries.sort((a, b) => {
      const ad = a.kind === 'dir' ? 0 : 1;
      const bd = b.kind === 'dir' ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    return { path: relPath, entries };
  }

  async read(relPath: string): Promise<{ path: string; content: string; mtimeMs: number; size: number; truncated: boolean }> {
    let file: string;
    try { file = await resolveInRootSafe(this.root, relPath); }
    catch (e) { wrap(e, 'fs.read'); }

    let st;
    try { st = await stat(file); }
    catch (e) { wrap(e, 'fs.read'); }
    if (!st.isFile()) throw new FsError('not a file', { code: 'ENOENT' });
    if (st.size > MAX_READ_BYTES) {
      throw new FsError(`file too large (${st.size} bytes > ${MAX_READ_BYTES})`, { code: 'EFBIG' });
    }

    let buf: Buffer;
    try { buf = await readFile(file); }
    catch (e) { wrap(e, 'fs.read'); }
    if (looksBinary(buf)) throw new FsError('binary file not supported', { code: 'EBINARY' });

    // Re-stat after read: mtime must describe the bytes we're returning.
    let mtimeMs = st.mtimeMs;
    try { mtimeMs = (await stat(file)).mtimeMs; } catch { /* keep earlier value */ }

    const content = buf.toString('utf8');
    return { path: relPath, content, mtimeMs, size: st.size, truncated: false };
  }

  /**
   * Write with an mtime-conflict check: if `baseMtimeMs` is given and the file
   * on disk changed since the client read it, reject instead of clobbering.
   */
  async write(relPath: string, content: string, baseMtimeMs?: number): Promise<{ path: string; mtimeMs: number }> {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_WRITE_BYTES) {
      throw new FsError(`write too large (${bytes} bytes > ${MAX_WRITE_BYTES})`, { code: 'EFBIG' });
    }

    let file: string;
    try { file = await resolveInRootSafe(this.root, relPath); }
    catch (e) { wrap(e, 'fs.write'); }

    if (baseMtimeMs !== undefined) {
      try {
        const st = await stat(file);
        // 2ms tolerance: NTFS/FAT timestamp granularity differs per volume.
        if (Math.abs(st.mtimeMs - baseMtimeMs) > 2) {
          throw new FsError('file changed since it was read', {
            code: 'ECONFLICT', conflict: true, serverMtimeMs: st.mtimeMs,
          });
        }
      } catch (e) {
        if (e instanceof FsError) throw e;
        const err = e as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') wrap(e, 'fs.write');
        // ENOENT: file vanished since read. Treat as a conflict, not a create.
        throw new FsError('file no longer exists', { code: 'ECONFLICT', conflict: true });
      }
    }

    try { await writeFile(file, content, 'utf8'); }
    catch (e) { wrap(e, 'fs.write'); }

    let mtimeMs = Date.now();
    try { mtimeMs = (await stat(file)).mtimeMs; } catch {}
    return { path: relPath, mtimeMs };
  }

  async mkdir(relPath: string): Promise<void> {
    let dir: string;
    try { dir = await resolveInRootSafe(this.root, relPath); }
    catch (e) { wrap(e, 'fs.mkdir'); }
    try { await mkdir(dir, { recursive: true }); }
    catch (e) { wrap(e, 'fs.mkdir'); }
  }

  async rename(from: string, to: string): Promise<void> {
    let src: string, dst: string;
    try { src = await resolveInRootSafe(this.root, from); }
    catch (e) { wrap(e, 'fs.rename'); }
    try { dst = await resolveInRootSafe(this.root, to); }
    catch (e) { wrap(e, 'fs.rename'); }
    try { await rename(src, dst); }
    catch (e) { wrap(e, 'fs.rename'); }
  }

  /** Delete a file, or a directory only when `recursive` is set. */
  async delete(relPath: string, recursive = false): Promise<void> {
    let target: string;
    try { target = await resolveInRootSafe(this.root, relPath); }
    catch (e) { wrap(e, 'fs.delete'); }

    let st;
    try { st = await lstat(target); }
    catch (e) { wrap(e, 'fs.delete'); }

    if (st.isDirectory() && !recursive) {
      throw new FsError('directory requires recursive delete', { code: 'EISDIR' });
    }
    try { await rm(target, { recursive, force: false }); }
    catch (e) { wrap(e, 'fs.delete'); }
  }

  /** Absolute path of the root — used by git handlers to pick a repo. */
  resolve(relPath: string): Promise<string> {
    return resolveInRootSafe(this.root, relPath);
  }

  baseName(p: string): string { return basename(p); }
}
