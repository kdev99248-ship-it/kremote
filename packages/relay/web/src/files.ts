import { basicSetup } from 'codemirror';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { rpc } from './conn';

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

export class FileTree {
  private container: HTMLElement;
  private currentPath: string = '.';
  private entries: FileEntry[] = [];
  private loading: boolean = false;
  private onFileClick: (path: string, entry: FileEntry) => void;

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
      const res = await rpc<FileListResult & { ok: boolean; error?: string }>({
        type: 'fs.list',
        path,
      });
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
    const ul = document.createElement('ul');
    ul.className = 'file-tree';
    ul.style.listStyle = 'none';
    ul.style.padding = '0';
    ul.style.margin = '0';
    ul.style.overflowY = 'auto';
    ul.style.flex = '1';

    // Breadcrumb / current path
    const pathLabel = document.createElement('div');
    pathLabel.className = 'file-tree-path';
    pathLabel.textContent = this.currentPath === '.' ? '/' : this.currentPath;
    pathLabel.style.padding = '6px 8px';
    pathLabel.style.fontSize = '12px';
    pathLabel.style.color = '#8b95a1';
    pathLabel.style.borderBottom = '1px solid #2a323c';
    this.container.appendChild(pathLabel);
    this.container.appendChild(ul);

    // Up-entry ("..") — hidden at the root.
    if (this.currentPath !== '.') {
      const up = document.createElement('li');
      up.textContent = '↩ ..';
      up.style.padding = '4px 8px';
      up.style.cursor = 'pointer';
      up.style.fontSize = '13px';
      up.style.color = '#8b95a1';
      up.addEventListener('click', () => {
        const parts = this.currentPath.split('/');
        parts.pop();
        void this.loadDirectory(parts.length === 0 ? '.' : parts.join('/'));
      });
      up.addEventListener('mouseenter', () => { up.style.backgroundColor = '#252f3a'; });
      up.addEventListener('mouseleave', () => { up.style.backgroundColor = 'transparent'; });
      ul.appendChild(up);
    }

    if (this.entries.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'Empty directory';
      li.style.padding = '8px 12px';
      li.style.color = '#8b95a1';
      li.style.fontStyle = 'italic';
      ul.appendChild(li);
      return;
    }

