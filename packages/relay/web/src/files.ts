import { rpc } from './conn';
import type { Editor } from './editor';

export type EditorOpts = {
  onSave?: (path: string) => void;
  onError?: (msg: string) => void;
};

// CodeMirror is ~800 kB, so ./editor is a separate lazy chunk. Callers get a
// cheap placeholder shell immediately and the real editor is swapped in once.
let editorModule: Promise<typeof import('./editor')> | null = null;

export async function loadEditor(
  container: HTMLElement,
  opts?: EditorOpts
): Promise<Editor> {
  editorModule ??= import('./editor');
  const { Editor } = await editorModule;
  return new Editor(container, opts);
}

export type FileEntry = {
  name: string;
  kind: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  mtimeMs: number;
};

export type FileListResult = {
  path: string;
  entries: FileEntry[];
};

type OpResult = { ok: boolean; error?: string };

// Join a directory and a name, collapsing the '.' root.
function joinPath(dir: string, name: string): string {
  return dir === '.' ? name : `${dir}/${name}`;
}

export class FileTree {
  private container: HTMLElement;
  private currentPath: string = '.';
  private entries: FileEntry[] = [];
  private loading: boolean = false;
  private onFileClick: (path: string, entry: FileEntry) => void;
  private busy = false;
  private noticeTimer: number | undefined;

  constructor(container: HTMLElement, onFileClick: (path: string, entry: FileEntry) => void) {
    this.container = container;
    this.onFileClick = onFileClick;
    this.render();
    this.loadDirectory('.');
  }

  async loadDirectory(path: string): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.currentPath = path;
    this.showLoading();

