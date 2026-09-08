import './style.css';
import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

// One WS to the relay; multiple terminal tabs multiplexed over it by termId.

const PROTOCOL_VERSION = 1;

interface Tab {
  termId: string;
  name: string;
  term: Terminal;
  fit: FitAddon;
  host: HTMLElement;
  tabEl: HTMLElement;
  dead: boolean;
  openId: string;
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

let ws: WebSocket | null = null;
let tabs: Tab[] = [];
let active: Tab | null = null;
let reqSeq = 0;
const pendingOpens = new Map<string, (termId: string | null) => void>();
let reconnectTimer: number | undefined;

// Pre-fill ?key= from the agent's printed URL.
const urlKey = new URLSearchParams(location.search).get('key');
if (urlKey) accessKeyInput.value = urlKey.toUpperCase();

function connect(accessKey: string): void {
  setStatus('off');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    send({ type: 'hello.client', accessKey, protocol: PROTOCOL_VERSION });
  };

  ws.onmessage = (ev) => {
    let frame: any;
    try { frame = JSON.parse(ev.data as string); } catch { return; }
    handle(frame);
  };

  ws.onclose = () => {
    setStatus('off');
    ws = null;
    markAllDead('disconnected');
    // The access key was one-time; go back to login rather than looping.
    showLogin('Connection closed. Get a new access key from the agent.');
  };

  ws.onerror = () => { /* onclose follows */ };
}

function send(frame: object): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

function handle(frame: any): void {
  switch (frame.type) {
    case 'hello.res':
      if (frame.ok) {
        setStatus('on');
        showApp();
        if (tabs.length === 0) void newTab();
      } else {
        showLogin(frame.error ?? 'rejected');
      }
      return;

    case 'term.open.res': {
      const cb = pendingOpens.get(frame.id);
      if (!cb) return;
      pendingOpens.delete(frame.id);
      if (frame.ok) cb(frame.termId);
      else {
        cb(null);
        showLogin(frame.error ?? 'could not open terminal');
      }
      return;
    }

    case 'term.data': {
      const tab = byTermId(frame.termId);
      if (tab) tab.term.write(frame.data);
      return;
    }

    case 'term.exit': {
      const tab = byTermId(frame.termId);
      if (tab) {
        tab.dead = true;
        tab.tabEl.classList.add('dead');
        tab.term.write(`\r\n\x1b[90m[process exited${frame.code != null ? ` code ${frame.code}` : ''}]\x1b[0m\r\n`);
      }
      return;
    }

    case 'peer.gone':
      markAllDead('agent offline');
      setStatus('off');
      return;
  }
}

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
}

async function newTab(): Promise<void> {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const id = `open${++reqSeq}`;

  const term = new Terminal({
    fontFamily: 'ui-monospace, Consolas, "Cascadia Mono", monospace',
    fontSize: 14,
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: '#101418', foreground: '#d7dde4', cursor: '#4ea1ff' },
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
  x.title = 'Close';
  tabEl.append(label, x);
  tabsEl.appendChild(tabEl);

  const tab: Tab = {
    termId: '', name: label.textContent!, term, fit, host, tabEl,
    dead: false, openId: id,
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

  await new Promise<void>((res) => {
    pendingOpens.set(id, (termId) => {
      if (termId) {
        tab.termId = termId;
        sendResize(tab);
      } else {
        closeTab(tab, true);
      }
      res();
    });
    send({ type: 'term.open', id, cols: term.cols, rows: term.rows });
  });
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
  if (tabs.length === 0 && ws?.readyState === WebSocket.OPEN) void newTab();
}

newTabBtn.addEventListener('click', () => void newTab());

window.addEventListener('resize', () => { if (active) fitSoon(active); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && active) fitSoon(active);
});

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const key = accessKeyInput.value.trim().toUpperCase();
  if (!key) return;
  loginError.hidden = true;
  loginForm.querySelector('button')!.setAttribute('disabled', '');
  connect(key);
  setTimeout(() => loginForm.querySelector('button')!.removeAttribute('disabled'), 1500);
});

// ── Mobile modifier keys ──────────────────────────────────────────────
// Sticky modifiers: tap Ctrl, then type → sends \x1b-ish control bytes via
// xterm's attachCustomKeyEventHandler is not needed; we inject sequences
// directly for the seq buttons and hold modifiers for the next real key.
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

// Apply held Ctrl to the next keystroke typed on the soft keyboard.
document.addEventListener('keydown', (e) => {
  if (!active || heldModifiers.size === 0) return;
  if (e.key.length === 1 && heldModifiers.has('Control')) {
    const code = e.key.toUpperCase().charCodeAt(0) - 64; // Ctrl+A → 1
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
