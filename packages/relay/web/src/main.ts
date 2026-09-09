import './style.css';
import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import {
  connect, isConnected, send, rpc, onFrame, type Credential,
} from './conn';
import { looksLikeClear } from './clear';
import { FileTree, loadEditor } from './files';
import type { Editor } from './editor';
import { GitPanel } from './git';
import { CommandWatch } from './command-watch';
import {
  enableNotifications, disableNotifications, readPref, shouldNotify,
  showFinishedNotification, notificationsSupported,
} from './notify';
import { readSettings, writeSettings, TERM_THEMES, type TermSettings } from './settings';
import {
  addHistory, searchHistory, clearHistory, readPins, togglePin, isPinned,
} from './history';
import {
  biolockSupported, biolockEnabled, enableBiolock, disableBiolock, unlockSession,
} from './biolock';
import { TailView } from './tailview';

// One WS to the relay; multiple terminal tabs multiplexed over it by termId.
// Views: Terminals | Files | Git — switched by the header buttons.

interface Tab {
  termId: string;
  name: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  host: HTMLElement;
  tabEl: HTMLElement;
  labelEl: HTMLElement;   // the tab's text label (tracks the running program)
  titleEl: HTMLElement;   // window titlebar text
  badgeEl: HTMLElement;   // window "live"/"exited" badge
  shellName: string;      // e.g. "powershell"
  cwd: string;            // working directory of the pty
  program: string;        // running program surfaced via OSC title, else shellName
  dead: boolean;
  watch: CommandWatch;    // "command finished" detection for notifications
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
const VIEWS = ['terminals', 'files', 'git', 'tail'] as const;
type ViewName = (typeof VIEWS)[number];
let currentView: ViewName = 'terminals';

let fileTree: FileTree | null = null;
let gitPanel: GitPanel | null = null;
let tailView: TailView | null = null;

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
  if (name === 'tail' && !tailView) tailView = new TailView($('tail-panel'));
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
  if (!tab) return;
  // Windows cls/clear never erases the scrollback (see clear.ts) — append a
  // real ESC[3J when a clear shape passes so the screen is genuinely empty.
  tab.term.write(f.data + (looksLikeClear(f.data) ? '\x1b[3J' : ''));
  tab.watch.onOutput();
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
    fontSize: termSettings.fontSize,
    cursorBlink: true,
    scrollback: 5000,
    theme: { ...TERM_THEMES[termSettings.theme] },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  const search = new SearchAddon();
  term.loadAddon(search);

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
  // Tag the xterm root so the light-theme chrome rule applies to new tabs too.
  term.element?.classList.toggle('xterm-light', termSettings.theme === 'light');

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
    termId: '', name: label.textContent!, term, fit, search, host, tabEl,
    labelEl: label, titleEl: title, badgeEl: badge,
    shellName: 'shell', cwd: '', program: '', dead: false,
    watch: new CommandWatch(() => onCommandDone(tab)),
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
    if (!tab.dead && tab.termId) sendInput(tab, data);
  });

  activate(tab);
  fitSoon(tab);
  return tab;
}

// Single choke point for everything typed into a terminal: forward to the pty,
// let the command watcher know a line went out, and record it in history.
// Input arrives as arbitrary chunks (per-keypress on desktop, whole lines from
// the composer/CDP paste path), so we accumulate a pending line per tab and
// record it when its CR arrives.
const pendingLine = new Map<Tab, string>();

function sendInput(tab: Tab, data: string): void {
  send({ type: 'term.input', termId: tab.termId, data });
  if (!data) return;
  const buf = (pendingLine.get(tab) ?? '') + data;
  const crIdx = buf.indexOf('\r');
  if (crIdx === -1) {
    pendingLine.set(tab, buf.slice(-4096)); // guard against unbounded growth
    return;
  }
  tab.watch.onSubmit();
  recordHistoryLine(buf.slice(0, crIdx));
  pendingLine.delete(tab);
}

function recordHistoryLine(raw: string): void {
  const line = raw.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (line) addHistory(line);
}

// A watched command just finished (output ran ≥ RUN_MIN then went quiet).
// Notify only when it's useful: the page is hidden or another tab is focused.
function onCommandDone(tab: Tab): void {
  if (!tab.watch.consumeDone()) return;
  if (!readPref()) return;
  if (!shouldNotify(active === tab)) return;
  showFinishedNotification({
    title: `${tab.program || tab.shellName} — command finished`,
    body: `${tab.name} · ${cwdTail(tab.cwd) || 'kremote'}`,
    onClick: () => {
      window.focus();
      switchView('terminals');
      activate(tab);
    },
  });
}

