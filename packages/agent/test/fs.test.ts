import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat, symlink, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsHandlers, FsError, looksBinary } from '../src/fs.ts';
import { PathEscapeError } from '../src/pathguard.ts';

async function withTempRoot(
  fn: (root: string, fs: FsHandlers) => Promise<void>
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'kremote-fs-test-'));
  const root = join(base, 'root');
  await mkdir(root, { recursive: true });
  const handlers = new FsHandlers(root);
  try {
    await fn(root, handlers);
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

test('looksBinary detects NUL and C0 controls', () => {
  assert.ok(looksBinary(Buffer.from('hello\0world')));
  assert.ok(looksBinary(Buffer.from('hello\x01world')));
  assert.ok(looksBinary(Buffer.from('\x00')));
  assert.ok(!looksBinary(Buffer.from('hello\nworld')));
  assert.ok(!looksBinary(Buffer.from('hello\r\nworld')));
  assert.ok(!looksBinary(Buffer.from('hello\tworld')));
  assert.ok(!looksBinary(Buffer.from('plain text')));
});

test('fs.list returns directory contents sorted dirs first, case-insensitive', async () => {
  await withTempRoot(async (root, fs) => {
    await mkdir(join(root, 'b_dir'), { recursive: true });
    await mkdir(join(root, 'a_dir'), { recursive: true });
    await writeFile(join(root, 'Z_file.txt'), 'z');
    await writeFile(join(root, 'A_file.txt'), 'a');

    const result = await fs.list('.');
    assert.equal(result.path, '.');
    const names = result.entries.map(e => e.name);
    // Dirs first, then files; alphabetical case-insensitive
    assert.deepEqual(names, ['a_dir', 'b_dir', 'A_file.txt', 'Z_file.txt']);
    assert.equal(result.entries[0].kind, 'dir');
    assert.equal(result.entries[2].kind, 'file');
  });
});

test('fs.list rejects path traversal', async () => {
  await withTempRoot(async (root, fs) => {
    await assert.rejects(() => fs.list('../outside'), (err: unknown) =>
      err instanceof FsError && err.code === 'forbidden');
    await assert.rejects(() => fs.list('a/../../outside'), (err: unknown) =>
      err instanceof FsError && err.code === 'forbidden');
  });
});

test('fs.read reads a text file and rejects binary', async () => {
  await withTempRoot(async (root, fs) => {
    const file = join(root, 'hello.txt');
    await writeFile(file, 'Hello, world!', 'utf8');
    const result = await fs.read('hello.txt');
    assert.equal(result.content, 'Hello, world!');
    assert.equal(result.path, 'hello.txt');
    assert.ok(result.mtimeMs > 0);
    assert.equal(result.size, 13);
    assert.equal(result.truncated, false);

    await writeFile(join(root, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02]));
    await assert.rejects(() => fs.read('binary.bin'), (err: unknown) => {
      return err instanceof FsError && err.message.includes('binary file not supported');
    });
  });
});

test('fs.read rejects large files (MAX_READ_BYTES)', async () => {
  await withTempRoot(async (root, fs) => {
    const large = Buffer.alloc(11 * 1024 * 1024, 'a');
    await writeFile(join(root, 'large.txt'), large);
    await assert.rejects(() => fs.read('large.txt'), (err: unknown) => {
      return err instanceof FsError && err.message.includes('file too large');
    });
  });
});

test('fs.write creates file with content, rejects over MAX_WRITE_BYTES', async () => {
  await withTempRoot(async (root, fs) => {
    const content = 'Hello, fs.write!';
    const result = await fs.write('new.txt', content);
    assert.equal(result.path, 'new.txt');
    assert.ok(result.mtimeMs > 0);
    const actual = await readFile(join(root, 'new.txt'), 'utf8');
    assert.equal(actual, content);

    const huge = 'x'.repeat(101 * 1024);
    await assert.rejects(() => fs.write('huge.txt', huge), (err: unknown) => {
      return err instanceof FsError && err.message.includes('write too large');
    });
  });
});

test('fs.write enforces mtime conflict check', async () => {
  await withTempRoot(async (root, fs) => {
    const file = 'conflict.txt';
    await writeFile(join(root, file), 'v1', 'utf8');
    const st = await stat(join(root, file));
    const baseMtime = st.mtimeMs;

    // Same mtime: allowed
    const r = await fs.write(file, 'v2', baseMtime);
    assert.ok(r.mtimeMs > 0);

    // File changed on disk after the client read it. Bump mtime explicitly:
    // two writes inside the same NTFS/FAT timestamp tick can share an mtime,
    // and the guard only rejects when |mtime - base| > 2ms.
    await writeFile(join(root, file), 'v3', 'utf8');
    const later = new Date(st.mtimeMs + 1000);
    await utimes(join(root, file), later, later);
    await assert.rejects(
      () => fs.write(file, 'v4', baseMtime),
      (err: unknown) => {
        return err instanceof FsError && err.conflict === true && err.message.includes('changed');
      }
    );
  });
});

test('fs.write treats vanished file as conflict if baseMtime provided', async () => {
  await withTempRoot(async (root, fs) => {
    const file = 'vanished.txt';
    await writeFile(join(root, file), 'v1', 'utf8');
    const st = await stat(join(root, file));
    await rm(join(root, file));

    await assert.rejects(
      () => fs.write(file, 'v2', st.mtimeMs),
      (err: unknown) => err instanceof FsError && err.conflict === true && err.message.includes('no longer exists')
    );
  });
});

test('fs.mkdir creates directories recursively', async () => {
  await withTempRoot(async (root, fs) => {
    await fs.mkdir('a/b/c');
    const st = await stat(join(root, 'a/b/c'));
    assert.ok(st.isDirectory());
  });
});

test('fs.rename moves files inside root', async () => {
  await withTempRoot(async (root, fs) => {
    await writeFile(join(root, 'from.txt'), 'hello', 'utf8');
    await fs.rename('from.txt', 'to.txt');
    const content = await readFile(join(root, 'to.txt'), 'utf8');
    assert.equal(content, 'hello');
    await assert.rejects(() => stat(join(root, 'from.txt')));
  });
});

test('fs.rename rejects escape', async () => {
  await withTempRoot(async (root, fs) => {
    await writeFile(join(root, 'file.txt'), 'x', 'utf8');
    await assert.rejects(() => fs.rename('file.txt', '../outside'), (err: unknown) =>
      err instanceof FsError && err.code === 'forbidden');
  });
});

test('fs.delete removes file; requires recursive for dir', async () => {
  await withTempRoot(async (root, fs) => {
    await writeFile(join(root, 'del.txt'), 'x', 'utf8');
    await fs.delete('del.txt');
    await assert.rejects(() => stat(join(root, 'del.txt')));

    await mkdir(join(root, 'dir'), { recursive: true });
    await assert.rejects(() => fs.delete('dir'));
    await fs.delete('dir', true);
    await assert.rejects(() => stat(join(root, 'dir')));
  });
});

test('fs handlers reject symlink escape', async () => {
  await withTempRoot(async (root, fs) => {
    const outside = join(root, '..', 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'secret');

    try {
      await symlink(outside, join(root, 'link'), 'junction');
    } catch {
      await symlink(outside, join(root, 'link'), 'dir');
    }

    const forbidden = (err: unknown) => err instanceof FsError && err.code === 'forbidden';
    await assert.rejects(() => fs.list('link'), forbidden);
    await assert.rejects(() => fs.read('link/secret.txt'), forbidden);
    await assert.rejects(() => fs.write('link/secret.txt', 'x'), forbidden);
  });
});
