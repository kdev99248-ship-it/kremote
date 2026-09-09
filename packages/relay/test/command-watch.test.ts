import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CommandWatch, RUN_MIN_MS, QUIET_MS,
} from '../web/src/command-watch.ts';

// Drives the watch with explicit timestamps so no real waiting is needed.
// The quiet timer is real (setTimeout), so finish assertions wait for the
// QUIET_MS timer to fire; everything else is synchronous via injected `now`.

test('instant commands never fire done (output shorter than RUN_MIN)', async () => {
  let done = 0;
  const w = new CommandWatch(() => done++);
  const t0 = 1_000_000;
  w.onSubmit(t0);
  // Brief output burst, then silence past the quiet window.
  w.onOutput(t0 + 300);
  w.onOutput(t0 + 900);
  await new Promise((r) => setTimeout(r, QUIET_MS + 150));
  assert.equal(done, 0);
  assert.equal(w.state, 'idle');
});

test('long output then silence fires done exactly once', async () => {
  let done = 0;
  const w = new CommandWatch(() => done++);
  const t0 = 2_000_000;
  w.onSubmit(t0);
  // Stream output for RUN_MIN_MS in 1s chunks (keeps re-arming the quiet timer).
  let t = t0 + 500;
  while (t - t0 < RUN_MIN_MS + 1_000) {
    w.onOutput(t);
    t += 1_000;
  }
  // Last chunk at t; wait out the quiet window from there.
  await new Promise((r) => setTimeout(r, QUIET_MS + 300));
  assert.equal(done, 1);
  assert.equal(w.state, 'done');
  // consumeDone flips back to idle and reports once.
  assert.equal(w.consumeDone(), true);
  assert.equal(w.state, 'idle');
  assert.equal(w.consumeDone(), false);
});

test('streaming output with sub-QUIET gaps never goes quiet', async () => {
  let done = 0;
  const w = new CommandWatch(() => done++);
  const t0 = 3_000_000;
  w.onSubmit(t0);
  const total = RUN_MIN_MS * 3;
  let t = t0 + 100;
  const step = 400; // < QUIET_MS: the quiet timer keeps being pushed forward
  while (t - t0 < total) {
    w.onOutput(t);
    // Real sleep only on the final iteration boundary handled below; use tiny
    // real sleeps so timers advance but stay under QUIET_MS.
    await new Promise((r) => setTimeout(r, 5));
    t += step;
  }
  // The stream just ended (last onOutput < QUIET_MS ago): nothing fired yet.
  assert.equal(done, 0);
  assert.equal(w.state, 'running');
  w.onClose();
  assert.equal(w.state, 'idle');
});

test('submit re-arms cleanly after a done (two commands in a row)', async () => {
  let done = 0;
  const w = new CommandWatch(() => done++);
  const t0 = 4_000_000;
  // First command: long enough.
  w.onSubmit(t0);
  let t = t0 + 200;
  while (t - t0 < RUN_MIN_MS + 1_000) { w.onOutput(t); t += 500; }
  await new Promise((r) => setTimeout(r, QUIET_MS + 200));
  assert.equal(done, 1);
  w.consumeDone();
  // Second command fires immediately after; its tiny output must not count
  // as continuation of the first.
  w.onSubmit(t + 10);
  w.onOutput(t + 40);
  await new Promise((r) => setTimeout(r, QUIET_MS + 200));
  assert.equal(done, 1);
  assert.equal(w.state, 'idle');
});

test('a command with no output at all stays running (no bogus notify)', () => {
  const w = new CommandWatch(() => { throw new Error('should not fire'); });
  w.onSubmit(5_000_000);
  assert.equal(w.state, 'running');
  assert.equal(w.isLive, false); // nothing streamed recently
  w.onClose();
  assert.equal(w.state, 'idle');
});
