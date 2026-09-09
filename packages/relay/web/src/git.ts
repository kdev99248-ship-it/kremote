import { rpc } from './conn';

// Git view: status sidebar (branch, changed files) + diff/log main pane,
// commit and push. Mirrors the FileTree/Editor structure in files.ts.

export type GitFile = { path: string; index: string; worktree: string };
export type GitCommitInfo = { hash: string; author: string; date: string; subject: string };

const REPO_KEY = 'kremote.repo';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** One-letter status code → word for title/tooltip. */
function statusWord(c: string): string {
  switch (c) {
    case 'M': return 'modified';
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case 'U': return 'unmerged';
    case '?': return 'untracked';
    default: return 'changed';
  }
}

export class GitPanel {
  private container: HTMLElement;
  private repo: string = '.';
  private status: { branch: string; ahead: number; behind: number; files: GitFile[] } | null = null;
  private selected: string | null = null;   // selected file path (null → log view)
  private staged: boolean = false;           // diff mode for the selected file
  private loading: boolean = false;
  private onError?: (msg: string) => void;

  constructor(container: HTMLElement, opts?: { onError?: (msg: string) => void }) {
    this.container = container;
    this.onError = opts?.onError;
    const saved = localStorage.getItem(REPO_KEY);
    if (saved) this.repo = saved;
    this.render();
  }

