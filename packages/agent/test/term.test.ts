import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOscTitle, TermManager } from '../src/term.ts';

// ── parseOscTitle: pure string parsing, no pty needed ────────────────────
test('parseOscTitle extracts a BEL-terminated OSC 0 title', () => {
  assert.equal(parseOscTitle('\x1b]0;claude\x07'), 'claude');
});

test('parseOscTitle extracts a BEL-terminated OSC 2 title', () => {
  assert.equal(parseOscTitle('\x1b]2;npm run dev\x07'), 'npm run dev');
});

test('parseOscTitle extracts an ST-terminated title', () => {
  assert.equal(parseOscTitle('\x1b]0;vim\x1b\\'), 'vim');
});

test('parseOscTitle finds the title amid surrounding output', () => {
  assert.equal(parseOscTitle('prompt$ \x1b]0;claude\x07 output here'), 'claude');
});

test('parseOscTitle returns the LAST title when several are present', () => {
  assert.equal(parseOscTitle('\x1b]0;first\x07mid\x1b]0;second\x07'), 'second');
});

test('parseOscTitle returns null when no title is present', () => {
  assert.equal(parseOscTitle('just some plain output\r\n'), null);
});

test('parseOscTitle ignores non-title OSC sequences (e.g. OSC 8 links)', () => {
  assert.equal(parseOscTitle('\x1b]8;;https://example.com\x07link\x1b]8;;\x07'), null);
});

// ── TermManager.open/list: real pty, program title surfaces in list() ────
// node-pty is a native module; if it can't spawn here, skip rather than fail.
let ptyOk = true;
try {
  const probe = new TermManager();
  const info = probe.open({ cols: 80, rows: 24 });
  probe.close(info.termId);
} catch {
  ptyOk = false;
}

test('list() reports title + lastActivity after the pty sets an OSC title', { skip: !ptyOk }, async () => {
  const mgr = new TermManager();
  // A node process that prints an OSC 0 title then exits — no shell needed.
  // Emit the OSC title, then stay alive so the pty is still listed when we check.
  const info = mgr.open({
    shell: process.execPath,
    args: ['-e', 'process.stdout.write("\\x1b]0;claude\\x07hello\\n"); setTimeout(() => {}, 3000)'],
    cols: 80,
    rows: 24,
  });
  const before = Date.now();

  // Wait for output to arrive (the onData handler updates title/lastActivity).
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    mgr.on('data', () => setTimeout(done, 80));
    setTimeout(done, 2000); // safety net
  });

  const listed = mgr.list().find(t => t.termId === info.termId);
  assert.ok(listed, 'terminal should still be listed while alive');
  if (listed) {
    assert.equal(listed.title, 'claude');
    assert.ok(listed.lastActivity >= before, 'lastActivity should be updated on output');
  }
  mgr.close(info.termId);
});
