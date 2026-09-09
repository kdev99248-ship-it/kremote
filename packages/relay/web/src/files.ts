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
    this.container.appendChild(pathLabel);
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
      li.className = entry.kind === 'dir' ? 'file-tree-row is-dir' : 'file-tree-row';

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
        sizeSpan.className = 'file-tree-size';
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

      ul.appendChild(li);
    }
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
