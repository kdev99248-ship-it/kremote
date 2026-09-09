// WS connection to the relay: hello handshake, frame dispatch, and a small
// request/response RPC layer for id'd frames (fs.*, git.*, term.open...).

const PROTOCOL_VERSION = 1;

let ws: WebSocket | null = null;
let seq = 0;
let currentEv: ConnEvents | null = null;

const pending = new Map<string, {
  resType: string;
  resolve: (f: any) => void;
  reject: (e: Error) => void;
}>();

const handlers = new Map<string, ((f: any) => void)[]>();

export interface ConnEvents {
  onHelloOk: (session?: string) => void;
  onHelloErr: (msg: string) => void;
  onClosed: (msg: string) => void;
}

// Credentials: a one-time ACCESS_KEY on first login, or a durable SESSION token
// on silent reconnect. The relay accepts either.
export type Credential = { accessKey: string } | { session: string };

export function connect(cred: Credential, ev: ConnEvents): void {
  currentEv = ev;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => send({ type: 'hello.client', ...cred, protocol: PROTOCOL_VERSION });

  ws.onmessage = (e) => {
    let f: any;
    try { f = JSON.parse(e.data as string); } catch { return; }
    dispatch(f);
  };

  ws.onclose = () => {
    ws = null;
    for (const p of pending.values()) p.reject(new Error('disconnected'));
    pending.clear();
    ev.onClosed('Connection closed.');
  };

  ws.onerror = () => { /* onclose follows */ };
}

export function isConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

export function send(frame: object): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

/**
 * Send a request frame (an `id` is added) and resolve with its response —
 * the frame whose type is `${frame.type}.res` carrying the same id.
 * Resolves even when `ok === false`; the caller inspects the response.
 */
export function rpc<T = any>(frame: Record<string, unknown>, timeoutMs = 20000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!isConnected()) { reject(new Error('not connected')); return; }
    const id = `r${++seq}`;
    const resType = `${frame.type}.res`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${resType}`));
    }, timeoutMs);
    pending.set(id, {
      resType,
      resolve: (f) => { clearTimeout(timer); resolve(f); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    send({ ...frame, id });
  });
}

/** Register a handler for push-style frames (term.data, term.exit, peer.gone…). */
export function onFrame(type: string, h: (f: any) => void): void {
  let list = handlers.get(type);
  if (!list) { list = []; handlers.set(type, list); }
  list.push(h);
}

function dispatch(f: any): void {
  if (f.type === 'hello.res' && currentEv) {
    if (f.ok) currentEv.onHelloOk(f.session);
    else currentEv.onHelloErr(f.error ?? 'rejected');
    return;
  }
  if (typeof f.id === 'string') {
    const p = pending.get(f.id);
    if (p && f.type === p.resType) {
      pending.delete(f.id);
      p.resolve(f);
      return;
    }
  }
  for (const h of handlers.get(f.type) ?? []) h(f);
}
