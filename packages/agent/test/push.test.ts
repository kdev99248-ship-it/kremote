import test from 'node:test';
import assert from 'node:assert/strict';
import { PushSender } from '../src/push.ts';
import type { AgentConfig } from '../src/config.ts';

function cfg(): AgentConfig {
  return { relayUrl: 'ws://x/ws' };
}

test('ensureVapid generates + persists a keypair once', async () => {
  const c = cfg();
  let saves = 0;
  const p = new PushSender(c, async () => { saves++; });
  const pub1 = await p.ensureVapid();
  assert.ok(pub1 && typeof pub1 === 'string');
  assert.ok(c.vapid?.publicKey && c.vapid?.privateKey);
  assert.equal(saves, 1);
  const pub2 = await p.ensureVapid(); // already present → no new save
  assert.equal(pub2, pub1);
  assert.equal(saves, 1);
});

test('add dedupes by endpoint and persists', async () => {
  const c = cfg();
  let saves = 0;
  const p = new PushSender(c, async () => { saves++; });
  const sub = { endpoint: 'https://push/1', keys: { p256dh: 'a', auth: 'b' } };
  await p.add(sub);
  await p.add({ ...sub });          // same endpoint → ignored
  assert.equal(c.pushSubs?.length, 1);
  assert.equal(saves, 1);
  await p.add({ endpoint: 'https://push/2', keys: { p256dh: 'c', auth: 'd' } });
  assert.equal(c.pushSubs?.length, 2);
  assert.equal(saves, 2);
});

test('remove drops a subscription by endpoint', async () => {
  const c = cfg();
  const p = new PushSender(c, async () => {});
  await p.add({ endpoint: 'https://push/1', keys: { p256dh: 'a', auth: 'b' } });
  await p.remove('https://push/1');
  assert.equal(c.pushSubs?.length, 0);
  await p.remove('https://nope');   // no-op, no throw
});

test('send is a no-op without VAPID or subscriptions', async () => {
  const c = cfg();
  const p = new PushSender(c, async () => {});
  await p.send({ title: 't', body: 'b' }); // no vapid, no subs → resolves quietly
  assert.ok(true);
});
