import { basicSetup } from 'codemirror';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { indentWithTab } from '@codemirror/commands';
import { StreamLanguage, type LanguageSupport } from '@codemirror/language';
import { rpc } from './conn';

// CodeMirror editor — lives in its own module so the ~800 kB CodeMirror
// bundle is a lazy chunk, fetched only when the user first opens a file.
// Language packs are lazy too, one chunk per language.

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
      this.container.classList.add('editor-open');
      await this.renderEditor(res.content, path);
    } catch (e) {
      this.showError((e as Error).message);
    }
  }

  private async renderEditor(content: string, path: string): Promise<void> {
    if (this.view) {
      this.view.destroy();
      this.view = null;
    }
    // Clear the placeholder/error markup before mounting the view.
    this.container.innerHTML = '';

    const language = await this.guessLanguage(path);

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

    // Back button — mobile only (CSS hides it on wide screens): returns to the tree.
    const backBtn = document.createElement('button');
    backBtn.textContent = '‹';
    backBtn.className = 'editor-back-btn';
    backBtn.onclick = () => this.container.classList.remove('editor-open');
    bar.appendChild(backBtn);

    const pathSpan = document.createElement('span');
    pathSpan.textContent = this.currentPath ?? '';
    pathSpan.className = 'editor-path';
    bar.appendChild(pathSpan);

    const statusSpan = document.createElement('span');
    statusSpan.id = 'editor-status';
    statusSpan.className = 'editor-status ok';
    statusSpan.textContent = '● Saved';
    bar.appendChild(statusSpan);

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save (Ctrl+S)';
    saveBtn.className = 'editor-save-btn';
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
      statusEl.textContent = '⏳ Saving…';
      statusEl.className = 'editor-status saving';
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
        statusEl.className = 'editor-status ok';
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
      statusEl.className = 'editor-status error';
    }
    const reloadBtn = document.createElement('button');
    reloadBtn.textContent = 'Reload from disk';
    reloadBtn.className = 'editor-reload-btn';
    reloadBtn.onclick = () => {
      if (this.currentPath) void this.openFile(this.currentPath);
      reloadBtn.remove();
    };
    const bar = this.container.querySelector('.editor-save-bar');
    if (bar) bar.appendChild(reloadBtn);
  }

  private showPlaceholder(text: string): void {
    this.container.innerHTML = `<div class="editor-note">${text}</div>`;
    this.container.classList.remove('editor-back');
  }

  private showError(text: string): void {
    this.container.innerHTML = `<div class="editor-note editor-note-error">${text}</div>`;
  }

  private async guessLanguage(path: string): Promise<LanguageSupport[]> {
    const ext = path.split('.').pop()?.toLowerCase() || '';
    switch (ext) {
      case 'js':
      case 'ts':
      case 'jsx':
      case 'tsx': {
        const { javascript } = await import('@codemirror/lang-javascript');
        return [javascript()];
      }
      case 'json': {
        const { json } = await import('@codemirror/lang-json');
        return [json()];
      }
      case 'html': {
        const { html } = await import('@codemirror/lang-html');
        return [html()];
      }
      case 'css': {
        const { css } = await import('@codemirror/lang-css');
        return [css()];
      }
      case 'md': {
        const { markdown } = await import('@codemirror/lang-markdown');
        return [markdown()];
      }
      case 'py': {
        const { python } = await import('@codemirror/lang-python');
        return [python()];
      }
      case 'sh':
      case 'bash': {
        const { shell } = await import('@codemirror/legacy-modes/mode/shell');
        return [StreamLanguage.define(shell)];
      }
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
