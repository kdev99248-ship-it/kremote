import './style.css';
import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import {
  connect, isConnected, send, rpc, onFrame,
} from './conn';
import { FileTree, loadEditor } from './files';
import type { Editor } from './editor';
import { GitPanel } from './git';

// One WS to the relay; multiple terminal tabs multiplexed over it by termId.
// Views: Terminals | Files | Git — switched by the header buttons.

interface Tab {
  termId: string;
  name: string;
  term: Terminal;
  fit: FitAddon;
  host: HTMLElement;
  tabEl: HTMLElement;
  dead: boolean;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const loginScreen = $('login');
const appScreen = $('app');
const loginForm = $('login-form') as HTMLFormElement;
const accessKeyInput = $('access-key') as HTMLInputElement;
const loginError = $('login-error');
const tabsEl = $('tabs');
const terminalsEl = $('terminals');
const newTabBtn = $('new-tab');
const connState = $('conn-state');

let tabs: Tab[] = [];
let active: Tab | null = null;
let reqSeq = 0;
let reconnectTimer: number | undefined;

// ── View switching ─────────────────────────────────────────────────────
const VIEWS = ['terminals', 'files', 'git'] as const;
type ViewName = (typeof VIEWS)[number];
let currentView: ViewName = 'terminals';

let fileTree: FileTree | null = null;
let gitPanel: GitPanel | null = null;

function switchView(name: ViewName): void {
  currentView = name;
  for (const v of VIEWS) {
    const el = $(v);
    el.hidden = v !== name;
  }
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.view-btn')) {
    btn.classList.toggle('active', btn.dataset.view === name);
  }
  // Mobile CSS keys off this to drop the tab row on non-terminal views.
  appScreen.dataset.view = name;
  // Fit the terminal when switching back to it (layout may have changed).
  if (name === 'terminals' && active) fitSoon(active);
  // Mobile keys only matter for the terminal view.
  const mk = document.getElementById('mobile-keys');
  if (mk) mk.style.display = name === 'terminals' ? '' : 'none';
  if (name === 'files' && fileTree) fileTree.refresh();
  if (name === 'git' && gitPanel) gitPanel.refresh();
}

for (const btn of document.querySelectorAll<HTMLButtonElement>('.view-btn')) {
  btn.addEventListener('click', () => {
    const name = btn.dataset.view as ViewName;
    if (VIEWS.includes(name)) switchView(name);
  });
}

// ── Hello / connection lifecycle ───────────────────────────────────────
// Pre-fill ?key= from the agent's printed URL.
const urlKey = new URLSearchParams(location.search).get('key');
if (urlKey) accessKeyInput.value = urlKey.toUpperCase();

function connectWithKey(accessKey: string): void {
  setStatus('off');
  connect(accessKey, {
    onHelloOk: () => {
      setStatus('on');
      showApp();
      if (tabs.length === 0) void newTab();
    },
    onHelloErr: (msg) => showLogin(msg),
    onClosed: (msg) => {
      setStatus('off');
      markAllDead('disconnected');
      showLogin(msg);
    },
  });
}

function setStatus(state: 'on' | 'off'): void {
  connState.className = state;
}

function showLogin(msg: string): void {
  loginError.textContent = msg;
  loginError.hidden = !msg;
  loginScreen.hidden = false;
  appScreen.hidden = true;
  accessKeyInput.focus();
}

function showApp(): void {
  loginScreen.hidden = true;
  appScreen.hidden = false;
  if (!fileTree) {
    fileTree = new FileTree($('file-tree'), (path) => void openFile(path));
  }
  if (!gitPanel) {
    gitPanel = new GitPanel($('git-panel'));
  }
  switchView('terminals');
}

// CodeMirror arrives on demand: the first file click fetches the editor chunk.
// Later clicks reuse it. Clicks that land while the chunk is still in flight
// are chained so the last one wins.
let editorReady: Promise<Editor> | null = null;

async function openFile(path: string): Promise<void> {
  editorReady ??= loadEditor($('editor'), {
    onSave: () => fileTree?.refresh(),
  });
  const ed = await editorReady;
  await ed.openFile(path);
}

onFrame('peer.gone', () => {
  markAllDead('agent offline');
  setStatus('off');
});

// ── Terminal tabs ──────────────────────────────────────────────────────
onFrame('term.data', (f) => {
  const tab = byTermId(f.termId);
  if (tab) tab.term.write(f.data);
});

onFrame('term.exit', (f) => {
  const tab = byTermId(f.termId);
  if (tab) {
    tab.dead = true;
    tab.tabEl.classList.add('dead');
    tab.term.write(`\r\n\x1b[90m[process exited${f.code != null ? ` code ${f.code}` : ''}]\x1b[0m\r\n`);
  }
});

function byTermId(termId: string): Tab | undefined {
  return tabs.find(t => t.termId === termId);
}

function markAllDead(reason: string): void {
  for (const t of tabs) {
    if (!t.dead) {
      t.dead = true;
      t.tabEl.classList.add('dead');
      t.term.write(`\r\n\x1b[33m[${reason}]\x1b[0m\r\n`);
    }
  }
}

