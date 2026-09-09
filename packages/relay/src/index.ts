import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { readFileSync, watch } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { decode } from '@kremote/shared';
import { Relay, type Peer } from './relay.ts';
import { ConnectionGuard } from './guard.ts';
import { Store } from './store.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = resolve(__dirname, '../public');

const HOST = process.env.KREMOTE_RELAY_HOST ?? '127.0.0.1';
const PORT = Number(process.env.KREMOTE_RELAY_PORT ?? 8787);

// ── Abuse-guard + transport knobs (env-tunable, safe defaults) ─────────────
const num = (v: string | undefined, d: number) => (v === undefined ? d : Number(v));
const guard = new ConnectionGuard({
  maxConnsPerIp: num(process.env.KREMOTE_MAX_CONNS_PER_IP, 20),
  maxTotalConns: num(process.env.KREMOTE_MAX_CONNS, 200),
  authFailMax: num(process.env.KREMOTE_AUTH_FAIL_MAX, 10),
  authFailWindowMs: num(process.env.KREMOTE_AUTH_FAIL_WINDOW_MS, 60_000),
  blockMs: num(process.env.KREMOTE_BLOCK_MS, 300_000),
});
// ws default maxPayload is 100 MiB — far more than any legit frame. Cap it well
// above MAX_GIT_DIFF_BYTES (2 MB) after JSON-escaping headroom. 8 MB by default.
const MAX_PAYLOAD = num(process.env.KREMOTE_MAX_PAYLOAD, 8 * 1024 * 1024);
// Close un-authed sockets that never send a valid hello (slowloris / leak).
const HELLO_TIMEOUT_MS = num(process.env.KREMOTE_HELLO_TIMEOUT_MS, 10_000);

// Reject reasons (from relay.ts) that indicate credential guessing and should
// count toward a brute-force block. Everything else (agent offline, protocol
// mismatch, session cap) is logged but never locks out an honest user.
const CREDENTIAL_FAILURES = new Set(['invalid or expired access key', 'session expired']);

// ── Structured audit log (one line per security event) ─────────────────────
function log(event: string, fields: Record<string, string | number | boolean> = {}) {
  const parts = [`[relay]`, new Date().toISOString(), event];
  for (const [k, v] of Object.entries(fields)) parts.push(`${k}=${v}`);
  console.log(parts.join(' '));
}

const store = await Store.load();
const relay = new Relay(store);

// Correlate a peer's IP for the (IP-agnostic) 'rejected' event emitted by Relay.
const peerIp = new Map<string, string>();

const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...relay.stats, guard: guard.stats }));
    return;
  }
  void serveStatic(req.url ?? '/', res);
};

// ── TLS: terminate in Node when cert/key paths are provided ────────────────
// Phone → wss:// relay directly (no reverse proxy), so the client IP is the
// real socket address. Let's Encrypt renews ~every 60 days; hot-reload the
// cert via setSecureContext so renewal needs no restart.
const CERT_PATH = process.env.KREMOTE_TLS_CERT;
const KEY_PATH = process.env.KREMOTE_TLS_KEY;
let server: HttpsServer | ReturnType<typeof createHttpServer>;
let tls = false;

if (CERT_PATH && KEY_PATH) {
  const https = createHttpsServer(
    { cert: readFileSync(CERT_PATH), key: readFileSync(KEY_PATH) },
    handler,
  );
  server = https;
  tls = true;
  // Debounced reload: a renewal rewrites both files; a half-written cert must
  // not crash the process, so wrap the swap in try/catch.
  let reloadTimer: NodeJS.Timeout | undefined;
  const reload = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      try {
        https.setSecureContext({ cert: readFileSync(CERT_PATH), key: readFileSync(KEY_PATH) });
        log('tls-reload', { cert: CERT_PATH });
      } catch (e) {
        log('tls-reload-failed', { error: String((e as Error).message ?? e) });
      }
    }, 1_000);
  };
  for (const p of [CERT_PATH, KEY_PATH]) {
    try { watch(p, reload); } catch { /* file may be a symlink dir; best-effort */ }
  }
} else {
  server = createHttpServer(handler);
}

