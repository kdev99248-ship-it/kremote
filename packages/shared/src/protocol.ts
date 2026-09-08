// Wire protocol: one WebSocket per paired agent↔client.
// JSON frames {type, id?, ...payload}. Requests carry `id`; responses echo it.
// Control frames (pairing/auth) are relay↔peer only and never forwarded.

// ── Lifecycle ────────────────────────────────────────────────────────────
export interface TermOpenReq {
  type: 'term.open';
  id: string;
  shell?: string; // default: powershell.exe on Windows
  cols?: number;
  rows?: number;
  cwd?: string;
}
export interface TermOpenRes { type: 'term.open.res'; id: string; termId: string; ok: true }
export interface TermOpenErr { type: 'term.open.res'; id: string; ok: false; error: string }

export interface TermCloseReq { type: 'term.close'; id: string; termId: string }
export interface TermCloseRes { type: 'term.close.res'; id: string; ok: boolean }

export interface TermListReq { type: 'term.list'; id: string }
export interface TermListRes {
  type: 'term.list.res'; id: string;
  terms: { termId: string; shell: string; cwd: string }[];
}

// ── Terminal stream (no id: fire-and-forget) ─────────────────────────────
export interface TermData { type: 'term.data'; termId: string; data: string }   // agent→client
export interface TermInput { type: 'term.input'; termId: string; data: string } // client→agent
export interface TermResize { type: 'term.resize'; termId: string; cols: number; rows: number }
export interface TermExit { type: 'term.exit'; termId: string; code: number | null } // agent→client

// ── Auth / pairing (relay↔peer control frames) ───────────────────────────
export interface HelloAgent {
  type: 'hello.agent';
  deviceKey: string;
  protocol: number;
}
export interface HelloClient {
  type: 'hello.client';
  accessKey: string;
  protocol: number;
}
export interface HelloRes { type: 'hello.res'; ok: boolean; error?: string }

// Relay→agent only: mint a one-time ACCESS_KEY for the browser.
export interface AccessKeyReq { type: 'accesskey.req'; id: string }
export interface AccessKeyRes { type: 'accesskey.res'; id: string; key: string; url: string; expiresMs: number }

export interface PeerGone { type: 'peer.gone' } // relay→ remaining peer when the other side drops

// ── App frames ───────────────────────────────────────────────────────────
export type ClientToAgent =
  | TermOpenReq | TermCloseReq | TermListReq
  | TermInput | TermResize;

export type AgentToClient =
  | TermOpenRes | TermOpenErr | TermCloseRes | TermListRes
  | TermData | TermExit;

export type AnyFrame =
  | ClientToAgent | AgentToClient
  | HelloAgent | HelloClient | HelloRes
  | AccessKeyReq | AccessKeyRes | PeerGone;

export const PROTOCOL_VERSION = 1;

export function encode(frame: AnyFrame): string {
  return JSON.stringify(frame);
}

export function decode(raw: string | Buffer): AnyFrame {
  const s = typeof raw === 'string' ? raw : raw.toString('utf8');
  const obj = JSON.parse(s);
  if (obj === null || typeof obj !== 'object' || typeof obj.type !== 'string') {
    throw new Error('frame missing `type`');
  }
  return obj as AnyFrame;
}
