import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeClear } from '../web/src/clear.ts';

// Shapes captured from a live ConPTY probe (PS 5.1 via `chcp 65001` wrapper,
// Windows 10 19045). 'cls' emits ESC[H x2 + ESC[K x30 in a single chunk.
const REAL_CONPTY_CLS = '\x1b[?25l\x1b[H' + '\x1b[K'.repeat(30) + '\x1b[?25h';

test('looksLikeClear matches the real ConPTY cls burst (ESC[H + ESC[K*30)', () => {
  assert.equal(looksLikeClear(REAL_CONPTY_CLS), true);
});

test('looksLikeClear matches a classic ESC[2J clear', () => {
  assert.equal(looksLikeClear('\x1b[2J\x1b[H'), true);
  assert.equal(looksLikeClear('before\x1b[2J'), true);
});

test('looksLikeClear ignores ordinary output', () => {
  assert.equal(looksLikeClear('PS C:\\> dir\r\n file.txt\r\nPS C:\\> '), false);
  // a couple of stray line-erases without a cursor-home: not a clear
  assert.equal(looksLikeClear('\x1b[K\x1b[K'), false);
  // cursor-home alone (e.g. a progress bar redraw) is not a clear
  assert.equal(looksLikeClear('\x1b[Hprogress 40%'), false);
});

test('looksLikeClear ignores partial lines of long output (chunked)', () => {
  // Less than 3 ESC[K with ESC[H: could be a status-line redraw.
  assert.equal(looksLikeClear('\x1b[H\x1b[Kdone'), false);
});
