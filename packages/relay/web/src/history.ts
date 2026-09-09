/**
 * Command history (#6): every line submitted through sendInput() is recorded
 * here (deduped, most-recent-first, capped). The UI panel lists matches for a
 * search box; tapping an entry sends it to the active terminal.
 */

const KEY = 'kremote.history';
const MAX = 500;

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
