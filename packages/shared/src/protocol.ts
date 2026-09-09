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
export interface TermOpenRes { type: 'term.open.res'; id: string; termId: string; ok: true; cwd: string; shell: string }
export interface TermOpenErr { type: 'term.open.res'; id: string; ok: false; error: string }

export interface TermCloseReq { type: 'term.close'; id: string; termId: string }
export interface TermCloseRes { type: 'term.close.res'; id: string; ok: boolean }

export interface TermListReq { type: 'term.list'; id: string }
export interface TermListRes {
  type: 'term.list.res'; id: string;
  terms: { termId: string; shell: string; cwd: string }[];
}

// Reattach to a terminal that outlived the browser (reconnect): the agent
// resizes the pty to the new viewport and replays its scrollback buffer.
export interface TermAttachReq { type: 'term.attach'; id: string; termId: string; cols?: number; rows?: number }
export interface TermAttachRes { type: 'term.attach.res'; id: string; ok: true; termId: string; data: string; cwd: string; shell: string }
export interface TermAttachErr { type: 'term.attach.res'; id: string; ok: false; error: string }

// ── Terminal stream (no id: fire-and-forget) ─────────────────────────────
export interface TermData { type: 'term.data'; termId: string; data: string }   // agent→client
export interface TermInput { type: 'term.input'; termId: string; data: string } // client→agent
export interface TermResize { type: 'term.resize'; termId: string; cols: number; rows: number }
export interface TermExit { type: 'term.exit'; termId: string; code: number | null } // agent→client

// ── Auth / pairing (relay↔peer control frames) ───────────────────────────
export interface HelloAgent {
  type: 'hello.agent';
  // Empty deviceKey + register:true = zero-touch enrollment: the relay mints a
  // DEVICE_KEY and returns it (once) in hello.res{deviceKey}. The agent saves
  // it to its config and reconnects as a fully-paired device. The enrollment
  // window is capped by the relay's maxDevices (default 1) so a fresh relay
  // accepts exactly its owner's first agent, then closes to strangers.
  deviceKey?: string;
  register?: boolean;
  label?: string;
  protocol: number;
}
// A browser authenticates with a one-time ACCESS_KEY on first login, or with a
// durable SESSION token on silent reconnect (persistent login). Exactly one is
// expected; the session token wins if both are present.
export interface HelloClient {
  type: 'hello.client';
  accessKey?: string;
  session?: string;
  protocol: number;
}
// On success the relay returns the durable session token so the browser can
// persist it and reconnect silently later. For a zero-touch agent enrollment
// (hello.agent{register:true}) it also returns the newly minted DEVICE_KEY —
// exactly once, only to the registering socket.
export interface HelloRes {
  type: 'hello.res';
  ok: boolean;
  error?: string;
  session?: string;
  deviceKey?: string;
  deviceId?: string;
}

// Relay→agent only: mint a one-time ACCESS_KEY for the browser.
export interface AccessKeyReq { type: 'accesskey.req'; id: string }
export interface AccessKeyRes { type: 'accesskey.res'; id: string; key: string; url: string; expiresMs: number }

export interface PeerGone { type: 'peer.gone' } // relay→ remaining peer when the other side drops
export interface PeerBack { type: 'peer.back' } // relay→ client when its agent reconnects (re-paired)

// ── Files ────────────────────────────────────────────────────────────────
// All `path` arguments are relative to the agent's configured root; the agent
// resolves them through the path-traversal guard and rejects escapes.
// `mtimeMs` is the conflict token: the editor sends back the value it read,
// and a write whose mtime no longer matches is rejected.

export type EntryKind = 'file' | 'dir' | 'symlink' | 'other';

export interface FsEntry {
  name: string;
  kind: EntryKind;
  size: number;      // 0 for dirs
  mtimeMs: number;
}

export interface FsListReq { type: 'fs.list'; id: string; path: string }
export interface FsListRes { type: 'fs.list.res'; id: string; ok: true; path: string; entries: FsEntry[] }
export interface FsListErr { type: 'fs.list.res'; id: string; ok: false; error: string }

export interface FsReadReq { type: 'fs.read'; id: string; path: string }
export interface FsReadRes { type: 'fs.read.res'; id: string; ok: true; path: string; content: string; mtimeMs: number; size: number; truncated: boolean }
export interface FsReadErr { type: 'fs.read.res'; id: string; ok: false; error: string }

export interface FsWriteReq { type: 'fs.write'; id: string; path: string; content: string; baseMtimeMs?: number }
export interface FsWriteRes { type: 'fs.write.res'; id: string; ok: true; path: string; mtimeMs: number }
export interface FsWriteErr { type: 'fs.write.res'; id: string; ok: false; error: string; conflict?: boolean; serverMtimeMs?: number }

