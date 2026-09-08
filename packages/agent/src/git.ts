import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { MAX_GIT_LOG, MAX_GIT_DIFF_BYTES } from '@kremote/shared';
import type { FsHandlers } from './fs.ts';

// Git runner: runs git commands inside a repository directory,
// with path resolution through FsHandlers to enforce root boundaries.

export interface GitStatusResult {
  branch: string;
  ahead: number;
  behind: number;
  files: { path: string; index: string; worktree: string }[];
}

export interface GitCommit {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

export class GitError extends Error {
  readonly code: string;
  constructor(message: string, code = 'error') {
    super(message);
    this.name = 'GitError';
    this.code = code;
  }
}

export class GitRunner {
  private readonly fs: FsHandlers;
  constructor(fs: FsHandlers) {
    this.fs = fs;
  }

  /**
   * Resolve a repo path (relative to root) to an absolute path, ensuring it's
   * inside root (via FsHandlers.resolve). Also checks that it's a git repo.
   */
  private async resolveRepo(repo: string): Promise<string> {
    const abs = await this.fs.resolve(repo);
    // Quick check: see if .git exists (file or dir)
    try {
      const stat = await import('node:fs/promises').then(m => m.stat(abs + '/.git'));
      if (!stat.isDirectory() && !stat.isFile()) {
        throw new GitError('not a git repository', 'ENOTGIT');
      }
    } catch (e: any) {
      if (e.code === 'ENOENT') throw new GitError('not a git repository', 'ENOTGIT');
      throw e;
    }
    return abs;
  }

  /**
   * Run a git command in the repo directory, capturing stdout/stderr.
   * Throws GitError if exit code != 0.
   */
  private async runGit(repoAbs: string, args: string[], options: { timeout?: number; maxBuffer?: number } = {}): Promise<{ stdout: string; stderr: string }> {
    const { timeout = 30000, maxBuffer = 10 * 1024 * 1024 } = options;
    return new Promise((resolve, reject) => {
      const proc = spawn('git', args, {
        cwd: repoAbs,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); if (stdout.length > maxBuffer) proc.kill('SIGKILL'); });
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); if (stderr.length > maxBuffer) proc.kill('SIGKILL'); });
      proc.on('close', (code, signal) => {
        if (code !== 0) {
          const err = new GitError(`git ${args[0]} failed: ${stderr || stdout || 'unknown error'}`, 'GIT_ERROR');
          (err as any).code = code;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      });
      proc.on('error', (err) => reject(new GitError(`spawn git: ${err.message}`, 'GIT_SPAWN')));
    });
  }

  async status(repo: string): Promise<GitStatusResult> {
    const abs = await this.resolveRepo(repo);
    const { stdout } = await this.runGit(abs, ['status', '--porcelain=v2', '-b'], { maxBuffer: 5 * 1024 * 1024 });
    return this.parseStatus(stdout);
  }

  private parseStatus(output: string): GitStatusResult {
    const lines = output.split('\n');
    let branch = '';
    let ahead = 0;
    let behind = 0;
    const files: { path: string; index: string; worktree: string }[] = [];

    for (const line of lines) {
      if (line.startsWith('# branch.head ')) {
        const parts = line.split(' ');
        branch = parts.slice(2).join(' ');
      } else if (line.startsWith('# branch.ab ')) {
        const parts = line.split(' ');
        const aheadStr = parts[2]?.replace('+', '') || '0';
        const behindStr = parts[3]?.replace('-', '') || '0';
        ahead = parseInt(aheadStr) || 0;
        behind = parseInt(behindStr) || 0;
      } else if (line.match(/^[1-2] /)) {
        // porcelain v2: <flag> <score> <index> <worktree> <path>
        const parts = line.split(' ');
        // format: "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>"
        // simplified: we just need status codes and path
        const indexStatus = parts[1]?.charAt(0) ?? ' ';
        const worktreeStatus = parts[1]?.charAt(1) ?? ' ';
        const path = parts.slice(parts.length - 1)[0] || '';
        files.push({ path, index: indexStatus, worktree: worktreeStatus });
      }
    }

    return { branch, ahead, behind, files };
  }

  async diff(repo: string, opts: { staged?: boolean; path?: string } = {}): Promise<string> {
    const abs = await this.resolveRepo(repo);
    const args = ['diff'];
    if (opts.staged) args.push('--staged');
    if (opts.path) args.push('--', opts.path);
    // Limit diff size to avoid huge responses.
    const { stdout } = await this.runGit(abs, args, { maxBuffer: MAX_GIT_DIFF_BYTES });
    return stdout;
  }

  async commit(repo: string, message: string, all = false): Promise<void> {
    const abs = await this.resolveRepo(repo);
    const args = ['commit', '-m', message];
    if (all) args.push('--all');
    await this.runGit(abs, args);
  }

  async push(repo: string): Promise<void> {
    const abs = await this.resolveRepo(repo);
    await this.runGit(abs, ['push'], { timeout: 120000 });
  }

  async log(repo: string, limit = 20): Promise<GitCommit[]> {
    const abs = await this.resolveRepo(repo);
    const effectiveLimit = Math.min(limit, MAX_GIT_LOG);
    const { stdout } = await this.runGit(abs, ['log', `--max-count=${effectiveLimit}`, '--pretty=format:%H|%an|%ai|%s']);
    const commits: GitCommit[] = [];
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const [hash, author, date, ...subjectParts] = line.split('|');
      const subject = subjectParts.join('|') || '';
      commits.push({ hash, author, date, subject });
    }
    return commits;
  }
}