async function newTab(): Promise<void> {
  if (!isConnected()) return;
  const tab = createTab(`Session ${tabs.length + 1}`);
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
  // Nothing usable to land on — a fresh session, or every terminal died with a
  // restarted agent (their exited tabs stay for scrollback). Open a live one so
  // the user isn't stranded on a dead prompt having to click "+".
  if (!tabs.some(t => !t.dead)) void newTab();
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

// ── ••• overflow menu ──────────────────────────────────────────────────
// Consolidates the secondary header actions (history, search, notifications,
// settings) so the bar stays uncluttered — especially on mobile.
const moreBtn = $('more-btn');
const moreMenu = $('more-menu');
const moreNotify = $('more-notify');

function closeMoreMenu(): void { moreMenu.hidden = true; }

moreBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  moreMenu.hidden = !moreMenu.hidden;
});
document.addEventListener('click', (e) => {
  if (!moreMenu.hidden && !moreMenu.contains(e.target as Node) && e.target !== moreBtn) {
    closeMoreMenu();
  }
});
moreMenu.addEventListener('click', (e) => {
  e.stopPropagation(); // opening a surface here must not trip its own outside-close
  const item = (e.target as HTMLElement).closest('.more-item') as HTMLElement | null;
  if (!item || item.hasAttribute('disabled')) return;
  closeMoreMenu();
  switch (item.dataset.act) {
    case 'history': openHistory(); break;
    case 'search': openTermSearch(); break;
    case 'settings': openSettings(); break;
    case 'notify': toggleNotify(); break;
  }
});

// ── Command-finished notifications (in the ••• menu) ────────────────────
// Unsupported when Notification is missing (e.g. insecure context — the app is
// served over HTTPS for SW/notifications anyway); the item then reads N/A.
function paintNotify(on: boolean): void {
  moreNotify.classList.toggle('on', on);
  moreNotify.textContent = on ? '🔔  Notifications: On' : '🔕  Notifications: Off';
}
function toggleNotify(): void {
  if (!notificationsSupported()) return;
  if (readPref()) { disableNotifications(); paintNotify(false); return; }
  void enableNotifications().then((ok) => paintNotify(ok));
}
if (notificationsSupported()) {
  paintNotify(readPref());
} else {
  moreNotify.textContent = '🔕  Notifications: N/A';
  moreNotify.setAttribute('disabled', '');
}

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

// ── Mobile text composer (Vietnamese/IME-friendly input) ────────────────
// xterm's hidden textarea mangles mobile IME composition (Gboard Telex, VNI):
// each keystroke commits garbage because composition events never complete
// against a synthetic field. A real <input> composes natively; we forward the
// finished line on Enter. Toggle via the ABC key; auto-opens on phones.
const composer = document.getElementById('composer')!;
const composerInput = document.getElementById('composer-input') as HTMLInputElement;
const composerSend = document.getElementById('composer-send')!;
const composerClose = document.getElementById('composer-close')!;
const composerToggle = document.getElementById('composer-toggle')!;

let composing = false;

function composerSendLine(): void {
  const line = composerInput.value;
  composerInput.value = '';
  if (!active || active.dead || !active.termId) return;
  if (line) sendInput(active, line + '\r');
}

composerInput.addEventListener('compositionstart', () => { composing = true; });
composerInput.addEventListener('compositionend', () => { composing = false; });
composerInput.addEventListener('keydown', (e) => {
  if (composing || e.isComposing) return; // don't send mid-composition
  if (e.key === 'Enter') {
    e.preventDefault();
    composerSendLine();
  }
});
composerSend.addEventListener('click', composerSendLine);
composerClose.addEventListener('click', () => { composer.hidden = true; });
composerToggle.addEventListener('click', () => {
  composer.hidden = !composer.hidden;
  if (!composer.hidden) composerInput.focus();
});

// Mobile (coarse pointer): show the toggle and open the composer by default so
// Vietnamese input works out of the box.
if (window.matchMedia('(pointer: coarse)').matches) {
  composerToggle.hidden = false;
  composer.hidden = false;
}

// ── Mobile modifier keys ───────────────────────────────────────────────
const heldModifiers = new Set<string>();
const mobileKeys = document.getElementById('mobile-keys')!;

mobileKeys.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn || btn.id === 'composer-toggle') return; // composer handles itself

  // Actions (#4 paste/copy, #6 search) work off the active tab's buffer, so
  // they run even for a dead tab (search) — handle them before the live guard.
  const act = btn.getAttribute('data-act');
  if (act === 'search') { openTermSearch(); return; }
  if (act === 'copy') { copyActiveSelection(btn); return; }
  if (act === 'paste') { void pasteIntoActive(); return; }

  if (!active || active.dead) return;

  const seq = btn.getAttribute('data-seq');
  const mod = btn.getAttribute('data-key');

  if (seq != null) {
    sendInput(active, unescapeSeq(seq));
    return;
  }
  if (mod != null) {
    if (heldModifiers.has(mod)) { heldModifiers.delete(mod); btn.classList.remove('stuck'); }
    else { heldModifiers.add(mod); btn.classList.add('stuck'); }
  }
});

