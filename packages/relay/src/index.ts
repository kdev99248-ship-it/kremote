import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { decode } from '@kremote/shared';
import { Relay, type Peer } from './relay.ts';
import { Store } from './store.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = resolve(__dirname, '../public');

const HOST = process.env.KREMOTE_RELAY_HOST ?? '127.0.0.1';
const PORT = Number(process.env.KREMOTE_RELAY_PORT ?? 8787);

const store = await Store.load();
const relay = new Relay(store);

const http = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...relay.stats }));
    return;
  }
  void serveStatic(req.url ?? '/', res);
});

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

const wss = new WebSocketServer({ server: http, path: '/ws' });
let seq = 0;

wss.on('connection', (ws: WebSocket) => {
  const peer: Peer = {
    id: `p${++seq}_${Date.now().toString(36)}`,
    send: (data) => { if (ws.readyState === ws.OPEN) ws.send(data); },
    close: (code, reason) => { try { ws.close(code ?? 1000, reason); } catch {} },
  };
  let authed = false;

  ws.on('message', (raw) => {
    const text = raw.toString();
    if (!authed) {
      relay.handleHello(peer, text);
      // If hello succeeded the relay sent hello.res{ok:true} on this peer.
      authed = relay.isAgent(peer.id) || relay.isPairedClient(peer.id) || relay.hasClient(peer.id);
      if (!authed) return;
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

  ws.on('close', () => relay.handleClose(peer));
  ws.on('error', () => relay.handleClose(peer));
});

relay.on('agent-connected', (d) => console.log(`[relay] agent online: ${d}`));
relay.on('agent-disconnected', (d) => console.log(`[relay] agent offline: ${d}`));
relay.on('paired', (d) => console.log(`[relay] paired client → ${d}`));

const sweeper = setInterval(() => relay.tick(), 30_000);
sweeper.unref();

http.listen(PORT, HOST, () => {
  console.log(`[relay] listening on http://${HOST}:${PORT} (ws path /ws)`);
  console.log(`[relay] devices registered: ${store.devices.length}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { console.log(`\n[relay] ${sig}`); clearInterval(sweeper); http.close(() => process.exit(0)); });
}