async function serveStatic(urlPath: string, res: import('node:http').ServerResponse) {
  // Path-traversal guard: resolve inside PUBLIC_DIR, reject escapes.
  const rel = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  let file = join(PUBLIC_DIR, rel === '/' || rel === '\\' ? 'index.html' : rel);
  file = resolve(file);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  try {
    const body = await readFile(file);
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  } catch {
    // SPA fallback
    try {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(await readFile(join(PUBLIC_DIR, 'index.html')));
    } catch {
      res.writeHead(404); res.end('not found');
    }
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_PAYLOAD });
let seq = 0;

wss.on('connection', (ws: WebSocket, req: import('node:http').IncomingMessage) => {
  const ip = req.socket.remoteAddress ?? '';

  // Gate before doing any work: temporary block, per-IP cap, or global cap.
  const gate = guard.canConnect(ip, Date.now());
  if (!gate.ok) {
    log('refuse', { ip, reason: gate.reason ?? 'unknown' });
    try { ws.close(1013, 'try later'); } catch { /* already closing */ }
    return;
  }
  guard.onConnect(ip);

  const peer: Peer = {
    id: `p${++seq}_${Date.now().toString(36)}`,
    send: (data) => { if (ws.readyState === ws.OPEN) ws.send(data); },
    close: (code, reason) => { try { ws.close(code ?? 1000, reason); } catch {} },
  };
  peerIp.set(peer.id, ip);
  let authed = false;

  // Un-authed sockets get a deadline: send a valid hello or get dropped.
  let helloTimer: NodeJS.Timeout | undefined = setTimeout(() => {
    if (!authed) {
      log('hello-timeout', { ip, peer: peer.id });
      try { ws.close(4008, 'hello timeout'); } catch {}
    }
  }, HELLO_TIMEOUT_MS);
  helloTimer.unref?.();
  const clearHello = () => { if (helloTimer) { clearTimeout(helloTimer); helloTimer = undefined; } };

  ws.on('message', (raw) => {
    const text = raw.toString();
    if (!authed) {
      relay.handleHello(peer, text);
      // If hello succeeded the relay sent hello.res{ok:true} on this peer.
      authed = relay.isAgent(peer.id) || relay.isPairedClient(peer.id) || relay.hasClient(peer.id);
      if (!authed) return;
      clearHello();
      guard.recordAuthSuccess(ip); // honest login clears any failure history
    }

    // accesskey.req is a relay-handled control frame from the agent.
    let frame;
    try { frame = decode(text); } catch { return; }
    if (frame.type === 'accesskey.req' && relay.isAgent(peer.id)) {
      const out = relay.handleAccessKeyReq(peer, frame.id);
      if (out) {
        peer.send(JSON.stringify({ type: 'accesskey.res', id: frame.id, ...out }));
      } else {
        peer.send(JSON.stringify({ type: 'accesskey.res', id: frame.id, key: '', url: '', expiresMs: 0, error: 'not a device' }));
      }
      return;
    }
    relay.handleFrame(peer, text);
  });

  const onGone = () => {
    clearHello();
    guard.onDisconnect(ip);
    peerIp.delete(peer.id);
    relay.handleClose(peer);
  };
  ws.on('close', onGone);
  ws.on('error', onGone);
});

// Relay reports every hello rejection (IP-agnostic); classify it here. Only
// credential guesses count toward a brute-force block — not "agent offline".
relay.on('rejected', (peerId: string, reason: string) => {
  const ip = peerIp.get(peerId) ?? '';
  if (CREDENTIAL_FAILURES.has(reason)) {
    const { blocked } = guard.recordAuthFailure(ip, Date.now());
    log('auth-fail', { ip, reason, blocked });
    if (blocked) log('block', { ip, forMs: num(process.env.KREMOTE_BLOCK_MS, 300_000) });
  } else {
    log('reject', { ip, reason });
  }
});

relay.on('agent-connected', (d) => log('agent-online', { device: d }));
relay.on('agent-disconnected', (d) => log('agent-offline', { device: d }));
relay.on('paired', (d) => log('paired', { device: d }));

const sweeper = setInterval(() => { const now = Date.now(); relay.tick(now); guard.sweep(now); }, 30_000);
sweeper.unref();

server.listen(PORT, HOST, () => {
  const scheme = tls ? 'https' : 'http';
  console.log(`[relay] listening on ${scheme}://${HOST}:${PORT} (ws path /ws)${tls ? ' [TLS]' : ''}`);
  console.log(`[relay] devices registered: ${store.devices.length}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { console.log(`\n[relay] ${sig}`); clearInterval(sweeper); server.close(() => process.exit(0)); });
}
