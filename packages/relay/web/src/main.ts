import './style.css';
import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import {
  connect, isConnected, send, rpc, onFrame, type Credential,
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
  labelEl: HTMLElement;   // the tab's text label (tracks the running program)
  titleEl: HTMLElement;   // window titlebar text
  badgeEl: HTMLElement;   // window "live"/"exited" badge
  shellName: string;      // e.g. "powershell"
  cwd: string;            // working directory of the pty
  program: string;        // running program surfaced via OSC title, else shellName
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

// ── Session persistence + silent reconnect ─────────────────────────────
// The relay hands us a durable session token on login; we keep it so a dropped
// socket (network blip, laptop sleep, tab reopen) reconnects without a fresh
// ACCESS_KEY. Terminals outlive the socket on the agent, so we reattach them.
const SESSION_KEY = 'kremote.session';
let sessionToken: string | null = readStoredSession();
let reconnectTimer: number | undefined;
let reconnectAttempts = 0;
let manualClose = false;   // set on explicit logout to suppress auto-reconnect
let helloFailed = false;   // relay rejected our hello; onClosed should defer to it

function readStoredSession(): string | null {
  try { return localStorage.getItem(SESSION_KEY); } catch { return null; }
}
function storeSession(token: string | null): void {
  sessionToken = token;
  try {
    if (token) localStorage.setItem(SESSION_KEY, token);
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* private mode / disabled storage — token stays in memory */ }
}

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

function startConnect(cred: Credential): void {
  helloFailed = false;
  clearTimeout(reconnectTimer);
  setStatus('off');
  connect(cred, {
    onHelloOk: (session) => {
      reconnectAttempts = 0;
      if (session) storeSession(session);
      setStatus('on');
      showApp();
      void syncTerms();
    },
    onHelloErr: (msg) => {
      helloFailed = true;
      // A rejected session token is spent — drop it and fall back to login.
      if (sessionToken) storeSession(null);
      markAllDead('disconnected');
      showLogin(msg);
    },
    onClosed: (msg) => {
      setStatus('off');
      if (helloFailed) return; // onHelloErr already routed us to login
      if (sessionToken && !manualClose) {
        markAllReconnecting();
        scheduleReconnect();
      } else {
        markAllDead('disconnected');
        showLogin(msg);
      }
    },
  });
}

// Exponential backoff, capped. Each attempt reuses the durable session token so
// the browser re-pairs with the agent and its still-running terminals.
function scheduleReconnect(): void {
  if (!sessionToken || manualClose) return;
  const delay = Math.min(15_000, 500 * 2 ** reconnectAttempts++);
  clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(() => {
    if (sessionToken) startConnect({ session: sessionToken });
  }, delay);
}

function setStatus(state: 'on' | 'off'): void {
  connState.className = state;
}

function showLogin(msg: string): void {
  clearTimeout(reconnectTimer);
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

// The agent's socket to the relay dropped, but our socket to the relay is still
// up. The agent (and its terminals) may return — show reconnecting, not dead.
onFrame('peer.gone', () => {
  markAllReconnecting();
  setStatus('off');
});

// The agent reconnected and the relay re-paired us: resync surviving terminals.
onFrame('peer.back', () => {
  setStatus('on');
  void syncTerms();
});

// ── Terminal tabs ──────────────────────────────────────────────────────
onFrame('term.data', (f) => {
  const tab = byTermId(f.termId);
  if (tab) tab.term.write(f.data);
});

onFrame('term.exit', (f) => {
  const tab = byTermId(f.termId);
  if (tab) {
    markDead(tab);
    tab.term.write(`\r\n\x1b[90m[process exited${f.code != null ? ` code ${f.code}` : ''}]\x1b[0m\r\n`);
  }
});

function byTermId(termId: string): Tab | undefined {
  return tabs.find(t => t.termId === termId);
}

function markAllDead(reason: string): void {
  for (const t of tabs) {
    if (!t.dead) {
      markDead(t);
      t.term.write(`\r\n\x1b[33m[${reason}]\x1b[0m\r\n`);
    }
  }
}

// The socket dropped but the agent (and its terminals) may still be alive —
// show a soft "reconnecting" state instead of killing the tabs.
function markAllReconnecting(): void {
  for (const t of tabs) if (!t.dead) setBadge(t, 'reconnecting');
}

function reviveTab(tab: Tab): void {
  tab.dead = false;
  tab.tabEl.classList.remove('dead');
  setBadge(tab, 'live');
}

function markDead(tab: Tab): void {
  tab.dead = true;
  tab.tabEl.classList.add('dead');
  setBadge(tab, 'exited');
}

function setBadge(tab: Tab, state: 'live' | 'exited' | 'reconnecting'): void {
  tab.badgeEl.classList.remove('live', 'exited', 'reconnecting');
  tab.badgeEl.classList.add(state);
  tab.badgeEl.textContent = state === 'reconnecting' ? 'reconnecting' : state;
}

// ── Terminal window title ──────────────────────────────────────────────
// Reference: "claude-code — kremote ~/project · • live". The program segment
// tracks the running foreground program (via OSC title); the path stays put.
function renderTitle(tab: Tab): void {
  const prog = tab.program || tab.shellName || 'shell';
  const where = cwdTail(tab.cwd);
  tab.titleEl.textContent = where ? `${prog} — kremote ${where}` : `${prog} — kremote`;
}

function shellBaseName(shell: string): string {
  const base = shell.split(/[\\/]/).pop() ?? shell;
  return base.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase() || 'shell';
}

// Home → ~, keep the last two path segments so the titlebar stays short.
function cwdTail(cwd: string): string {
  if (!cwd) return '';
  const norm = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const segs = norm.split('/').filter(Boolean);
  const home = segs.length >= 3 && /^users$/i.test(segs[segs.length - 3] ?? segs[0]);
  const tail = segs.slice(-2).join('/');
  return home ? `~/${tail}` : tail || norm;
}

// An OSC title is worth showing as the program when it isn't just a path or the
// shell's own default. Returns '' to keep the current program label.
function programFromTitle(raw: string, tab: Tab): string {
  const t = raw.trim();
  if (!t) return '';
  // Path-like titles (PowerShell/cmd set the cwd as the title) aren't programs.
  if (/[\\/]/.test(t) || /^[a-z]:/i.test(t)) return '';
  if (/^(windows powershell|powershell|command prompt|cmd)$/i.test(t)) return tab.shellName;
  // Take the first token, trimmed of leading status glyphs (e.g. "✳ claude").
  const first = t.replace(/^[^\w]+/, '').split(/\s+/)[0] ?? t;
  return first.slice(0, 32);
}

// Build a terminal tab (xterm + window chrome + tab button) without binding it
// to a pty yet. newTab() opens a fresh pty; attachToTerm() rebinds to one that
// survived a reconnect.
function createTab(initialLabel: string): Tab {
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

  // Window chrome: a macOS-style frame (traffic lights · title · live badge)
  // wrapping the xterm screen — matches the docs/images reference.
  const host = document.createElement('div');
  host.className = 'term-host';
  host.hidden = true;
  const win = document.createElement('div');
  win.className = 'term-window';
  const bar = document.createElement('div');
  bar.className = 'term-titlebar';
  const lights = document.createElement('div');
  lights.className = 'term-lights';
  lights.innerHTML = '<span class="l l-r"></span><span class="l l-y"></span><span class="l l-g"></span>';
  const title = document.createElement('div');
  title.className = 'term-title';
  const badge = document.createElement('span');
  badge.className = 'term-badge live';
  badge.textContent = 'live';
  bar.append(lights, title, badge);
  const screen = document.createElement('div');
  screen.className = 'term-screen';
  win.append(bar, screen);
  host.appendChild(win);
  terminalsEl.appendChild(host);
  term.open(screen);

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  const label = document.createElement('span');
  label.textContent = initialLabel;
  const x = document.createElement('button');
  x.className = 'x';
  x.textContent = '×';
  tabEl.append(label, x);
  tabsEl.appendChild(tabEl);

  const tab: Tab = {
    termId: '', name: label.textContent!, term, fit, host, tabEl,
    labelEl: label, titleEl: title, badgeEl: badge,
    shellName: 'shell', cwd: '', program: '', dead: false,
  };
  tabs.push(tab);
  renderTitle(tab);

  // Programs (claude-code, harness, npm…) announce themselves via the OSC
  // title sequence — surface it in the window title and the tab label.
  term.onTitleChange((t) => {
    const prog = programFromTitle(t, tab);
    if (prog) {
      tab.program = prog;
      tab.labelEl.textContent = prog;
      tab.name = prog;
    }
    renderTitle(tab);
  });

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
  return tab;
}

async function newTab(): Promise<void> {
  if (!isConnected()) return;
  const tab = createTab(`term ${tabs.length + 1}`);
  try {
    const res = await rpc<{ ok: boolean; termId?: string; error?: string; cwd?: string; shell?: string }>(
      { type: 'term.open', cols: tab.term.cols, rows: tab.term.rows });
    if (res.ok && res.termId) {
      tab.termId = res.termId;
      tab.cwd = res.cwd ?? '';
      tab.shellName = shellBaseName(res.shell ?? '');
      if (!tab.program) tab.program = tab.shellName;
      renderTitle(tab);
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

// Rebind to a terminal that outlived the socket: replay its scrollback into a
// fresh (or the matching existing) tab. Reuses `existing` on a live-socket blip
// so we don't spawn duplicate tabs for the same termId.
async function attachToTerm(info: { termId: string; shell: string; cwd: string }, existing?: Tab): Promise<void> {
  const tab = existing ?? createTab(shellBaseName(info.shell));
  tab.termId = info.termId;
  reviveTab(tab);
  try {
    const res = await rpc<{ ok: boolean; data?: string; cwd?: string; shell?: string; error?: string }>(
      { type: 'term.attach', termId: info.termId, cols: tab.term.cols, rows: tab.term.rows });
    if (res.ok) {
      tab.term.reset();
      if (res.data) tab.term.write(res.data);
      tab.cwd = res.cwd ?? info.cwd;
      tab.shellName = shellBaseName(res.shell ?? info.shell);
      if (!tab.program) tab.program = tab.shellName;
      renderTitle(tab);
      sendResize(tab);
    } else {
      markDead(tab);
    }
  } catch (e) {
    console.error('term.attach failed:', e);
    markDead(tab);
  }
}

// On (re)connect, reconcile our tabs with the agent's live terminals: reattach
// the ones still running, mark the vanished ones exited, and — on a truly fresh
// session with nothing running — open a first terminal.
async function syncTerms(): Promise<void> {
  let live: { termId: string; shell: string; cwd: string }[];
  try {
    const res = await rpc<{ terms?: { termId: string; shell: string; cwd: string }[] }>({ type: 'term.list' });
    live = res.terms ?? [];
  } catch {
    return; // socket died mid-list; onClosed will drive another reconnect
  }
  const liveIds = new Set(live.map(t => t.termId));
  for (const tab of [...tabs]) {
    if (tab.termId && !liveIds.has(tab.termId)) markDead(tab);
  }
  for (const info of live) {
    await attachToTerm(info, byTermId(info.termId));
  }
  if (tabs.length === 0 && live.length === 0) void newTab();
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
  manualClose = false;
  loginError.hidden = true;
  loginForm.querySelector('button')!.setAttribute('disabled', '');
  startConnect({ accessKey: key });
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

// Startup: a stored session token reconnects silently (persistent login); a
// fresh ?key= in the URL logs in; otherwise the login screen waits.
if (sessionToken) {
  startConnect({ session: sessionToken });
} else if (urlKey) {
  loginForm.requestSubmit();
}