async function newTab(): Promise<void> {
  if (!isConnected()) return;

  const term = new Terminal({
    fontFamily: '"JetBrains Mono", ui-monospace, Consolas, "Cascadia Mono", monospace',
    fontSize: 14,
    cursorBlink: true,
    scrollback: 5000,
    theme: {
      background: '#040404',
      foreground: '#e5e5e5',
      cursor: '#e46c4c',
      cursorAccent: '#0c0c0c',
      selectionBackground: 'rgba(228, 108, 76, .28)',
      selectionInactiveBackground: 'rgba(228, 108, 76, .14)',
      black: '#242424',
      red: '#ff5f57',
      green: '#22c55e',
      yellow: '#febc2e',
      blue: '#60a5fa',
      magenta: '#c084fc',
      cyan: '#22d3ee',
      white: '#e5e5e5',
      brightBlack: '#737373',
      brightRed: '#ff8178',
      brightGreen: '#4ade80',
      brightYellow: '#fde047',
      brightBlue: '#93c5fd',
      brightMagenta: '#d8b4fe',
      brightCyan: '#67e8f9',
      brightWhite: '#fafafa',
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());

  const host = document.createElement('div');
  host.className = 'term-host';
  host.hidden = true;
  terminalsEl.appendChild(host);
  term.open(host);

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  const label = document.createElement('span');
  label.textContent = `term ${tabs.length + 1}`;
  const x = document.createElement('button');
  x.className = 'x';
  x.textContent = '×';
  tabEl.append(label, x);
  tabsEl.appendChild(tabEl);

  const tab: Tab = {
    termId: '', name: label.textContent!, term, fit, host, tabEl,
    dead: false,
  };
  tabs.push(tab);

  tabEl.addEventListener('click', (e) => {
    if (e.target === x) return;
    activate(tab);
  });
  x.addEventListener('click', () => closeTab(tab));

  term.onData((data) => {
    if (!tab.dead && tab.termId) send({ type: 'term.input', termId: tab.termId, data });
  });

  activate(tab);
  fitSoon(tab);

  try {
    const res = await rpc<{ ok: boolean; termId?: string; error?: string }>(
      { type: 'term.open', cols: term.cols, rows: term.rows });
    if (res.ok && res.termId) {
      tab.termId = res.termId;
      sendResize(tab);
    } else {
      console.error('term.open failed:', res.error);
      closeTab(tab, true);
    }
  } catch (e) {
    console.error('term.open timed out:', e);
    closeTab(tab, true);
  }
}

function activate(tab: Tab): void {
  active = tab;
  for (const t of tabs) {
    t.tabEl.classList.toggle('active', t === tab);
    t.host.hidden = t !== tab;
  }
  fitSoon(tab);
  tab.term.focus();
}

let fitTimer: number | undefined;
function fitSoon(tab: Tab): void {
  clearTimeout(fitTimer);
  fitTimer = window.setTimeout(() => {
    try {
      tab.fit.fit();
      sendResize(tab);
    } catch { /* detached */ }
  }, 30);
}

function sendResize(tab: Tab): void {
  if (!tab.dead && tab.termId) {
    send({ type: 'term.resize', termId: tab.termId, cols: tab.term.cols, rows: tab.term.rows });
  }
}

function closeTab(tab: Tab, skipServer = false): void {
  if (!skipServer && tab.termId && !tab.dead) {
    send({ type: 'term.close', id: `close${++reqSeq}`, termId: tab.termId });
  }
  tabs = tabs.filter(t => t !== tab);
  tab.term.dispose();
  tab.host.remove();
  tab.tabEl.remove();
  if (active === tab) activate(tabs[tabs.length - 1] ?? null!);
  if (tabs.length === 0 && isConnected()) void newTab();
}

newTabBtn.addEventListener('click', () => void newTab());

window.addEventListener('resize', () => { if (active) fitSoon(active); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && active) fitSoon(active);
});

// ── Login form ─────────────────────────────────────────────────────────
loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const key = accessKeyInput.value.trim().toUpperCase();
  if (!key) return;
  loginError.hidden = true;
  loginForm.querySelector('button')!.setAttribute('disabled', '');
  connectWithKey(key);
  setTimeout(() => loginForm.querySelector('button')!.removeAttribute('disabled'), 1500);
});

// ── Mobile modifier keys ───────────────────────────────────────────────
const heldModifiers = new Set<string>();
const mobileKeys = document.getElementById('mobile-keys')!;

mobileKeys.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn || !active || active.dead) return;

  const seq = btn.getAttribute('data-seq');
  const mod = btn.getAttribute('data-key');

  if (seq != null) {
    send({ type: 'term.input', termId: active.termId, data: unescapeSeq(seq) });
    return;
  }
  if (mod != null) {
    if (heldModifiers.has(mod)) { heldModifiers.delete(mod); btn.classList.remove('stuck'); }
    else { heldModifiers.add(mod); btn.classList.add('stuck'); }
  }
});

function unescapeSeq(s: string): string {
  return s.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
          .replace(/\\t/g, '\t');
}

document.addEventListener('keydown', (e) => {
  if (!active || heldModifiers.size === 0) return;
  if (e.key.length === 1 && heldModifiers.has('Control')) {
    const code = e.key.toUpperCase().charCodeAt(0) - 64;
    if (code >= 0 && code <= 31) {
      e.preventDefault();
      send({ type: 'term.input', termId: active.termId, data: String.fromCharCode(code) });
      releaseModifiers();
    }
  } else if (e.key === 'Escape' && heldModifiers.has('Alt')) {
    e.preventDefault();
    send({ type: 'term.input', termId: active.termId, data: '\x1b' });
    releaseModifiers();
  }
}, true);

function releaseModifiers(): void {
  heldModifiers.clear();
  for (const b of mobileKeys.querySelectorAll('button.stuck')) b.classList.remove('stuck');
}

if (urlKey) loginForm.requestSubmit();