    try {
      const res = await rpc<FileListResult & OpResult>({ type: 'fs.list', path });
      if (!res.ok) {
        this.showError(res.error ?? 'Failed to list directory');
        return;
      }
      this.entries = res.entries;
      this.render();
    } catch (e) {
      this.showError((e as Error).message);
    } finally {
      this.loading = false;
    }
  }

  private render(): void {
    this.container.innerHTML = '';

    // Head: breadcrumb + "+ Folder"
    const head = document.createElement('div');
    head.className = 'file-tree-head';
    const pathLabel = document.createElement('span');
    pathLabel.className = 'file-tree-path';
    pathLabel.textContent = this.currentPath === '.' ? '/' : this.currentPath;
    const mkdirBtn = document.createElement('button');
    mkdirBtn.className = 'file-tree-new';
    mkdirBtn.textContent = '+ Folder';
    mkdirBtn.title = 'New folder in the current directory';
    mkdirBtn.addEventListener('click', () => this.beginMkdir(head));
    head.append(pathLabel, mkdirBtn);
    this.container.appendChild(head);

    const ul = document.createElement('ul');
    ul.className = 'file-tree';
    this.container.appendChild(ul);

    // Up-entry ("..") — hidden at the root.
    if (this.currentPath !== '.') {
      const up = document.createElement('li');
      up.textContent = '↩ ..';
      up.className = 'file-tree-up';
      up.addEventListener('click', () => {
        const parts = this.currentPath.split('/');
        parts.pop();
        void this.loadDirectory(parts.length === 0 ? '.' : parts.join('/'));
      });
      ul.appendChild(up);
    }

    if (this.entries.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'Empty directory';
      li.className = 'file-tree-empty';
      ul.appendChild(li);
      return;
    }

    const sorted = [...this.entries].sort((a, b) => {
      const aIsDir = a.kind === 'dir';
      const bIsDir = b.kind === 'dir';
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    for (const entry of sorted) {
      ul.appendChild(this.renderRow(entry));
    }
  }

  private renderRow(entry: FileEntry): HTMLLIElement {
    const li = document.createElement('li');
    li.className = entry.kind === 'dir' ? 'file-tree-row is-dir' : 'file-tree-row';

    const icon = document.createElement('span');
    icon.className = 'file-tree-icon';
    icon.textContent = entry.kind === 'dir' ? '📁' : '📄';
    li.appendChild(icon);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'file-tree-name';
    nameSpan.textContent = entry.name;
    li.appendChild(nameSpan);

    if (entry.kind === 'file') {
      const sizeSpan = document.createElement('span');
      sizeSpan.textContent = this.formatSize(entry.size);
      sizeSpan.className = 'file-tree-size';
      li.appendChild(sizeSpan);
    }

    // Row actions: rename + delete (reveal on hover / always on touch).
    const actions = document.createElement('span');
    actions.className = 'file-tree-actions';
    const renameBtn = document.createElement('button');
    renameBtn.className = 'file-tree-act';
    renameBtn.textContent = '✎';
    renameBtn.title = 'Rename';
    renameBtn.addEventListener('click', (e) => { e.stopPropagation(); this.beginRename(li, entry); });
    const delBtn = document.createElement('button');
    delBtn.className = 'file-tree-act file-tree-act-del';
    delBtn.textContent = '🗑';
    delBtn.title = 'Delete';
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); this.confirmDelete(li, entry); });
    actions.append(renameBtn, delBtn);
    li.appendChild(actions);

    li.addEventListener('click', () => {
      if (entry.kind === 'dir') {
        void this.loadDirectory(joinPath(this.currentPath, entry.name));
      } else {
        this.onFileClick(joinPath(this.currentPath, entry.name), entry);
      }
    });

    return li;
  }

  // ── Inline editing ────────────────────────────────────────────────────

  // Replace a row's name span with an input; commit on Enter, cancel on Esc.
  private inlineInput(li: HTMLLIElement, initial: string, onCommit: (value: string) => void): void {
    const nameSpan = li.querySelector<HTMLElement>('.file-tree-name');
    if (!nameSpan) return;
    const input = document.createElement('input');
    input.className = 'file-tree-input';
    input.value = initial;
    nameSpan.replaceWith(input);
    input.focus();
    input.setSelectionRange(0, initial.length);

    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      if (commit) onCommit(input.value.trim());
      else this.render();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  private beginMkdir(head: HTMLElement): void {
    // One inline form at a time; bail if the tree is mid-operation.
    if (this.busy || head.querySelector('.file-tree-newform')) return;
    const form = document.createElement('div');
    form.className = 'file-tree-newform';
    const input = document.createElement('input');
    input.className = 'file-tree-input';
    input.placeholder = 'Folder name';
    const ok = document.createElement('button');
    ok.className = 'file-tree-act';
    ok.textContent = '✓';
    const cancel = document.createElement('button');
    cancel.className = 'file-tree-act';
    cancel.textContent = '×';
    form.append(input, ok, cancel);
    head.insertAdjacentElement('afterend', form);
    input.focus();

    const submit = async () => {
      const name = input.value.trim();
      if (!name) { this.render(); return; }
      if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
        this.flash(form, 'Invalid folder name', true);
        return;
      }
      await this.runOp(() => rpc<OpResult>({ type: 'fs.mkdir', path: joinPath(this.currentPath, name) }),
        `Created “${name}”`, this.currentPath);
    };
    ok.addEventListener('click', () => void submit());
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') void submit();
      else if (e.key === 'Escape') this.render();
    });
    cancel.addEventListener('click', () => this.render());
  }

  private beginRename(li: HTMLLIElement, entry: FileEntry): void {
    this.inlineInput(li, entry.name, (newName) => {
      if (!newName || newName === entry.name) { this.render(); return; }
      if (newName.includes('/') || newName.includes('\\') || newName === '.' || newName === '..') {
        this.notice('Invalid name', true);
        this.render();
        return;
      }
      const from = joinPath(this.currentPath, entry.name);
      const to = joinPath(this.currentPath, newName);
      void this.runOp(() => rpc<OpResult>({ type: 'fs.rename', from, to }),
        `Renamed to “${newName}”`, this.currentPath);
    });
  }

  // Two-tap confirm in place: the row's actions become "Delete? ✓ ✕".
  private confirmDelete(li: HTMLLIElement, entry: FileEntry): void {
    const actions = li.querySelector<HTMLElement>('.file-tree-actions');
    if (!actions || actions.classList.contains('confirming')) return;
    actions.classList.add('confirming');
    actions.innerHTML = '';
    const label = document.createElement('span');
    label.className = 'file-tree-confirm';
    label.textContent = 'Delete?';
    const yes = document.createElement('button');
    yes.className = 'file-tree-act file-tree-act-del';
    yes.textContent = '✓';
    const no = document.createElement('button');
    no.className = 'file-tree-act';
    no.textContent = '✕';
    yes.addEventListener('click', (e) => {
      e.stopPropagation();
      const path = joinPath(this.currentPath, entry.name);
      const recursive = entry.kind === 'dir';
      void this.runOp(
        () => rpc<OpResult>({ type: 'fs.delete', path, recursive }),
        `Deleted “${entry.name}”${recursive ? ' (folder)' : ''}`,
        this.currentPath);
    });
    no.addEventListener('click', (e) => { e.stopPropagation(); this.render(); });
    actions.append(label, yes, no);
  }

  // ── Operation runner + feedback ───────────────────────────────────────

  // One op at a time; reload `reloadPath` on success so the tree stays current.
  private async runOp(op: () => Promise<OpResult>, okMsg: string, reloadPath: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.container.classList.add('is-busy');
    try {
      const res = await op();
      if (res.ok) {
        // Re-render first, then show the notice — render() wipes container.innerHTML
        // and would otherwise erase the banner the instant it appears.
        await this.loadDirectory(reloadPath);
        this.notice(okMsg, false);
      } else {
        this.render();
        this.notice(res.error ?? 'Operation failed', true);
      }
    } catch (e) {
      this.render();
      this.notice((e as Error).message, true);
    } finally {
      this.busy = false;
      this.container.classList.remove('is-busy');
    }
  }

  // Transient banner under the head — does NOT wipe the tree (unlike showError).
  private notice(msg: string, isError: boolean): void {
    const old = this.container.querySelector('.file-tree-notice');
    old?.remove();
    const el = document.createElement('div');
    el.className = isError ? 'file-tree-notice error' : 'file-tree-notice';
    el.textContent = msg;
    const head = this.container.querySelector('.file-tree-head');
    if (head) head.insertAdjacentElement('afterend', el);
    else this.container.appendChild(el);
    clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => el.remove(), 4000);
  }

  // Show an error inside a transient inline form without tearing it down.
  private flash(el: HTMLElement, msg: string, isError: boolean): void {
    el.classList.toggle('error', isError);
    el.setAttribute('data-msg', msg);
    clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => {
      el.classList.remove('error');
      el.removeAttribute('data-msg');
    }, 4000);
  }

  private showLoading(): void {
    this.container.innerHTML = '<div class="file-tree-note">Loading…</div>';
  }

  private showError(msg: string): void {
    const el = document.createElement('div');
    el.className = 'file-tree-note file-tree-error';
    el.textContent = `Error: ${msg}`;
    this.container.innerHTML = '';
    this.container.appendChild(el);
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  refresh(): void {
    if (this.currentPath) void this.loadDirectory(this.currentPath);
  }
}
