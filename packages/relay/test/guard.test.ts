import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionGuard, ipKey } from '../src/guard.ts';

// Fake clock: everything takes `now`, so no real time passes.

test('ipKey normalizes mapped/plain/ipv6 addresses', () => {
  assert.equal(ipKey('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(ipKey('1.2.3.4'), '1.2.3.4');
  assert.equal(ipKey('fe80::1%eth0'), ipKey('fe80::1')); // zone id stripped
  // Two hosts in the same /64 collapse to one key.
  assert.equal(ipKey('2001:db8:1:2:aaaa::1'), ipKey('2001:db8:1:2:ffff::9'));
  assert.notEqual(ipKey('2001:db8:1:2::1'), ipKey('2001:db8:1:3::1'));
  assert.equal(ipKey(''), 'unknown');
});

test('per-IP connection cap', () => {
  const g = new ConnectionGuard({ maxConnsPerIp: 2 });
  assert.equal(g.canConnect('1.1.1.1').ok, true);
  g.onConnect('1.1.1.1');
  g.onConnect('1.1.1.1');
  assert.deepEqual(g.canConnect('1.1.1.1'), { ok: false, reason: 'per-ip' });
  // A different IP is unaffected.
  assert.equal(g.canConnect('2.2.2.2').ok, true);
  // Freeing one slot re-opens the gate.
  g.onDisconnect('1.1.1.1');
  assert.equal(g.canConnect('1.1.1.1').ok, true);
});

test('global connection cap', () => {
  const g = new ConnectionGuard({ maxTotalConns: 2, maxConnsPerIp: 100 });
  g.onConnect('1.1.1.1');
  g.onConnect('2.2.2.2');
  assert.deepEqual(g.canConnect('3.3.3.3'), { ok: false, reason: 'global' });
  g.onDisconnect('1.1.1.1');
  assert.equal(g.canConnect('3.3.3.3').ok, true);
});

test('brute-force: failures within window trigger a temporary block', () => {
  const g = new ConnectionGuard({ authFailMax: 3, authFailWindowMs: 1_000, blockMs: 5_000 });
  const ip = '9.9.9.9';
  assert.equal(g.recordAuthFailure(ip, 100).blocked, false);
  assert.equal(g.recordAuthFailure(ip, 200).blocked, false);
  assert.equal(g.recordAuthFailure(ip, 300).blocked, true); // 3rd → block
  assert.deepEqual(g.canConnect(ip, 400), { ok: false, reason: 'blocked' });
  // Block expires after blockMs.
  assert.equal(g.isBlocked(ip, 300 + 5_000 - 1), true);
  assert.equal(g.canConnect(ip, 300 + 5_000 + 1).ok, true);
});

test('failures outside the window do not accumulate', () => {
  const g = new ConnectionGuard({ authFailMax: 3, authFailWindowMs: 1_000, blockMs: 5_000 });
  const ip = '8.8.8.8';
  g.recordAuthFailure(ip, 0);
  g.recordAuthFailure(ip, 500);
  // This one is >1s after the first, which has now aged out of the window.
  assert.equal(g.recordAuthFailure(ip, 1_600).blocked, false);
  assert.equal(g.isBlocked(ip, 1_600), false);
});

test('a successful auth clears failure history', () => {
  const g = new ConnectionGuard({ authFailMax: 3, authFailWindowMs: 10_000, blockMs: 5_000 });
  const ip = '7.7.7.7';
  g.recordAuthFailure(ip, 100);
  g.recordAuthFailure(ip, 200);
  g.recordAuthSuccess(ip);
  // Counter reset: two more failures should not yet block.
  assert.equal(g.recordAuthFailure(ip, 300).blocked, false);
  assert.equal(g.recordAuthFailure(ip, 400).blocked, false);
  assert.equal(g.isBlocked(ip, 400), false);
});

test('sweep drops stale failure windows and expired blocks', () => {
  const g = new ConnectionGuard({ authFailMax: 5, authFailWindowMs: 1_000, blockMs: 2_000 });
  g.recordAuthFailure('a', 100);
  g.recordAuthFailure('b', 100);
  assert.equal(g.stats.trackedFailIps, 2);
  g.sweep(2_000); // both windows aged out
  assert.equal(g.stats.trackedFailIps, 0);

  const g2 = new ConnectionGuard({ authFailMax: 1, blockMs: 2_000 });
  g2.recordAuthFailure('c', 0); // immediate block
  assert.equal(g2.stats.blockedIps, 1);
  g2.sweep(3_000); // block expired
  assert.equal(g2.stats.blockedIps, 0);
});

test('blocked IP is refused even with free connection slots', () => {
  const g = new ConnectionGuard({ authFailMax: 1, blockMs: 5_000, maxConnsPerIp: 100, maxTotalConns: 100 });
  const ip = '6.6.6.6';
  assert.equal(g.recordAuthFailure(ip, 0).blocked, true);
  assert.deepEqual(g.canConnect(ip, 100), { ok: false, reason: 'blocked' });
});
