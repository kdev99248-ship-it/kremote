import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

// Trust boundary — NOT simplifiable. Every fs.* / git.* path argument is
// resolved against a configured root and rejected if it escapes.
//
// Two layers:
//  1. Lexical: resolve(root, candidate) must stay under root. Catches `../`.
//  2. Realpath (when the path exists): resolves symlinks, then re-checks the
//     boundary. Catches a symlink inside root that points outside it.

export class PathEscapeError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`path escapes root: ${detail}`);
    this.name = 'PathEscapeError';
    this.detail = detail;
  }
}

/** True if `child` is `parent` or nested under it (segment-aware). */
export function isUnder(parent: string, child: string): boolean {
  const p = normalizeSep(resolve(parent));
  const c = normalizeSep(resolve(child));
  if (c === p) return true;
  const prefix = p.endsWith(sep) ? p : p + sep;
  return c.startsWith(prefix);
}

function normalizeSep(s: string): string {
  return s.replace(/\//g, sep);
}

/**
 * Resolve a user-supplied path against root, rejecting escapes.
 * `candidate` may be relative (joined to root) or absolute (must be under root).
 */
export function resolveInRoot(root: string, candidate: string): string {
  if (candidate.includes('\0')) throw new PathEscapeError('null byte');
  const resolved = resolve(root, candidate);
  if (!isUnder(root, resolved)) {
    throw new PathEscapeError(candidate);
  }
  return resolved;
}

/**
 * Like resolveInRoot, but also follows symlinks and re-checks the boundary.
 * Use before any read/write/delete. If the path doesn't exist yet, the
 * lexical check is the best we can do (caller creates the file at `resolved`).
 */
export async function resolveInRootSafe(root: string, candidate: string): Promise<string> {
  const resolved = resolveInRoot(root, candidate);
  let real: string;
  try {
    real = await realpath(resolved);
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      // Doesn't exist — verify the nearest existing ancestor stays in root.
      let dir = resolved;
      for (;;) {
        try { real = await realpath(dir); break; }
        catch (e: any) {
          if (e?.code !== 'ENOENT') throw e;
          const parent = resolve(dir, '..');
          if (parent === dir) throw new PathEscapeError(candidate);
          dir = parent;
        }
      }
      // `real` is an ancestor of `resolved`; ensure it's in root.
      if (!isUnder(root, real)) throw new PathEscapeError(candidate);
      return resolved;
    }
    throw err;
  }
  if (!isUnder(root, real)) {
    throw new PathEscapeError(`${candidate} → ${real} (symlink/junction escape)`);
  }
  return resolved;
}

/** Reject absolute paths that aren't already under root (explicit spec rule). */
export function assertNotOutsideAbsolute(root: string, candidate: string): void {
  if (isAbsolute(candidate) && !isUnder(root, candidate)) {
    throw new PathEscapeError(`absolute path outside root: ${candidate}`);
  }
}