// #4 Paste: clipboard → active pty. #4 Copy: terminal selection → clipboard.
// The app is served over HTTPS, so the async Clipboard API is available.
async function pasteIntoActive(): Promise<void> {
  if (!active || active.dead || !active.termId) return;
  try {
    const text = await navigator.clipboard.readText();
    if (text) sendInput(active, text);
  } catch { /* permission denied / no clipboard — ignore */ }
}

function copyActiveSelection(btn: HTMLElement): void {
  const sel = active?.term.getSelection();
  if (!sel) return;
  navigator.clipboard.writeText(sel)
    .then(() => {
      btn.classList.add('stuck');            // brief flash = "copied"
      setTimeout(() => btn.classList.remove('stuck'), 450);
    })
    .catch(() => { /* ignore */ });
}

function unescapeSeq(s: string): string {
  return s.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
          .replace(/\\t/g, '\t');
}

// ── Scrollback search (#6) ──────────────────────────────────────────────
// A floating bar over the terminal window, driven by xterm's SearchAddon on
// the *active* tab. Typing jumps to the next match; ↑/↓ (or Shift+Enter/Enter)
// cycle; Esc/✕ closes and returns focus to the terminal.
const termSearch = $('term-search');
const termSearchInput = $('term-search-input') as HTMLInputElement;

function openTermSearch(): void {
  switchView('terminals');
  termSearch.hidden = false;
  termSearchInput.focus();
  termSearchInput.select();
  if (termSearchInput.value) runSearch('next');
}

function closeTermSearch(): void {
  termSearch.hidden = true;
  active?.term.focus();
}

function runSearch(dir: 'next' | 'prev'): void {
  const q = termSearchInput.value;
  if (!active || !q) return;
  if (dir === 'next') active.search.findNext(q);
  else active.search.findPrevious(q);
}

termSearchInput.addEventListener('input', () => runSearch('next'));
termSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runSearch(e.shiftKey ? 'prev' : 'next'); }
  else if (e.key === 'Escape') { e.preventDefault(); closeTermSearch(); }
});
$('term-search-next').addEventListener('click', () => runSearch('next'));
$('term-search-prev').addEventListener('click', () => runSearch('prev'));
$('term-search-close').addEventListener('click', closeTermSearch);

document.addEventListener('keydown', (e) => {
  if (!active || heldModifiers.size === 0) return;
  if (e.key.length === 1 && heldModifiers.has('Control')) {
    const code = e.key.toUpperCase().charCodeAt(0) - 64;
    if (code >= 0 && code <= 31) {
      e.preventDefault();
      sendInput(active, String.fromCharCode(code));
      releaseModifiers();
    }
  } else if (e.key === 'Escape' && heldModifiers.has('Alt')) {
    e.preventDefault();
    sendInput(active, '\x1b');
    releaseModifiers();
  }
}, true);

function releaseModifiers(): void {
  heldModifiers.clear();
  for (const b of mobileKeys.querySelectorAll('button.stuck')) b.classList.remove('stuck');
}

// ── Terminal settings (#2) ──────────────────────────────────────────────
let termSettings: TermSettings = readSettings();
applySettingsToTabs();

function applySettingsToTabs(): void {
  const light = termSettings.theme === 'light';
  for (const t of tabs) {
    t.term.options.fontSize = termSettings.fontSize;
    (t.term.options as any).theme = { ...TERM_THEMES[termSettings.theme] };
    // Softens the window chrome (titlebar) around a light terminal — see the
    // `.term-window:has(.xterm-light)` rule in style.css.
    t.term.element?.classList.toggle('xterm-light', light);
  }
  // Only the active tab is visible; xterm can't measure a display:none host, so
  // fitting hidden tabs is both wrong and pointless (they refit on activate()).
  // Looping fitSoon() over every tab would also clobber its shared timer and
  // leave the active tab unfitted after a font change.
  if (active) fitSoon(active);
}

const settingsPop = $('settings-pop');
const fontLabel = $('set-font');
const biolockToggle = $('biolock-toggle');
const biolockHint = $('biolock-hint');

function paintSettings(): void {
  fontLabel.textContent = String(termSettings.fontSize);
  $('theme-dark').classList.toggle('active', termSettings.theme === 'dark');
  $('theme-light').classList.toggle('active', termSettings.theme === 'light');
  const on = biolockEnabled();
  biolockToggle.textContent = on ? 'On' : 'Off';
  biolockToggle.classList.toggle('on', on);
  biolockHint.textContent = biolockSupported()
    ? (on ? 'Session unlock requires Face/fingerprint on this device.'
          : 'Require Face/fingerprint before reopening the session.')
    : 'Not supported in this browser.';
}

