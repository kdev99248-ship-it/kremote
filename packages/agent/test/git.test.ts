import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { FsHandlers } from '../src/fs.ts';
import { GitRunner, GitError } from '../src/git.ts';

// Tests spawn real `git` — skip when unavailable (CI without git installed).
let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      // Deterministic author/committer for assertions.
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test Committer',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

async function withTempRepo(
  fn: (root: string, fs: FsHandlers, gitRunner: GitRunner) => Promise<void>
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'kremote-git-test-'));
  const root = join(base, 'root');
  await mkdir(root, { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Test Author');
  git(root, 'config', 'user.email', 'test@example.com');
  const fs = new FsHandlers(root);
  const runner = new GitRunner(fs);
  try {
    await fn(root, fs, runner);
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function withTempRoot(
  fn: (root: string, fs: FsHandlers, runner: GitRunner) => Promise<void>
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'kremote-git-test-'));
  const root = join(base, 'root');
  await mkdir(root, { recursive: true });
  const fs = new FsHandlers(root);
  const runner = new GitRunner(fs);
  return fn(root, fs, runner);
}

(async () => {
  if (!gitAvailable) {
    console.log('git not found on PATH — skipping git runner tests');
    return;
  }

  test('git.status reports branch, ahead/behind and changed files', async () => {
    await withTempRepo(async (root, _fs, runner) => {
      await writeFile(join(root, 'a.txt'), 'one', 'utf8');
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'first');

      // Clean tree: no files, 0 ahead.
      let st = await runner.status('.');
      assert.equal(st.branch, 'main');
      assert.equal(st.ahead, 0);
      assert.equal(st.behind, 0);
      assert.deepEqual(st.files, []);

      // Staged + unstaged + untracked changes.
      await writeFile(join(root, 'a.txt'), 'two', 'utf8');
      await writeFile(join(root, 'b.txt'), 'staged', 'utf8');
      git(root, 'add', 'b.txt');
      await writeFile(join(root, 'c.txt'), 'untracked', 'utf8');

      st = await runner.status('.');
      assert.equal(st.branch, 'main');
      const byPath = new Map(st.files.map(f => [f.path, f]));
      assert.equal(byPath.get('a.txt')?.worktree, 'M'); // modified, unstaged
      assert.equal(byPath.get('b.txt')?.index, 'A'); // staged add
      assert.equal(byPath.get('c.txt')?.worktree, '?'); // untracked
    });
  });

  test('git.status rejects a non-repo directory', async () => {
    await withTempRoot(async (root, fs, runner) => {
      await mkdir(join(root, 'plain'), { recursive: true });
      await assert.rejects(
        () => runner.status('plain'),
        (err: unknown) => err instanceof GitError && err.code === 'ENOTGIT'
      );
    });
  });

  test('git.status rejects path outside root', async () => {
    await withTempRepo(async (root, _fs, runner) => {
      const outside = join(root, '..', 'outside-repo');
      await mkdir(outside, { recursive: true });
      git(outside, 'init', '-b', 'main');
      try {
        await assert.rejects(
          () => runner.status('../outside-repo'),
          // FsHandlers resolve guard fires before the .git check
          (err: unknown) => err instanceof Error
        );
      } finally {
        await rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    });
  });

  test('git.diff returns unstaged diff, staged diff and filters by path', async () => {
    await withTempRepo(async (root, _fs, runner) => {
      await writeFile(join(root, 'a.txt'), 'one\n', 'utf8');
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'first');

      // Unstaged change to a.txt; staged change to b.txt.
      await appendFile(join(root, 'a.txt'), 'two\n', 'utf8');
      await writeFile(join(root, 'b.txt'), 'new file\n', 'utf8');
      git(root, 'add', 'b.txt');

      const unstaged = await runner.diff('.');
      assert.ok(unstaged.includes('diff --git a/a.txt b/a.txt'));
      assert.ok(!unstaged.includes('b.txt'));

      const staged = await runner.diff('.', { staged: true });
      assert.ok(staged.includes('diff --git a/b.txt b/b.txt'));
      assert.ok(!staged.includes('a/a.txt'));

      const byPath = await runner.diff('.', { path: 'a.txt' });
      assert.ok(byPath.includes('a/a.txt'));
      assert.ok(!byPath.includes('b/b.txt'));

      // No changes for untouched path → empty diff.
      const empty = await runner.diff('.', { path: 'missing.txt' });
      assert.equal(empty, '');
    });
  });

  test('git.commit commits staged changes and --all commits everything', async () => {
    await withTempRepo(async (root, _fs, runner) => {
      await writeFile(join(root, 'a.txt'), 'one', 'utf8');
      await writeFile(join(root, 'b.txt'), 'two', 'utf8');
      git(root, 'add', 'a.txt');

      // Without --all: only staged a.txt is committed (b.txt stays untracked —
      // plain `git commit -m` never touches untracked files).
      await runner.commit('.', 'commit staged only');
      let st = await runner.status('.');
      assert.deepEqual(
        st.files.map(f => f.path).sort(),
        ['b.txt']
      );
      let log = await runner.log('.', 1);
      assert.equal(log.length, 1);
      assert.equal(log[0].subject, 'commit staged only');

      // With --all: b.txt gets added and committed too.
      await runner.commit('.', 'commit all', true);
      st = await runner.status('.');
      assert.deepEqual(st.files, []);
      log = await runner.log('.', 2);
      assert.equal(log[0].subject, 'commit all');

      // Empty commit (nothing to commit) → git exits 1 → GitError.
      await assert.rejects(
        () => runner.commit('.', 'nothing to commit'),
        (err: unknown) => err instanceof GitError && err.code === 'GIT_ERROR'
      );
    });
  });

  test('git.log returns newest-first commits capped by limit', async () => {
    await withTempRepo(async (root, _fs, runner) => {
      await writeFile(join(root, 'a.txt'), '1', 'utf8');
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'first');

      await writeFile(join(root, 'a.txt'), '2', 'utf8');
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'second: with | pipe');

      await writeFile(join(root, 'a.txt'), '3', 'utf8');
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'third');

      let commits = await runner.log('.', 2);
      assert.equal(commits.length, 2);
      assert.equal(commits[0].subject, 'third');
      assert.equal(commits[1].subject, 'second: with | pipe');
      for (const c of commits) {
        assert.match(c.hash, /^[0-9a-f]{40}$/);
        assert.equal(c.author, 'Test Author');
        assert.ok(c.date.length > 0);
      }

      // Default limit (20) returns all 3.
      commits = await runner.log('.');
      assert.equal(commits.length, 3);

      // Limit is clamped to MAX_GIT_LOG — a huge limit must not throw.
      commits = await runner.log('.', 100000);
      assert.equal(commits.length, 3);
    });
  });

  test('git.log rejects empty repo (no commits)', async () => {
    await withTempRepo(async (_root, _fs, runner) => {
      await assert.rejects(
        () => runner.log('.'),
        (err: unknown) => err instanceof GitError && err.code === 'GIT_ERROR'
      );
    });
  });

  test('git.commit rejects empty message (git refuses)', async () => {
    await withTempRepo(async (root, _fs, runner) => {
      await writeFile(join(root, 'a.txt'), 'x', 'utf8');
      git(root, 'add', '.');
      await assert.rejects(
        () => runner.commit('.', ''),
        (err: unknown) => err instanceof GitError
      );
    });
  });

  test('git.push classifies auth failure as EAUTH (bad token, no prompt hang)', async () => {
    await withTempRepo(async (root, fs) => {
      // Commit something, then point origin at an https URL that will 401.
      await writeFile(join(root, 'a.txt'), 'x', 'utf8');
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'first');
      git(root, 'remote', 'add', 'origin', 'https://127.0.0.1:1/nonexistent/repo.git');
      git(root, 'config', 'branch.main.remote', 'origin');
      git(root, 'config', 'branch.main.merge', 'refs/heads/main');
      // Runner WITH a bogus token: helper supplies creds, so git won't prompt;
      // the connection/auth fails fast and must surface as EAUTH.
      const runner = new GitRunner(fs, { token: 'bogus-token' });
      await assert.rejects(
        () => runner.push('.'),
        (err: unknown) => err instanceof GitError && err.code === 'EAUTH',
      );
    });
  });

  test('git.push without credentials fails fast (no interactive hang)', async () => {
    await withTempRepo(async (root, _fs, runner) => {
      await writeFile(join(root, 'a.txt'), 'x', 'utf8');
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'first');
      git(root, 'remote', 'add', 'origin', 'https://127.0.0.1:1/nonexistent/repo.git');
      git(root, 'config', 'branch.main.remote', 'origin');
      git(root, 'config', 'branch.main.merge', 'refs/heads/main');
      // No creds configured: GIT_TERMINAL_PROMPT=0 must make it error, not block.
      await assert.rejects(
        () => runner.push('.'),
        (err: unknown) => err instanceof GitError,
      );
    });
  });
})();

