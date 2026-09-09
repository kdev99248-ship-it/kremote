/**
 * Tail view (#4): live `tail -f` panel over the tail.* protocol, with
 * pattern-matching notifications (e.g. alert when a log line contains ERROR).
 */

import { onFrame, rpc, send } from './conn';
import { showFinishedNotification } from './notify';
import { enablePush } from './push';

export interface TailOpts {
  onOpenTail?: (path: string) => void;
}

export class TailView {
  private host: HTMLElement;
  private watchId: string | null = null;
  private path = '';
  private buf = '';
  private linesEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private patternInput: HTMLInputElement | null = null;
  private pattern = '';
  private notifyEnabled = false;
  private autoScroll = true;

  constructor(host: HTMLElement) {
    this.host = host;
    this.render();
    this.frameUnsub = onFrame('tail.data', (f) => this.onChunk(f.watchId, f.chunk));
  }

  private frameUnsub: () => void;

  render(): void {
    this.host.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'tail-head';
    const title = document.createElement('span');
    title.className = 'tail-title';
    title.textContent = 'Live tail';
    const fileInput = document.createElement('input');
    fileInput.className = 'tail-path';
    fileInput.type = 'text';
    fileInput.placeholder = 'path/to/app.log (relative to agent root)';
    fileInput.spellcheck = false;
    fileInput.autocapitalize = 'off';
    this.fileInput = fileInput;
    const startBtn = document.createElement('button');
    startBtn.className = 'tail-start';
    startBtn.textContent = 'Follow';
    startBtn.addEventListener('click', () => void this.start(fileInput.value.trim()));
    fileInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.start(fileInput.value.trim());
    });
    head.append(title, fileInput, startBtn);
    this.host.appendChild(head);

    // Pattern row: notify when a new line matches.
    const prow = document.createElement('div');
    prow.className = 'tail-pattern-row';
    const pat = document.createElement('input');
    pat.type = 'text';
    pat.className = 'tail-pattern';
    pat.placeholder = 'Notify on lines matching… (e.g. ERROR)';
    pat.spellcheck = false;
    pat.addEventListener('input', () => {
      this.pattern = pat.value;
      // Keep the server-side alert regex in step while notifications are on.
      if (this.notifyEnabled) this.syncNotify();
    });
    this.patternInput = pat;
    const patBtn = document.createElement('button');
    patBtn.className = 'tail-notify-btn';
    patBtn.textContent = '🔔';
    patBtn.title = 'Toggle pattern notifications';
    patBtn.addEventListener('click', () => {
      this.notifyEnabled = !this.notifyEnabled;
      patBtn.classList.toggle('on', this.notifyEnabled);
      // Turning on also asks for OS push so alerts arrive with the app closed.
      if (this.notifyEnabled) void enablePush();
      this.syncNotify();
    });
    prow.append(pat, patBtn);
    this.host.appendChild(prow);

    const out = document.createElement('div');
    out.className = 'tail-out';
    const lines = document.createElement('pre');
    lines.className = 'tail-lines';
    out.appendChild(lines);
    out.addEventListener('scroll', () => {
      this.autoScroll = out.scrollTop + out.clientHeight >= out.scrollHeight - 30;
    });
    this.host.appendChild(out);
    this.linesEl = lines;
    this.outEl = out;

    const status = document.createElement('div');
    status.className = 'tail-status';
    this.host.appendChild(status);
    this.statusEl = status;
  }

  private fileInput: HTMLInputElement | null = null;
  private outEl: HTMLElement | null = null;

  setStatus(msg: string, err = false): void {
    if (!this.statusEl) return;
    this.statusEl.textContent = msg;
    this.statusEl.classList.toggle('error', err);
  }

  async start(path: string): Promise<void> {
    if (!path) { this.setStatus('enter a file path', true); return; }
    this.stop();
    this.path = path;
    this.buf = '';
    if (this.linesEl) this.linesEl.textContent = '';
    this.setStatus(`following ${path}…`);
    try {
      const res = await rpc<{ ok: boolean; watchId?: string; error?: string }>(
        { type: 'tail.watch', path, fromEnd: false });
      if (res.ok && res.watchId) {
        this.watchId = res.watchId;
        this.setStatus(`following ${path}`);
        if (this.notifyEnabled) this.syncNotify(); // re-arm alerts on the new watch
      } else {
        this.setStatus(res.error ?? 'failed to follow', true);
      }
    } catch (e) {
      this.setStatus((e as Error).message, true);
    }
  }

  stop(): void {
    if (this.watchId) send({ type: 'tail.unwatch', watchId: this.watchId });
    this.watchId = null;
  }

  dispose(): void {
    this.stop();
    this.frameUnsub();
  }

  private onChunk(watchId: string, chunk: string): void {
    if (watchId !== this.watchId) return;
    this.buf = (this.buf + chunk).slice(-64 * 1024);
    const el = this.linesEl;
    if (el) {
      // Render as plain text (textContent): log content is untrusted input.
      el.textContent = this.buf;
      if (this.autoScroll && this.outEl) this.outEl.scrollTop = this.outEl.scrollHeight;
    }
    if (this.notifyEnabled && this.pattern) {
      const re = this.safeRegex(this.pattern);
      if (re) {
        for (const line of chunk.split('\n')) {
          if (re.test(line)) {
            showFinishedNotification({
              title: `tail: ${this.path}`,
              body: line.slice(0, 120),
              onClick: () => { window.focus(); },
            });
            break; // one notification per chunk, not per line
          }
        }
      }
    }
  }

  /** Push the current alert regex to the agent so it can notify with the app
   *  closed (empty pattern / notifications off = clear the server-side alert). */
  private syncNotify(): void {
    if (!this.watchId) return;
    const pattern = this.notifyEnabled ? this.pattern.trim() : '';
    send({ type: 'tail.notify', watchId: this.watchId, pattern: pattern || undefined });
  }

  private safeRegex(p: string): RegExp | null {
    try { return new RegExp(p, 'i'); } catch { return null; }
  }
}
