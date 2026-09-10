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
import { cameraSupported, startQrScan, parseQrPayload, type QrScanner } from './qrscan';

// One WS to the relay; multiple terminals multiplexed over it by termId.
//
// Two levels of navigation:
//   Home / Files / Git / Logs — the browsing screens, sharing the top bar.
//   Terminal                  — a full-bleed screen for ONE session, entered by
//                               tapping a row on Home and left via its ‹ back.
// A session is therefore never a pane: the pane stays alive in the background
// (scrollback intact) and Home is the only session switcher.

interface Pane {
  termId: string;
  name: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  host: HTMLElement;      // the xterm container inside #term-stack
  shellName: string;      // e.g. "powershell"
  cwd: string;            // working directory of the pty
  program: string;        // running program surfaced via OSC title, else shellName
  dead: boolean;
  badge: BadgeState;      // painted into the terminal bar while this pane is open
  watch: CommandWatch;    // "command finished" detection for notifications
}

type BadgeState = 'live' | 'exited' | 'reconnecting';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const loginScreen = $('login');
const appScreen = $('app');
const loginForm = $('login-form') as HTMLFormElement;
const accessKeyInput = $('access-key') as HTMLInputElement;
const loginError = $('login-error');
const termStack = $('term-stack');
const termTitle = $('term-title');
const termBadge = $('term-badge');
const connState = $('conn-state');

let panes: Pane[] = [];
let active: Pane | null = null;
let reqSeq = 0;

// ── Session persistence + silent reconnect ─────────────────────────────
// The relay hands us a durable session token on login; we keep it so a dropped
// socket (network blip, laptop sleep, pane reopen) reconnects without a fresh
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
// 'term' is a screen rather than a tab: it hides the top bar entirely (CSS keys
// off #app[data-view]) so the pty gets the full viewport, and it is reachable
// only by opening a session from Home.
const NAV_VIEWS = ['home', 'files', 'git', 'tail'] as const;
const VIEWS = [...NAV_VIEWS, 'term'] as const;
type ViewName = (typeof VIEWS)[number];
let currentView: ViewName = 'home';

const VIEW_ELEMENT: Record<ViewName, string> = {
  home: 'home', files: 'files', git: 'git', tail: 'tail', term: 'terminals',
};

let fileTree: FileTree | null = null;
let gitPanel: GitPanel | null = null;
let tailView: TailView | null = null;

function switchView(name: ViewName): void {
  currentView = name;
  for (const v of VIEWS) $(VIEW_ELEMENT[v]).hidden = v !== name;
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.view-btn')) {
    btn.classList.toggle('active', btn.dataset.view === name);
  }
  // CSS keys off this to drop the top bar / mobile keys per screen.
  appScreen.dataset.view = name;
  // Fit the terminal when switching back to it (layout may have changed).
  if (name === 'term' && active) fitSoon(active);
  if (name === 'home') void refreshSessions();
  if (name === 'files' && fileTree) fileTree.refresh();
  if (name === 'git' && gitPanel) gitPanel.refresh();
  if (name === 'tail' && !tailView) tailView = new TailView($('tail-panel'));
}

for (const btn of document.querySelectorAll<HTMLButtonElement>('.view-btn')) {
  btn.addEventListener('click', () => {
    const name = btn.dataset.view as ViewName;
    if ((NAV_VIEWS as readonly string[]).includes(name)) switchView(name);
  });
}