function openSettings(): void {
  settingsPop.hidden = false;
  paintSettings();
}
document.addEventListener('click', (e) => {
  if (!settingsPop.hidden && !settingsPop.contains(e.target as Node)) {
    settingsPop.hidden = true;
  }
});
$('font-minus').addEventListener('click', () => bumpFont(-1));
$('font-plus').addEventListener('click', () => bumpFont(1));
function bumpFont(d: number): void {
  termSettings = { ...termSettings, fontSize: Math.min(24, Math.max(10, termSettings.fontSize + d)) };
  writeSettings(termSettings);
  applySettingsToTabs();
  paintSettings();
}
$('theme-dark').addEventListener('click', () => setTheme('dark'));
$('theme-light').addEventListener('click', () => setTheme('light'));
function setTheme(theme: 'dark' | 'light'): void {
  termSettings = { ...termSettings, theme };
  writeSettings(termSettings);
  applySettingsToTabs();
  paintSettings();
}
biolockToggle.addEventListener('click', () => {
  if (biolockEnabled()) {
    disableBiolock();
    paintSettings();
    return;
  }
  void enableBiolock().then((ok) => {
    paintSettings();
    if (!ok) biolockHint.textContent = 'Could not create a credential — cancelled or unsupported.';
  });
});

// ── Command history + pinned snippets drawer (#5/#6) ────────────────────
const historyDrawer = $('history-drawer');
const historySearch = $('history-search') as HTMLInputElement;
const historyPinned = $('history-pinned');
const historyList = $('history-list');

// A history/snippet row: a ★ pin toggle + the command (tap to send).
function makeHistoryRow(line: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'history-row';

  const pin = document.createElement('button');
  pin.className = 'history-pin';
  const pinned = isPinned(line);
  pin.classList.toggle('on', pinned);
  pin.textContent = pinned ? '★' : '☆';
  pin.title = pinned ? 'Unpin' : 'Pin as snippet';
  pin.setAttribute('aria-label', pin.title);
  pin.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePin(line);
    renderHistory();
  });

  const send = document.createElement('button');
  send.className = 'history-item';
  send.textContent = line;
  send.title = 'Tap to send to the active terminal';
  send.addEventListener('click', () => {
    if (active && !active.dead && active.termId) {
      switchView('terminals');
      sendInput(active, line + '\r');
    }
    historyDrawer.hidden = true;
  });

  row.append(pin, send);
  return row;
}

function renderHistory(): void {
  // Pinned snippets: always shown, independent of the search box.
  historyPinned.innerHTML = '';
  const pins = readPins();
  historyPinned.hidden = pins.length === 0;
  for (const line of pins) historyPinned.appendChild(makeHistoryRow(line));

  historyList.innerHTML = '';
  const items = searchHistory(historySearch.value).slice(0, 100);
  if (items.length === 0) {
    const el = document.createElement('div');
    el.className = 'history-empty';
    el.textContent = pins.length ? 'No matching commands' : 'No commands yet';
    historyList.appendChild(el);
    return;
  }
  for (const line of items) historyList.appendChild(makeHistoryRow(line));
}

function openHistory(): void {
  historyDrawer.hidden = false;
  historySearch.value = '';
  renderHistory();
  historySearch.focus();
}
historyDrawer.addEventListener('click', (e) => {
  if (e.target === historyDrawer) historyDrawer.hidden = true;
});
historySearch.addEventListener('input', renderHistory);
$('history-clear').addEventListener('click', () => {
  clearHistory();
  renderHistory();
});
$('history-close').addEventListener('click', () => { historyDrawer.hidden = true; });

// ── Startup: biometric gate, then the usual session/ACCESS_KEY login flow.
// The stored session token is withheld until the platform authenticator
// verifies the user (opt-in via settings). Cancel → fall back to login.
if (sessionToken) {
  if (biolockEnabled()) {
    void unlockSession().then((unlocked) => {
      if (unlocked) startConnect({ session: sessionToken! });
      else {
        storeSession(null);          // user declined — don't keep the token around
        showLogin('');               // plain ACCESS_KEY login
      }
    });
  } else {
    startConnect({ session: sessionToken });
  }
} else if (urlKey) {
  loginForm.requestSubmit();
}

// PWA: register the service worker in production builds only (dev mode would
// cache the un-built shell and fight Vite's HMR). No-op when unsupported.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // SW is a progressive enhancement - a failed registration must never
    // block the app itself.
  });
}
