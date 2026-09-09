/**
 * Detects a "clear screen" in a ConPTY output chunk.
 *
 * Windows `cls`/`clear` erases the viewport but never the scrollback: ConPTY
 * sends either `ESC[2J`, or (measured on PS 5.1/7 over ConPTY on Win10 19045)
 * `ESC[H` followed by a burst of `ESC[K` line-erases — and no `ESC[3J` ever
 * arrives. The web terminal appends a real `ESC[3J` when either shape is seen,
 * so "clear" genuinely leaves a blank screen instead of just scrolling.
 *
 * The full clear burst is far below ConPTY's ~4 KB chunk limit, so it always
 * arrives inside one `term.data` frame (verified with a live ConPTY probe).
 */
export function looksLikeClear(s: string): boolean {
  if (s.includes('\x1b[2J')) return true;
  if (!s.includes('\x1b[H')) return false;
  return (s.match(/\x1b\[K/g) ?? []).length >= 3;
}