  refresh(): void {
    if (this.loading) return;
    this.loading = true;
    this.render();
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const [st, log] = await Promise.all([
        rpc<{ ok: boolean; error?: string; branch: string; ahead: number; behind: number; files: GitFile[] }>({
          type: 'git.status', repo: this.repo,
        }),
        rpc<{ ok: boolean; error?: string; commits: GitCommitInfo[] }>({
          type: 'git.log', repo: this.repo, limit: 30,
        }, 30000),
      ]);
      if (!st.ok) {
        this.showError(st.error ?? 'git status failed');
        return;
      }
      this.status = { branch: st.branch, ahead: st.ahead, behind: st.behind, files: st.files };
      // Drop selection if the file no longer has changes.
      if (this.selected && !st.files.some(f => f.path === this.selected)) this.selected = null;
      this.commits = log.ok ? log.commits : [];
      this.error = null;
      this.render();
      // Refresh the visible diff (file set may have changed under it).
      if (this.selected) void this.loadDiff(this.selected);
      else void this.loadLog();
    } catch (e) {
      this.showError((e as Error).message);
    } finally {
      this.loading = false;
    }
  }

  private commits: GitCommitInfo[] = [];
  private diffText: string | null = null;
  private diffStaged: boolean = false; // whether diffText is a staged diff
  private error: string | null = null;

  private showError(msg: string): void {
    this.loading = false;
    this.error = msg;
    this.render();
    this.onError?.(msg);
  }

  private async loadDiff(path: string, staged = this.staged): Promise<void> {
    try {
      const res = await rpc<{ ok: boolean; diff: string; error?: string }>({
        type: 'git.diff', repo: this.repo, path, staged,
      }, 30000);
      if (!res.ok) { this.showError(res.error ?? 'git diff failed'); return; }
      // Ignore stale responses after the selection changed.
      if (this.selected !== path || this.staged !== staged) return;
      this.diffText = res.diff;
      this.diffStaged = staged;
      this.error = null;
      this.renderDiff();
    } catch (e) {
      this.showError((e as Error).message);
    }
  }

  private async loadLog(): Promise<void> {
    // Log is already in this.commits from load(); just paint it.
    this.renderDiff();
  }

  private async commit(message: string, all: boolean): Promise<void> {
    if (!message.trim()) return;
    try {
      const res = await rpc<{ ok: boolean; error?: string }>({
        type: 'git.commit', repo: this.repo, message, all,
      }, 60000);
      if (!res.ok) { this.showError(res.error ?? 'git commit failed'); return; }
      this.error = null;
      this.refresh();
    } catch (e) {
      this.showError((e as Error).message);
    }
  }

  private async push(): Promise<void> {
    try {
      const res = await rpc<{ ok: boolean; error?: string }>({
        type: 'git.push', repo: this.repo,
      }, 120000);
      if (!res.ok) { this.showError(res.error ?? 'git push failed'); return; }
      this.error = null;
      this.refresh();
    } catch (e) {
      this.showError((e as Error).message);
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  private render(): void {
    const st = this.status;
    this.container.innerHTML = '';
    this.container.className = 'git-panel';

    // Repo path row
    const repoRow = document.createElement('div');
    repoRow.className = 'git-repo-row';
    const repoInput = document.createElement('input');
    repoInput.className = 'git-repo-input';
    repoInput.value = this.repo;
    repoInput.placeholder = 'repo path (relative to agent root)';
    repoInput.addEventListener('change', () => {
      this.repo = repoInput.value.trim() || '.';
      localStorage.setItem(REPO_KEY, this.repo);
      this.status = null;
      this.selected = null;
      this.refresh();
    });
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'git-btn';
    refreshBtn.textContent = '↻';
    refreshBtn.title = 'Refresh';
    refreshBtn.addEventListener('click', () => { this.selected = this.selected; this.refresh(); });
    repoRow.append(repoInput, refreshBtn);
    this.container.appendChild(repoRow);

    if (this.loading && !st) {
      const p = document.createElement('p');
      p.className = 'git-note';
      p.textContent = 'Loading…';
      this.container.appendChild(p);
      return;
    }
    if (this.error && !st) {
      const p = document.createElement('p');
      p.className = 'git-note git-error';
      p.textContent = this.error;
      this.container.appendChild(p);
      return;
    }
    if (!st) return;

    // Branch header + actions
    const head = document.createElement('div');
    head.className = 'git-head';
    const branch = document.createElement('span');
    branch.className = 'git-branch';
    branch.textContent = `⎇ ${st.branch}`;
    const sync = document.createElement('span');
    sync.className = 'git-sync';
    if (st.ahead || st.behind) {
      sync.textContent = `${st.ahead ? `↑${st.ahead}` : ''}${st.behind ? `↓${st.behind}` : ''}`;
      sync.title = `${st.ahead} ahead, ${st.behind} behind`;
    } else {
      sync.textContent = '✓';
      sync.title = 'in sync with upstream';
      sync.classList.add('in-sync');
    }
    const actions = document.createElement('div');
    actions.className = 'git-actions';
    const pushBtn = document.createElement('button');
    pushBtn.className = 'git-btn git-push';
    pushBtn.textContent = 'Push';
    pushBtn.disabled = !st.ahead && !st.behind && !st.files.some(f => f.index !== '?');
    pushBtn.addEventListener('click', () => { pushBtn.disabled = true; pushBtn.textContent = '…'; void this.push(); });
    actions.appendChild(pushBtn);
    head.append(branch, sync, actions);
    this.container.appendChild(head);

    // Changed files list
    const list = document.createElement('ul');
    list.className = 'git-files';
    if (st.files.length === 0) {
      const li = document.createElement('li');
      li.className = 'git-note';
      li.textContent = 'Working tree clean';
      list.appendChild(li);
    }
    for (const f of st.files) {
      const li = document.createElement('li');
      li.className = 'git-file' + (f.path === this.selected ? ' selected' : '');
      const code = document.createElement('span');
      code.className = `git-code code-${esc(f.index === '?' ? '?' : (f.index !== ' ' ? f.index : f.worktree))}`;
      code.textContent = f.index === ' ' ? f.worktree : (f.worktree === ' ' ? f.index : `${f.index}${f.worktree}`);
      code.title = `${statusWord(f.index === '?' ? '?' : f.index)}${f.worktree !== ' ' && f.index !== '?' ? ' / ' + statusWord(f.worktree) : ''}`;
      const name = document.createElement('span');
      name.className = 'git-path';
      name.textContent = f.path;
      li.append(code, name);
      li.addEventListener('click', () => {
        this.selected = f.path;
        this.staged = false;
        this.diffText = null;
        this.render();
        void this.loadDiff(f.path);
      });
      list.appendChild(li);
    }
    this.container.appendChild(list);

    // Commit box
    const commitBox = document.createElement('div');
    commitBox.className = 'git-commit';
    const msg = document.createElement('textarea');
    msg.className = 'git-msg';
    msg.rows = 2;
    msg.placeholder = 'Commit message…';
    const commitRow = document.createElement('div');
    commitRow.className = 'git-commit-row';
    const allLabel = document.createElement('label');
    allLabel.className = 'git-all-label';
    const all = document.createElement('input');
    all.type = 'checkbox';
    all.id = 'git-commit-all';
    allLabel.append(all, document.createTextNode(' all (incl. untracked)'));
    const commitBtn = document.createElement('button');
    commitBtn.className = 'git-btn git-commit-btn';
    commitBtn.textContent = 'Commit';
    commitBtn.addEventListener('click', () => {
      if (!msg.value.trim()) { msg.focus(); return; }
      commitBtn.disabled = true; commitBtn.textContent = '…';
      void this.commit(msg.value, all.checked);
    });
    msg.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        if (msg.value.trim()) { commitBtn.disabled = true; commitBtn.textContent = '…'; void this.commit(msg.value, all.checked); }
      }
    });
    commitRow.append(allLabel, commitBtn);
    commitBox.append(msg, commitRow);
    this.container.appendChild(commitBox);

    // Diff / log pane
    const pane = document.createElement('div');
    pane.className = 'git-pane';
    this.container.appendChild(pane);
    if (this.selected) {
      this.renderDiffInto(pane);
    } else {
      this.renderLogInto(pane);
    }
  }

  private renderDiffInto(pane: HTMLElement): void {
    const bar = document.createElement('div');
    bar.className = 'git-diff-bar';
    const pathSpan = document.createElement('span');
    pathSpan.className = 'git-diff-path';
    pathSpan.textContent = this.selected ?? '';
    const stagedBtn = document.createElement('button');
    stagedBtn.className = 'git-btn git-toggle' + (this.staged ? ' active' : '');
    stagedBtn.textContent = 'staged';
    stagedBtn.title = 'Show staged diff (--staged)';
    stagedBtn.addEventListener('click', () => {
      this.staged = !this.staged;
      this.diffText = null;
      this.render();
      if (this.selected) void this.loadDiff(this.selected);
    });
    const closeBtn = document.createElement('button');
    closeBtn.className = 'git-btn';
    closeBtn.textContent = '×';
    closeBtn.title = 'Close diff (back to log)';
    closeBtn.addEventListener('click', () => {
      this.selected = null;
      this.diffText = null;
      this.render();
    });
    bar.append(pathSpan, stagedBtn, closeBtn);
    pane.appendChild(bar);

    const pre = document.createElement('pre');
    pre.className = 'git-diff';
    if (this.diffText == null) {
      pre.textContent = 'Loading…';
    } else if (this.diffText === '') {
      pre.className += ' git-diff-empty';
      pre.textContent = this.diffStaged
        ? 'No staged changes for this file'
        : 'No unstaged changes for this file';
    } else {
      pre.innerHTML = colorizeDiff(this.diffText);
    }
    pane.appendChild(pre);
  }

  private renderLogInto(pane: HTMLElement): void {
    const pre = document.createElement('pre');
    pre.className = 'git-log';
    if (this.commits.length === 0) {
      pre.textContent = 'No commits';
    } else {
      for (const c of this.commits) {
        const line = document.createElement('div');
        line.className = 'git-log-entry';
        const h = document.createElement('span');
        h.className = 'git-hash';
        h.textContent = c.hash.slice(0, 8);
        const s = document.createElement('span');
        s.className = 'git-subject';
        s.textContent = c.subject;
        const a = document.createElement('span');
        a.className = 'git-author';
        a.textContent = `${c.author}`;
        line.append(h, s, a);
        line.title = `${c.hash}\n${c.author} · ${c.date}`;
        pane.appendChild(line);
      }
    }
    pane.appendChild(pre);
  }

  private renderDiff(): void {
    // Re-render just the pane, preserving sidebar state.
    const pane = this.container.querySelector<HTMLElement>('.git-pane');
    if (!pane) { this.render(); return; }
    pane.innerHTML = '';
    if (this.selected) this.renderDiffInto(pane);
    else this.renderLogInto(pane);
  }
}

/** Escape + colorize a unified diff for <pre> innerHTML. */
function colorizeDiff(diff: string): string {
  return diff.split('\n').map((line) => {
    const e = esc(line);
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
      return `<span class="d-file">${e}</span>`;
    }
    if (line.startsWith('@@')) return `<span class="d-hunk">${e}</span>`;
    if (line.startsWith('+')) return `<span class="d-add">${e}</span>`;
    if (line.startsWith('-')) return `<span class="d-del">${e}</span>`;
    return e;
  }).join('\n');
}