    // Sort: dirs first, then files
    const sorted = [...this.entries].sort((a, b) => {
      const aIsDir = a.kind === 'dir';
      const bIsDir = b.kind === 'dir';
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    for (const entry of sorted) {
      const li = document.createElement('li');
      li.style.display = 'flex';
      li.style.alignItems = 'center';
      li.style.padding = '4px 8px';
      li.style.cursor = entry.kind === 'dir' ? 'pointer' : 'pointer';
      li.style.borderRadius = '4px';
      li.style.gap = '6px';
      li.style.fontSize = '13px';

      const icon = document.createElement('span');
      icon.textContent = entry.kind === 'dir' ? '📁' : '📄';
      icon.style.flex = 'none';
      li.appendChild(icon);

      const nameSpan = document.createElement('span');
      nameSpan.textContent = entry.name;
      nameSpan.style.flex = '1';
      nameSpan.style.overflow = 'hidden';
      nameSpan.style.textOverflow = 'ellipsis';
      nameSpan.style.whiteSpace = 'nowrap';
      li.appendChild(nameSpan);

      if (entry.kind === 'file') {
        const sizeSpan = document.createElement('span');
        sizeSpan.textContent = this.formatSize(entry.size);
        sizeSpan.style.fontSize = '11px';
        sizeSpan.style.color = '#8b95a1';
        sizeSpan.style.flex = 'none';
        li.appendChild(sizeSpan);
      }

      li.addEventListener('click', () => {
        if (entry.kind === 'dir') {
          const path = this.currentPath === '.' ? entry.name : `${this.currentPath}/${entry.name}`;
          void this.loadDirectory(path);
        } else {
          const path = this.currentPath === '.' ? entry.name : `${this.currentPath}/${entry.name}`;
          this.onFileClick(path, entry);
        }
      });

      li.addEventListener('mouseenter', () => {
        li.style.backgroundColor = '#252f3a';
      });
      li.addEventListener('mouseleave', () => {
        li.style.backgroundColor = 'transparent';
      });

      ul.appendChild(li);
    }
  }

  private showLoading(): void {
    this.container.innerHTML = '<div style="padding:20px;text-align:center;color:#8b95a1;">Loading...</div>';
  }

  private showError(msg: string): void {
    this.container.innerHTML = `<div style="padding:20px;text-align:center;color:#ff6b6b;">Error: ${msg}</div>`;
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

export class Editor {
  private container: HTMLElement;
  private view: EditorView | null = null;
  private currentPath: string | null = null;
  private currentMtime: number | null = null;
  private dirty: boolean = false;
  private onSave?: (path: string) => void;
  private onError?: (msg: string) => void;

  constructor(
    container: HTMLElement,
    opts?: { onSave?: (path: string) => void; onError?: (msg: string) => void }
  ) {
    this.container = container;
    this.onSave = opts?.onSave;
    this.onError = opts?.onError;
    this.showPlaceholder('Select a file to edit');
  }

  async openFile(path: string): Promise<void> {
    try {
      const res = await rpc<{ ok: boolean; content: string; mtimeMs: number; error?: string }>({
        type: 'fs.read',
        path,
      });
      if (!res.ok) {
        this.showError(res.error ?? 'Failed to read file');
        return;
      }
      this.currentPath = path;
      this.currentMtime = res.mtimeMs;
      this.dirty = false;
      this.renderEditor(res.content, path);
    } catch (e) {
      this.showError((e as Error).message);
    }
  }

  private renderEditor(content: string, path: string): void {
    if (this.view) {
      this.view.destroy();
      this.view = null;
    }
    // Clear the placeholder/error markup before mounting the view.
    this.container.innerHTML = '';

    const language = this.guessLanguage(path);

    this.view = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: [
          basicSetup,
          keymap.of([indentWithTab]),
          language,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              this.dirty = true;
            }
          }),
        ],
      }),
      parent: this.container,
    });

    // Show save indicator
    this.showSaveBar();
  }

  private showSaveBar(): void {
    // Remove existing save bar
    const existing = this.container.querySelector('.editor-save-bar');
    if (existing) existing.remove();

    const bar = document.createElement('div');
    bar.className = 'editor-save-bar';
    bar.style.display = 'flex';
    bar.style.gap = '8px';
    bar.style.padding = '4px 8px';
    bar.style.borderBottom = '1px solid #2a323c';
    bar.style.background = '#101418';
    bar.style.alignItems = 'center';

    const pathSpan = document.createElement('span');
    pathSpan.textContent = this.currentPath ?? '';
    pathSpan.style.flex = '1';
    pathSpan.style.fontSize = '12px';
    pathSpan.style.color = '#8b95a1';
    pathSpan.style.overflow = 'hidden';
    pathSpan.style.textOverflow = 'ellipsis';
    pathSpan.style.whiteSpace = 'nowrap';
    bar.appendChild(pathSpan);

    const statusSpan = document.createElement('span');
    statusSpan.id = 'editor-status';
    statusSpan.textContent = '● Saved';
    statusSpan.style.fontSize = '12px';
    statusSpan.style.color = '#58d68d';
    bar.appendChild(statusSpan);

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save (Ctrl+S)';
    saveBtn.style.background = '#4ea1ff';
    saveBtn.style.color = '#0b1220';
    saveBtn.style.border = '0';
    saveBtn.style.borderRadius = '4px';
    saveBtn.style.padding = '4px 12px';
    saveBtn.style.cursor = 'pointer';
    saveBtn.style.fontWeight = '600';
    saveBtn.onclick = () => void this.save();
    bar.appendChild(saveBtn);

    // Insert at top of container
    this.container.insertBefore(bar, this.container.firstChild);

    // Keyboard shortcut: Ctrl+S — replace any previously registered handler
    const prev = (this.container as any)._saveHandler as ((e: KeyboardEvent) => void) | undefined;
    if (prev) this.container.removeEventListener('keydown', prev);
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void this.save();
      }
    };
    this.container.addEventListener('keydown', handler);
    (this.container as any)._saveHandler = handler;
  }

  async save(): Promise<void> {
    if (!this.view || !this.currentPath) return;
    const content = this.view.state.doc.toString();
    const statusEl = document.getElementById('editor-status');
    if (statusEl) {
      statusEl.textContent = '⏳ Saving...';
      statusEl.style.color = '#f1c40f';
    }

    try {
      const res = await rpc<{ ok: boolean; mtimeMs?: number; error?: string; conflict?: boolean; serverMtimeMs?: number }>({
        type: 'fs.write',
        path: this.currentPath,
        content,
        baseMtimeMs: this.currentMtime,
      });
      if (!res.ok) {
        if (res.conflict) {
          this.showConflict(res.serverMtimeMs);
          return;
        }
        this.showError(res.error ?? 'Save failed');
        return;
      }
      this.currentMtime = res.mtimeMs ?? Date.now();
      this.dirty = false;
      if (statusEl) {
        statusEl.textContent = '✓ Saved';
        statusEl.style.color = '#58d68d';
      }
      if (this.onSave) this.onSave(this.currentPath);
    } catch (e) {
      this.showError((e as Error).message);
    }
  }

  private showConflict(serverMtimeMs?: number): void {
    const statusEl = document.getElementById('editor-status');
    if (statusEl) {
      statusEl.textContent = '⚠ Conflict: file changed on disk';
      statusEl.style.color = '#ff6b6b';
    }
    // Offer to reload or force save?
    const reloadBtn = document.createElement('button');
    reloadBtn.textContent = 'Reload from disk';
    reloadBtn.style.background = '#ff6b6b';
    reloadBtn.style.color = '#fff';
    reloadBtn.style.border = '0';
    reloadBtn.style.borderRadius = '4px';
    reloadBtn.style.padding = '4px 12px';
    reloadBtn.style.cursor = 'pointer';
    reloadBtn.onclick = () => {
      if (this.currentPath) void this.openFile(this.currentPath);
      reloadBtn.remove();
    };
    const bar = this.container.querySelector('.editor-save-bar');
    if (bar) bar.appendChild(reloadBtn);
  }

  private showPlaceholder(text: string): void {
    this.container.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#8b95a1;font-size:14px;">${text}</div>`;
  }

  private showError(text: string): void {
    this.container.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#ff6b6b;font-size:14px;padding:20px;">${text}</div>`;
  }

  private guessLanguage(path: string) {
    const ext = path.split('.').pop()?.toLowerCase() || '';
    switch (ext) {
      case 'js':
      case 'ts':
      case 'jsx':
      case 'tsx':
        return javascript();
      case 'json':
        return json();
      case 'html':
        return html();
      case 'css':
        return css();
      case 'md':
        return markdown();
      case 'py':
        return python();
      case 'sh':
      case 'bash':
        return StreamLanguage.define(shell);
      default:
        return [];
    }
  }

  destroy(): void {
    if (this.view) {
      this.view.destroy();
      this.view = null;
    }
    // Remove keyboard handler
    const handler = (this.container as any)._saveHandler;
    if (handler) {
      this.container.removeEventListener('keydown', handler);
      delete (this.container as any)._saveHandler;
    }
  }
}