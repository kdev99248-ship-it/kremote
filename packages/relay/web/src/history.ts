/**
 * Command history (#6): every line submitted through sendInput() is recorded
 * here (deduped, most-recent-first, capped). The UI panel lists matches for a
 * search box; tapping an entry sends it to the active terminal.
 *
 * Snippets / pins (#5) layer on top: a small hand-curated set of favourite
 * commands, kept separately so they survive history eviction and always show
 * (independent of the history search box).
 */

const KEY = 'kremote.history';
const PINS_KEY = 'kremote.pins';
const MAX = 500;
const MAX_PINS = 100;

export function readHistory(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
  } catch { return []; }
}

export function addHistory(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) return readHistory();
  let h = readHistory();
  // Most-recent-first; drop older duplicates of this exact line.
  h = [trimmed, ...h.filter(x => x !== trimmed)].slice(0, MAX);
  try { localStorage.setItem(KEY, JSON.stringify(h)); } catch { /* private mode */ }
  return h;
}

export function clearHistory(): void {
  try { localStorage.removeItem(KEY); } catch { /* private mode */ }
}

/** Case-insensitive substring search, most recent first. Empty query = all. */
export function searchHistory(query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return readHistory();
  return readHistory().filter(x => x.toLowerCase().includes(q));
}

// ── Pinned commands / snippets (#5) ─────────────────────────────────────
export function readPins(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(PINS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
  } catch { return []; }
}

export function isPinned(line: string): boolean {
  return readPins().includes(line.trim());
}

/** Pin an un-pinned line (newest first) or unpin a pinned one. Returns the set. */
export function togglePin(line: string): string[] {
  const t = line.trim();
  if (!t) return readPins();
  const p = readPins();
  const next = p.includes(t) ? p.filter(x => x !== t) : [t, ...p].slice(0, MAX_PINS);
  try { localStorage.setItem(PINS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  return next;
}
