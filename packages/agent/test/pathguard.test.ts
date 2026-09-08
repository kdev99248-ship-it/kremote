import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  isUnder, resolveInRoot, resolveInRootSafe, PathEscapeError,
} from '../src/pathguard.ts';

async function withRoots(fn: (root: string, outside: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'kremote-pathguard-'));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  try { await fn(root, outside); } finally { await rm(base, { recursive: true, force: true }); }
}

test('isUnder: identity and nesting', () => {
  assert.ok(isUnder('C:\\root', 'C:\\root'));
  assert.ok(isUnder('C:\\root', 'C:\\root\\a\\b.txt'));
  assert.ok(!isUnder('C:\\root', 'C:\\rooted\\x'));   // prefix trap
  assert.ok(!isUnder('C:\\root', 'C:\\other'));
});

test('resolveInRoot accepts relative paths inside root', () => {
  assert.equal(resolveInRoot('C:\\root', 'a/b.txt'), resolve('C:\\root', 'a/b.txt'));
  assert.equal(resolveInRoot('C:\\root', '.'), resolve('C:\\root'));
});

test('resolveInRoot rejects ../ traversal', () => {
  assert.throws(() => resolveInRoot('C:\\root', '../secret'), PathEscapeError);
  assert.throws(() => resolveInRoot('C:\\root', 'a/../../secret'), PathEscapeError);
  assert.throws(() => resolveInRoot('C:\\root', '..\\..\\windows\\system32'), PathEscapeError);
});

test('resolveInRoot rejects absolute paths outside root', () => {
  assert.throws(() => resolveInRoot('C:\\root', 'C:\\Windows\\system32'), PathEscapeError);
  assert.throws(() => resolveInRoot('C:\\root', 'D:\\elsewhere\\file'), PathEscapeError);
  assert.throws(() => resolveInRoot('C:\\root', '\\\\server\\share'), PathEscapeError);
});

test('resolveInRoot rejects absolute paths inside root (allowed)', () => {
  const p = resolveInRoot('C:\\root', 'C:\\root\\ok.txt');
  assert.equal(p, resolve('C:\\root', 'ok.txt'));
});

test('resolveInRoot rejects null bytes', () => {
  assert.throws(() => resolveInRoot('C:\\root', 'a\0.txt'), PathEscapeError);
});

test('resolveInRootSafe follows symlink escape', async () => {
  await withRoots(async (root, outside) => {
    await writeFile(join(outside, 'secret.txt'), 'nope');
    // Directory junction/symlink inside root → outside.
    try {
      await symlink(outside, join(root, 'link'), 'junction');
    } catch {
      await symlink(outside, join(root, 'link'), 'dir');
    }
    await assert.rejects(
      () => resolveInRootSafe(root, join('link', 'secret.txt')),
      PathEscapeError,
    );
  });
});

test('resolveInRootSafe allows paths inside root', async () => {
  await withRoots(async (root) => {
    await mkdir(join(root, 'sub'), { recursive: true });
    await writeFile(join(root, 'sub', 'ok.txt'), 'yes');
    const p = await resolveInRootSafe(root, join('sub', 'ok.txt'));
    assert.equal(p, resolve(root, 'sub', 'ok.txt'));
  });
});

test('resolveInRootSafe allows not-yet-existing paths inside root', async () => {
  await withRoots(async (root) => {
    const p = await resolveInRootSafe(root, 'new/dir/file.txt');
    assert.equal(p, resolve(root, 'new/dir/file.txt'));
  });
});

test('resolveInRootSafe rejects traversal hidden behind a valid-looking prefix', async () => {
  await withRoots(async (root, outside) => {
    await writeFile(join(outside, 'secret.txt'), 'nope');
    await assert.rejects(
      () => resolveInRootSafe(root, `../../${outside}/secret.txt`.replace(/\\/g, '/')),
      PathEscapeError,
    );
  });
});