/** Bring a session's pane to the front and enter the full-screen terminal. */
function openPane(pane: Pane): void {
  activate(pane);
  switchView('term');
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
  closeQrScan();   // a QR login leaves the camera running otherwise
  loginScreen.hidden = true;
  appScreen.hidden = false;
  if (!fileTree) {
    fileTree = new FileTree($('file-tree'), (path) => void openFile(path));
  }
  if (!gitPanel) {
    gitPanel = new GitPanel($('git-panel'));
  }
  switchView('home');
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

// ── Terminal panes ──────────────────────────────────────────────────────
onFrame('term.data', (f) => {
  const pane = byTermId(f.termId);
  if (!pane) return;
  // Windows cls/clear never erases the scrollback (see clear.ts) — append a
  // real ESC[3J when a clear shape passes so the screen is genuinely empty.
  pane.term.write(f.data + (looksLikeClear(f.data) ? '\x1b[3J' : ''));
  pane.watch.onOutput();
});

onFrame('term.exit', (f) => {
  const pane = byTermId(f.termId);
  if (pane) {
    markDead(pane);
    pane.term.write(`\r\n\x1b[90m[process exited${f.code != null ? ` code ${f.code}` : ''}]\x1b[0m\r\n`);
  }
});

function byTermId(termId: string): Pane | undefined {
  return panes.find(t => t.termId === termId);
}

function markAllDead(reason: string): void {
  for (const t of panes) {
    if (!t.dead) {
      markDead(t);
      t.term.write(`\r\n\x1b[33m[${reason}]\x1b[0m\r\n`);
    }
  }
}

// The socket dropped but the agent (and its terminals) may still be alive —
// show a soft "reconnecting" state instead of killing the panes.
function markAllReconnecting(): void {
  for (const t of panes) if (!t.dead) setBadge(t, 'reconnecting');
}

function revivePane(pane: Pane): void {
  pane.dead = false;
  setBadge(pane, 'live');
}

function markDead(pane: Pane): void {
  pane.dead = true;
  setBadge(pane, 'exited');
}

function setBadge(pane: Pane, state: BadgeState): void {
  pane.badge = state;
  if (pane === active) renderTermBar();
}

// ── Terminal bar ───────────────────────────────────────────────────────
// One shared bar for whichever session is open, replacing the old per-tab window
// chrome. Reads "claude — ~/project" plus the live/exited badge; the program
// segment tracks the running foreground program (via OSC title).
function renderTermBar(): void {
  if (!active) { termTitle.textContent = ''; return; }
  const prog = active.program || active.shellName || 'shell';
  const where = cwdTail(active.cwd);
  termTitle.textContent = where ? `${prog} — ${where}` : prog;
  termBadge.className = `term-badge ${active.badge}`;
  termBadge.textContent = active.badge;
}

/** Refresh the bar only when this pane is the one on screen. */
function renderTitle(pane: Pane): void {
  if (pane === active) renderTermBar();
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
function programFromTitle(raw: string, shellName: string): string {
  const t = raw.trim();
  if (!t) return '';
  // Path-like titles (PowerShell/cmd set the cwd as the title) aren't programs.
  if (/[\\/]/.test(t) || /^[a-z]:/i.test(t)) return '';
  if (/^(windows powershell|powershell|command prompt|cmd)$/i.test(t)) return shellName;
  // Take the first token, trimmed of leading status glyphs (e.g. "✳ claude").
  const first = t.replace(/^[^\w]+/, '').split(/\s+/)[0] ?? t;
  return first.slice(0, 32);
}

// Build a terminal pane (a bare, full-bleed xterm) without binding it to a pty
// yet. newSession() opens a fresh pty; attachToTerm() rebinds to one that
// survived a reconnect. Panes stack in #term-stack and only the active one is
// visible — the rest keep their scrollback for when Home reopens them.
function createPane(initialLabel: string): Pane {
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

  const host = document.createElement('div');
  host.className = 'term-host';
  host.hidden = true;
  termStack.appendChild(host);
  term.open(host);
  // Tag the xterm root so the light-theme chrome rule applies to new panes too.
  term.element?.classList.toggle('xterm-light', termSettings.theme === 'light');

  const pane: Pane = {
    termId: '', name: initialLabel, term, fit, search, host,
    shellName: 'shell', cwd: '', program: '', dead: false, badge: 'live',
    watch: new CommandWatch(() => onCommandDone(pane)),
  };
  panes.push(pane);

  // Programs (claude-code, harness, npm…) announce themselves via the OSC
  // title sequence — surface it in the terminal bar and the Home row.
  term.onTitleChange((t) => {
    const prog = programFromTitle(t, pane.shellName);
    if (prog) {
      pane.program = prog;
      pane.name = prog;
    }
    renderTitle(pane);
  });

  term.onData((data) => {
    if (!pane.dead && pane.termId) sendInput(pane, data);
  });

  activate(pane);
  fitSoon(pane);
  return pane;
}

// Single choke point for everything typed into a terminal: forward to the pty,
// let the command watcher know a line went out, and record it in history.
// Input arrives as arbitrary chunks (per-keypress on desktop, whole lines from
// the composer/CDP paste path), so we accumulate a pending line per pane and
// record it when its CR arrives.
const pendingLine = new Map<Pane, string>();

function sendInput(pane: Pane, data: string): void {
  send({ type: 'term.input', termId: pane.termId, data });
  if (!data) return;
  const buf = (pendingLine.get(pane) ?? '') + data;
  const crIdx = buf.indexOf('\r');
  if (crIdx === -1) {
    pendingLine.set(pane, buf.slice(-4096)); // guard against unbounded growth
    return;
  }
  pane.watch.onSubmit();
  recordHistoryLine(buf.slice(0, crIdx));
  pendingLine.delete(pane);
}

function recordHistoryLine(raw: string): void {
  const line = raw.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (line) addHistory(line);
}

// A watched command just finished (output ran ≥ RUN_MIN then went quiet).
// Notify only when it's useful: the page is hidden or another pane is focused.
function onCommandDone(pane: Pane): void {
  if (!pane.watch.consumeDone()) return;
  if (!readPref()) return;
  if (!shouldNotify(active === pane)) return;
  showFinishedNotification({
    title: `${pane.program || pane.shellName} — command finished`,
    body: `${pane.name} · ${cwdTail(pane.cwd) || 'kremote'}`,
    onClick: () => {
      window.focus();
      openPane(pane);
    },
  });
}

async function newSession(): Promise<void> {
  if (!isConnected()) return;
  const pane = createPane(`Session ${panes.length + 1}`);
  openPane(pane);
  try {
    const res = await rpc<{ ok: boolean; termId?: string; error?: string; cwd?: string; shell?: string }>(
      { type: 'term.open', cols: pane.term.cols, rows: pane.term.rows });
    if (res.ok && res.termId) {
      pane.termId = res.termId;
      pane.cwd = res.cwd ?? '';
      pane.shellName = shellBaseName(res.shell ?? '');
      if (!pane.program) pane.program = pane.shellName;
      renderTitle(pane);
      sendResize(pane);
    } else {
      console.error('term.open failed:', res.error);
      closePane(pane, true);
    }
  } catch (e) {
    console.error('term.open timed out:', e);
    closePane(pane, true);
  }
}

// Rebind to a terminal that outlived the socket: replay its scrollback into a
// fresh (or the matching existing) pane. Reuses `existing` on a live-socket blip
// so we don't spawn duplicate panes for the same termId. Resolves false when the
// agent no longer has that pty — Home rows can go stale between polls, and
// landing on a blank dead terminal explains nothing.
async function attachToTerm(
  info: { termId: string; shell: string; cwd: string }, existing?: Pane,
): Promise<boolean> {
  const pane = existing ?? createPane(shellBaseName(info.shell));
  pane.termId = info.termId;
  revivePane(pane);
  try {
    const res = await rpc<{ ok: boolean; data?: string; cwd?: string; shell?: string; error?: string }>(
      { type: 'term.attach', termId: info.termId, cols: pane.term.cols, rows: pane.term.rows });
    if (res.ok) {
      pane.term.reset();
      if (res.data) pane.term.write(res.data);
      pane.cwd = res.cwd ?? info.cwd;
      pane.shellName = shellBaseName(res.shell ?? info.shell);
      if (!pane.program) pane.program = pane.shellName;
      renderTitle(pane);
      sendResize(pane);
      return true;
    }
    console.error('term.attach rejected:', res.error);
  } catch (e) {
    console.error('term.attach failed:', e);
  }
  // A pane we just built for this attach has nothing to show — drop it rather
  // than leave an empty husk. One that already existed keeps its scrollback and
  // just goes dead, as it would on any other exit.
  if (existing) markDead(pane);
  else discardPane(pane);
  return false;
}

/** Tear down a pane locally, without asking the agent to kill anything. */
function discardPane(pane: Pane): void {
  panes = panes.filter(p => p !== pane);
  pendingLine.delete(pane);
  pane.term.dispose();
  pane.host.remove();
  if (active === pane) { active = null; renderTermBar(); }
}

// On (re)connect, reconcile our panes with the agent's live terminals: reattach
// the ones still running and mark the vanished ones exited. Sessions with no
// local pane — ones started on another device — are never auto-opened; they show
// up on Home for the user to pick.
async function syncTerms(): Promise<void> {
  let live: SessionInfo[];
  try {
    const res = await rpc<{ terms?: SessionInfo[] }>({ type: 'term.list' });
    live = res.terms ?? [];
  } catch {
    return; // socket died mid-list; onClosed will drive another reconnect
  }
  lastSessions = live;
  const liveIds = new Set(live.map(t => t.termId));
  for (const pane of [...panes]) {
    if (pane.termId && !liveIds.has(pane.termId)) markDead(pane);
  }
  // Silently revive only the terminals THIS browser already owns (a reconnect or
  // peer.back) — a phone waking up must land back where it was, not on a picker.
  for (const info of live) {
    const existing = byTermId(info.termId);
    if (existing) await attachToTerm(info, existing);
  }
  // Repaint wherever the user already is. A reconnect must never yank them off
  // Files/Git/Logs, and a silently revived terminal is exactly where they left
  // off — Home is only the fallback for a terminal screen with nothing behind it
  // (and the landing view on a fresh connect, via showApp).
  if (currentView === 'term' && (!active || active.dead)) switchView('home');
  else if (currentView === 'term') renderTermBar();
  else if (currentView === 'home') renderSessions(live);
}

function activate(pane: Pane): void {
  active = pane;
  for (const t of panes) t.host.hidden = t !== pane;
  renderTermBar();
  fitSoon(pane);
  pane.term.focus();
}

let fitTimer: number | undefined;
function fitSoon(pane: Pane): void {
  clearTimeout(fitTimer);
  fitTimer = window.setTimeout(() => {
    try {
      pane.fit.fit();
      sendResize(pane);
    } catch { /* detached */ }
  }, 30);
}

function sendResize(pane: Pane): void {
  if (!pane.dead && pane.termId) {
    send({ type: 'term.resize', termId: pane.termId, cols: pane.term.cols, rows: pane.term.rows });
  }
}

// Drop the pane (and, unless `skipServer`, kill the pty behind it). There is no
// "next tab" to fall back to any more — closing the open session returns Home,
// which is also where the freshly-updated session list lives.
function closePane(pane: Pane, skipServer = false): void {
  if (!skipServer && pane.termId && !pane.dead) {
    send({ type: 'term.close', id: `close${++reqSeq}`, termId: pane.termId });
  }
  panes = panes.filter(t => t !== pane);
  pendingLine.delete(pane);
  pane.term.dispose();
  pane.host.remove();
  if (active === pane) {
    active = null;
    renderTermBar();
  }
  if (currentView === 'term') switchView('home');
  else void refreshSessions();
}

$('new-session').addEventListener('click', () => void newSession());
$('term-back').addEventListener('click', () => switchView('home'));
$('term-kill').addEventListener('click', () => { if (active) closePane(active); });

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

// ── QR login ────────────────────────────────────────────────────────────
// The agent prints a QR of `https://relay/?key=…`. A phone browser can scan it
// with the system camera, but an *installed* PWA has no address bar to hand the
// URL to — so it scans in-app and logs straight in.
const qrOverlay = $('qr-scan');
const qrVideo = $('qr-video') as HTMLVideoElement;
const qrHint = $('qr-hint');
const qrOpenBtn = $('qr-open');

let scanner: QrScanner | null = null;

if (!cameraSupported()) qrOpenBtn.hidden = true;

function closeQrScan(): void {
  scanner?.stop();
  scanner = null;
  qrOverlay.hidden = true;
}

async function openQrScan(): Promise<void> {
  if (scanner) return;
  qrOverlay.hidden = false;
  qrHint.classList.remove('error');
  qrHint.textContent = 'Point at the QR code printed by the agent';
  scanner = await startQrScan(qrVideo, onQrText, (msg) => {
    qrHint.classList.add('error');
    qrHint.textContent = msg;
  });
}

function onQrText(raw: string): void {
  const hit = parseQrPayload(raw);
  if (!hit) {
    // Keep scanning: the camera may just have caught some other QR in frame.
    qrHint.classList.add('error');
    qrHint.textContent = 'That QR is not a kremote key — keep pointing.';
    return;
  }
  closeQrScan();
  // A QR minted by a *different* relay only works on that origin, so follow it
  // rather than failing the key against this host.
  if (hit.origin && hit.origin !== location.origin) {
    location.href = `${hit.origin}/?key=${encodeURIComponent(hit.key)}`;
    return;
  }
  accessKeyInput.value = hit.key;
  loginForm.requestSubmit();
}

qrOpenBtn.addEventListener('click', () => void openQrScan());
$('qr-close').addEventListener('click', closeQrScan);

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

  // Actions (#4 paste/copy, #6 search) work off the active pane's buffer, so
  // they run even for a dead pane (search) — handle them before the live guard.
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
// the *active* pane. Typing jumps to the next match; ↑/↓ (or Shift+Enter/Enter)
// cycle; Esc/✕ closes and returns focus to the terminal.
const termSearch = $('term-search');
const termSearchInput = $('term-search-input') as HTMLInputElement;

function openTermSearch(): void {
  if (!active) return;   // nothing to search without an open session
  switchView('term');
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
  for (const t of panes) {
    t.term.options.fontSize = termSettings.fontSize;
    (t.term.options as any).theme = { ...TERM_THEMES[termSettings.theme] };
    // Softens the window chrome (titlebar) around a light terminal — see the
    // `.term-window:has(.xterm-light)` rule in style.css.
    t.term.element?.classList.toggle('xterm-light', light);
  }
  // Only the active pane is visible; xterm can't measure a display:none host, so
  // fitting hidden panes is both wrong and pointless (they refit on activate()).
  // Looping fitSoon() over every pane would also clobber its shared timer and
  // leave the active pane unfitted after a font change.
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
      switchView('term');
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

// ── Home: the session list ──────────────────────────────────────────────
// Every live pty on the host (via term.list), so you can see and attach the
// sessions you left running — even from a device that never opened them. Each
// row shows the running program (from the pty's OSC title), its cwd and how long
// it has been idle. Tapping opens the full-screen terminal for it: focusing the
// pane if this browser already has one, otherwise attaching and replaying the
// scrollback.
const sessionsList = $('sessions-list');

type SessionInfo = { termId: string; shell: string; cwd: string; title?: string; lastActivity?: number };

/** Last list we rendered, so a local kill can repaint without a round-trip. */
let lastSessions: SessionInfo[] = [];

function idleLabel(lastActivity?: number): string {
  if (!lastActivity) return '';
  const ms = Date.now() - lastActivity;
  if (ms < 60_000) return 'active';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `idle ${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `idle ${hr}h`;
  return `idle ${Math.floor(hr / 24)}d`;
}

function makeSessionRow(info: SessionInfo): HTMLElement {
  const row = document.createElement('div');
  row.className = 'session-row';

  const shellName = shellBaseName(info.shell);
  const existing = byTermId(info.termId);
  // A pane already open here knows the live program from xterm's own title
  // events; for the rest the agent's captured OSC title is the only source.
  const prog = existing?.program
    || (info.title && programFromTitle(info.title, shellName))
    || shellName;

  const open = document.createElement('button');
  open.className = 'session-open';

  const name = document.createElement('span');
  name.className = 'session-name';
  name.textContent = prog;

  const meta = document.createElement('span');
  meta.className = 'session-meta';
  const bits = [cwdTail(info.cwd) || '~', idleLabel(info.lastActivity)].filter(Boolean);
  if (existing) bits.push('open here');
  meta.textContent = bits.join(' · ');

  open.append(name, meta);
  open.addEventListener('click', () => {
    const pane = byTermId(info.termId);
    if (pane) { openPane(pane); return; }
    open.disabled = true;   // the attach round-trips; don't stack duplicates
    void attachToTerm(info).then((ok) => {
      open.disabled = false;
      const opened = byTermId(info.termId);
      if (ok && opened) openPane(opened);
      else void refreshSessions();   // the row was stale — repaint what is real
    });
  });

  const kill = document.createElement('button');
  kill.className = 'session-kill';
  kill.textContent = '✕';
  kill.title = 'Close this session';
  kill.setAttribute('aria-label', `Close ${prog}`);
  kill.addEventListener('click', () => void killSession(info));

  row.append(open, kill);
  return row;
}

/** Kill a pty from Home — whether or not this browser has a pane for it. */
async function killSession(info: SessionInfo): Promise<void> {
  const pane = byTermId(info.termId);
  if (pane) { closePane(pane); return; }
  send({ type: 'term.close', id: `close${++reqSeq}`, termId: info.termId });
  lastSessions = lastSessions.filter(s => s.termId !== info.termId);
  renderSessions(lastSessions);
}

function renderSessions(list: SessionInfo[]): void {
  lastSessions = list;
  sessionsList.innerHTML = '';
  if (list.length === 0) {
    const el = document.createElement('div');
    el.className = 'session-empty';
    el.textContent = 'No sessions running. Start one with ＋ New session.';
    sessionsList.appendChild(el);
    return;
  }
  // Most-recently-active first.
  const sorted = [...list].sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  for (const info of sorted) sessionsList.appendChild(makeSessionRow(info));
}

async function refreshSessions(): Promise<void> {
  if (!isConnected()) { renderSessions([]); return; }
  try {
    const res = await rpc<{ terms?: SessionInfo[] }>({ type: 'term.list' });
    renderSessions(res.terms ?? []);
  } catch {
    sessionsList.innerHTML = '<div class="session-empty">Could not load sessions</div>';
  }
}

$('sessions-refresh').addEventListener('click', () => void refreshSessions());

// While Home is on screen, re-poll so idle labels age and sessions started
// elsewhere show up without a manual refresh. Paused everywhere else (and while
// the page is hidden) so a backgrounded phone isn't chattering at the relay.
window.setInterval(() => {
  if (currentView === 'home' && !document.hidden && isConnected()) void refreshSessions();
}, 10_000);

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
