// Abuse guard: connection caps + brute-force lockout, keyed by client IP.
// Pure and transport-agnostic (no `ws`/socket types) with an injectable clock,
// so it unit-tests with a fake `now` like Relay.tick(now). The transport layer
// (index.ts) owns the socket and feeds IPs in; Relay itself never sees an IP.

export interface GuardConfig {
  maxConnsPerIp?: number;    // default 20 — concurrent sockets from one IP
  maxTotalConns?: number;    // default 200 — concurrent sockets overall
  authFailMax?: number;      // default 10 — credential failures per window → block
  authFailWindowMs?: number; // default 60_000 — sliding window for failures
  blockMs?: number;          // default 300_000 — how long a blocked IP stays out
}

const DEFAULTS: Required<GuardConfig> = {
  maxConnsPerIp: 20,
  maxTotalConns: 200,
  authFailMax: 10,
  authFailWindowMs: 60_000,
  blockMs: 300_000,
};

export type RefuseReason = 'blocked' | 'per-ip' | 'global';

/**
 * Normalize a raw socket address to the key we count/block on:
 *  - strip an IPv6 zone id (`fe80::1%eth0` → `fe80::1`),
 *  - unwrap IPv4-mapped IPv6 (`::ffff:1.2.3.4` → `1.2.3.4`),
 *  - collapse IPv6 to its /64 prefix — a single host owns a whole /64, so
 *    blocking /128 is useless (the attacker just rotates the low bits).
 */
export function ipKey(ip: string): string {
  if (!ip) return 'unknown';
  let s = ip.trim();
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);

  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(s);
  if (mapped) return mapped[1];
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s)) return s;

  if (s.includes(':')) {
    const groups = expandIpv6(s);
    if (groups) return groups.slice(0, 4).join(':') + '::/64';
    return s.toLowerCase(); // unparseable — key on the literal, still bounded
  }
  return s;
}

/** Expand an IPv6 address to 8 normalized hextets, or null if malformed. */
function expandIpv6(s: string): string[] | null {
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;

  let groups: string[];
  if (tail === null) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  }
  const out: string[] = [];
  for (const g of groups) {
    if (g === '') { out.push('0'); continue; }
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16).toString(16));
  }
  return out;
}

export class ConnectionGuard {
  private cfg: Required<GuardConfig>;
  private perIp = new Map<string, number>(); // active socket count by ipKey
  private total = 0;                          // active socket count overall
  private fails = new Map<string, number[]>(); // recent failure timestamps by ipKey
  private blocks = new Map<string, number>();  // ipKey → block-until epoch ms

  constructor(cfg: GuardConfig = {}) {
    this.cfg = { ...DEFAULTS, ...cfg };
  }

  /** Gate a new socket before it does anything. Does not mutate counts. */
  canConnect(ip: string, now = Date.now()): { ok: boolean; reason?: RefuseReason } {
    const key = ipKey(ip);
    const until = this.blocks.get(key);
    if (until !== undefined) {
      if (until > now) return { ok: false, reason: 'blocked' };
      this.blocks.delete(key); // expired
    }
    if (this.total >= this.cfg.maxTotalConns) return { ok: false, reason: 'global' };
    if ((this.perIp.get(key) ?? 0) >= this.cfg.maxConnsPerIp) return { ok: false, reason: 'per-ip' };
    return { ok: true };
  }

  /** Count an accepted socket. Pair with exactly one onDisconnect. */
  onConnect(ip: string): void {
    const key = ipKey(ip);
    this.perIp.set(key, (this.perIp.get(key) ?? 0) + 1);
    this.total++;
  }

  onDisconnect(ip: string): void {
    const key = ipKey(ip);
    const n = this.perIp.get(key) ?? 0;
    if (n <= 1) this.perIp.delete(key); else this.perIp.set(key, n - 1);
    if (this.total > 0) this.total--;
  }

  /**
   * Record a credential-guess failure. Only genuine brute-force signals should
   * be fed here (bad/expired access key, expired session) — not "agent offline"
   * or protocol errors, which would lock out honest users. Returns whether this
   * failure tipped the IP into a temporary block.
   */
  recordAuthFailure(ip: string, now = Date.now()): { blocked: boolean } {
    const key = ipKey(ip);
    const cutoff = now - this.cfg.authFailWindowMs;
    const recent = (this.fails.get(key) ?? []).filter(t => t > cutoff);
    recent.push(now);
    if (recent.length >= this.cfg.authFailMax) {
      this.blocks.set(key, now + this.cfg.blockMs);
      this.fails.delete(key);
      return { blocked: true };
    }
    this.fails.set(key, recent);
    return { blocked: false };
  }

  /** A successful auth clears the IP's failure history (but not an active block). */
  recordAuthSuccess(ip: string): void {
    this.fails.delete(ipKey(ip));
  }

  isBlocked(ip: string, now = Date.now()): boolean {
    const key = ipKey(ip);
    const until = this.blocks.get(key);
    if (until === undefined) return false;
    if (until <= now) { this.blocks.delete(key); return false; }
    return true;
  }

  /** Periodic cleanup: drop stale failure windows and expired blocks. */
  sweep(now = Date.now()): void {
    const cutoff = now - this.cfg.authFailWindowMs;
    for (const [key, arr] of this.fails) {
      const kept = arr.filter(t => t > cutoff);
      if (kept.length === 0) this.fails.delete(key); else this.fails.set(key, kept);
    }
    for (const [key, until] of this.blocks) {
      if (until <= now) this.blocks.delete(key);
    }
  }

  get stats() {
    return {
      activeIps: this.perIp.size,
      totalConns: this.total,
      trackedFailIps: this.fails.size,
      blockedIps: this.blocks.size,
    };
  }
}