export interface FsMkdirReq { type: 'fs.mkdir'; id: string; path: string }
export interface FsMkdirRes { type: 'fs.mkdir.res'; id: string; ok: boolean; error?: string }

export interface FsRenameReq { type: 'fs.rename'; id: string; from: string; to: string }
export interface FsRenameRes { type: 'fs.rename.res'; id: string; ok: boolean; error?: string }

export interface FsDeleteReq { type: 'fs.delete'; id: string; path: string; recursive?: boolean }
export interface FsDeleteRes { type: 'fs.delete.res'; id: string; ok: boolean; error?: string }

// ── Git ──────────────────────────────────────────────────────────────────
// `repo` is a directory inside root; every git command runs with cwd = repo.

export interface GitStatusReq { type: 'git.status'; id: string; repo: string }
export interface GitStatusRes {
  type: 'git.status.res'; id: string; ok: true; repo: string;
  branch: string;
  ahead: number; behind: number;
  files: { path: string; index: string; worktree: string }[];
}
export interface GitStatusErr { type: 'git.status.res'; id: string; ok: false; error: string }

export interface GitDiffReq { type: 'git.diff'; id: string; repo: string; staged?: boolean; path?: string }
export interface GitDiffRes { type: 'git.diff.res'; id: string; ok: true; diff: string }
export interface GitDiffErr { type: 'git.diff.res'; id: string; ok: false; error: string }

export interface GitCommitReq { type: 'git.commit'; id: string; repo: string; message: string; all?: boolean }
export interface GitCommitRes { type: 'git.commit.res'; id: string; ok: boolean; error?: string }

export interface GitPushReq { type: 'git.push'; id: string; repo: string }
export interface GitPushRes { type: 'git.push.res'; id: string; ok: boolean; error?: string }

export interface GitLogReq { type: 'git.log'; id: string; repo: string; limit?: number }
export interface GitLogRes {
  type: 'git.log.res'; id: string; ok: true;
  commits: { hash: string; author: string; date: string; subject: string }[];
}
export interface GitLogErr { type: 'git.log.res'; id: string; ok: false; error: string }

// ── Tail (live file follow) ──────────────────────────────────────────────
// The agent watches a file and streams appended bytes to the browser, like
// `tail -f`. `fromEnd` starts at EOF (only new lines arrive); otherwise the
// last chunk of the file is replayed first.

export interface TailWatchReq {
  type: 'tail.watch'; id: string; path: string; fromEnd?: boolean; lastBytes?: number
}
export interface TailWatchRes {
  type: 'tail.watch.res'; id: string; ok: true; watchId: string
}
export interface TailWatchErr { type: 'tail.watch.res'; id: string; ok: false; error: string }

// Fire-and-forget appended data (agent→client).
export interface TailData { type: 'tail.data'; watchId: string; chunk: string }

export interface TailUnwatchReq { type: 'tail.unwatch'; watchId: string }

// ── Limits (guardrails, not features) ────────────────────────────────────
export const MAX_WRITE_BYTES = 100 * 1024;         // 100 KB per fs.write
export const MAX_READ_BYTES = 10 * 1024 * 1024;    // 10 MB per fs.read
export const MAX_GIT_LOG = 200;
export const MAX_GIT_DIFF_BYTES = 2 * 1024 * 1024;
export const MAX_TAIL_WATCHES = 8;                 // concurrent tail.watch per agent
export const TAIL_LAST_BYTES = 64 * 1024;          // initial replay cap when not fromEnd

// ── App frames ───────────────────────────────────────────────────────────
export type ClientToAgent =
  | TermOpenReq | TermCloseReq | TermListReq | TermAttachReq
  | TermInput | TermResize
  | FsListReq | FsReadReq | FsWriteReq | FsMkdirReq | FsRenameReq | FsDeleteReq
  | GitStatusReq | GitDiffReq | GitCommitReq | GitPushReq | GitLogReq
  | TailWatchReq | TailUnwatchReq;

export type AgentToClient =
  | TermOpenRes | TermOpenErr | TermCloseRes | TermListRes | TermAttachRes | TermAttachErr
  | TermData | TermExit
  | FsListRes | FsListErr | FsReadRes | FsReadErr | FsWriteRes | FsWriteErr
  | FsMkdirRes | FsRenameRes | FsDeleteRes
  | GitStatusRes | GitStatusErr | GitDiffRes | GitDiffErr
  | GitCommitRes | GitPushRes | GitLogRes | GitLogErr
  | TailWatchRes | TailWatchErr | TailData;

export type AnyFrame =
  | ClientToAgent | AgentToClient
  | HelloAgent | HelloClient | HelloRes
  | AccessKeyReq | AccessKeyRes | PeerGone | PeerBack;

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
