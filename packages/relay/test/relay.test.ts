import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { Relay, type Peer } from '../src/relay.ts';
import { PROTOCOL_VERSION, encode, decode } from '@kremote/shared';
import type { AnyFrame } from '@kremote/shared';

// Fake peer: records sent frames, simulates close.
class FakePeer implements Peer {
  sent: AnyFrame[] = [];
  closed: { code?: number; reason?: string } | null = null;
  readonly id: string;
  constructor(id: string) { this.id = id; }
  send(data: string): void { this.sent.push(decode(data)); }
  close(code?: number, reason?: string): void { this.closed = { code, reason }; }
  last(): AnyFrame { return this.sent[this.sent.length - 1]; }
}

async function setup() {
  const dir = await mkTmp();
  const store = await Store.load(join(dir, 'store.json'));
  const { device, key } = await store.addDevice('test-win');
  const relay = new Relay(store, { accessKeyTtlMs: 60_000, idleTimeoutMs: 60_000 });
  return { dir, store, relay, device, deviceKey: key };
}

let tmpSeq = 0;
async function mkTmp(): Promise<string> {
  const dir = join(tmpdir(), `kremote-relay-test-${Date.now()}-${++tmpSeq}`);
  return dir;
}

// Store.flush() is async; rm can race a still-open write on Windows (EBUSY/
// ENOTEMPTY). Retry briefly before giving up.
async function cleanup(dir: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    try { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); return; }
    catch { await new Promise(r => setTimeout(r, 100)); }
  }
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

function connectAgent(relay: Relay, deviceKey: string, id = 'agent1'): FakePeer {
  const peer = new FakePeer(id);
  relay.handleHello(peer, encode({ type: 'hello.agent', deviceKey, protocol: PROTOCOL_VERSION }));
  return peer;
}

async function mintAccessKey(relay: Relay, agent: FakePeer): Promise<string> {
  const r = relay.handleAccessKeyReq(agent, 'ak1');
  assert.ok(r, 'agent should be able to mint an access key');
  return r.key;
}

function connectClient(relay: Relay, accessKey: string, id = 'client1'): FakePeer {
  const peer = new FakePeer(id);
  relay.handleHello(peer, encode({ type: 'hello.client', accessKey, protocol: PROTOCOL_VERSION }));
  return peer;
}

function reconnectClient(relay: Relay, session: string, id = 'client-r'): FakePeer {
  const peer = new FakePeer(id);
  relay.handleHello(peer, encode({ type: 'hello.client', session, protocol: PROTOCOL_VERSION }));
  return peer;
}

function sessionOf(peer: FakePeer): string {
  const hello = peer.last() as { session?: string };
  assert.equal(typeof hello.session, 'string', 'expected a session token in hello.res');
  return hello.session!;
}

test('agent hello with unknown key is rejected', async () => {
  const { dir, relay } = await setup();
  try {
    const peer = connectAgent(relay, 'deadbeef'.repeat(4), 'a1');
    assert.deepEqual(peer.last(), { type: 'hello.res', ok: false, error: 'unknown device key' });
    assert.ok(peer.closed);
  } finally { await cleanup(dir); }
});

test('protocol mismatch is rejected', async () => {
  const { dir, relay, deviceKey } = await setup();
  try {
    const peer = new FakePeer('a1');
    relay.handleHello(peer, encode({ type: 'hello.agent', deviceKey, protocol: 999 }));
    assert.deepEqual(peer.last(), { type: 'hello.res', ok: false, error: 'protocol mismatch' });
  } finally { await cleanup(dir); }
});

test('full pairing: connect, mint key, match, pump both ways', async () => {
  const { dir, relay, deviceKey } = await setup();
  try {
    const agent = connectAgent(relay, deviceKey);
    assert.deepEqual(agent.last(), { type: 'hello.res', ok: true });

    const key = await mintAccessKey(relay, agent);
    const client = connectClient(relay, key);
    const hello = client.last() as { type: string; ok: boolean; session?: string };
    assert.equal(hello.type, 'hello.res');
    assert.equal(hello.ok, true);
    assert.equal(typeof hello.session, 'string', 'relay hands the browser a durable session token');
    assert.ok(relay.isPairedClient(client.id));

    // client → agent
    const input: AnyFrame = { type: 'term.input', termId: 't1', data: 'ls\r' };
    relay.handleFrame(client, encode(input));
    assert.deepEqual(agent.last(), input);

    // agent → client
    const out: AnyFrame = { type: 'term.data', termId: 't1', data: 'file.txt' };
    relay.handleFrame(agent, encode(out));
    assert.deepEqual(client.last(), out);
  } finally { await cleanup(dir); }
});

test('access key is one-time', async () => {
  const { dir, relay, deviceKey } = await setup();
  try {
    const agent = connectAgent(relay, deviceKey);
    const key = await mintAccessKey(relay, agent);
    const c1 = connectClient(relay, key, 'c1');
    assert.equal((c1.last() as any).ok, true);
    const c2 = connectClient(relay, key, 'c2');
    assert.deepEqual(c2.last(), { type: 'hello.res', ok: false, error: 'invalid or expired access key' });
    assert.ok(c2.closed);
  } finally { await cleanup(dir); }
});

test('client rejected when agent is offline', async () => {
  const { dir, relay, deviceKey } = await setup();
  try {
    const agent = connectAgent(relay, deviceKey);
    const key = await mintAccessKey(relay, agent);
    relay.handleClose(agent); // agent drops before client connects
    const client = connectClient(relay, key);
    assert.deepEqual(client.last(), { type: 'hello.res', ok: false, error: 'agent offline' });
  } finally { await cleanup(dir); }
});

test('agent-offline transition notifies paired clients with peer.gone', async () => {
  const { dir, relay, deviceKey } = await setup();
  try {
    const agent = connectAgent(relay, deviceKey);
    const key = await mintAccessKey(relay, agent);
    const client = connectClient(relay, key);
    assert.ok(relay.isPairedClient(client.id));

    relay.handleClose(agent);
    assert.deepEqual(client.last(), { type: 'peer.gone' });
    assert.equal(relay.isPairedClient(client.id), false);
    assert.equal(relay.stats.devices, 0);
  } finally { await cleanup(dir); }
});

test('agent reconnect re-pairs waiting clients', async () => {
  const { dir, relay, deviceKey } = await setup();
  try {
    const agent1 = connectAgent(relay, deviceKey, 'a1');
    const key = await mintAccessKey(relay, agent1);
    const client = connectClient(relay, key);
    relay.handleClose(agent1);

    const agent2 = connectAgent(relay, deviceKey, 'a2');
    assert.ok(relay.isPairedClient(client.id), 'client should be re-paired');

    const out: AnyFrame = { type: 'term.data', termId: 't1', data: 'back' };
    relay.handleFrame(agent2, encode(out));
    assert.deepEqual(client.last(), out);
  } finally { await cleanup(dir); }
});

test('max 4 concurrent browser sessions per device', async () => {
  const { dir, relay, deviceKey } = await setup();
  try {
    const agent = connectAgent(relay, deviceKey);
    for (let i = 0; i < 4; i++) {
      const key = await mintAccessKey(relay, agent);
      const c = connectClient(relay, key, `c${i}`);
      assert.equal((c.last() as any).ok, true, `session ${i} should connect`);
    }
    const key5 = await mintAccessKey(relay, agent);
    const c5 = connectClient(relay, key5, 'c5');
    assert.deepEqual(c5.last(), { type: 'hello.res', ok: false, error: 'too many sessions for this device' });
  } finally { await cleanup(dir); }
});

test('durable session survives disconnect and re-authenticates silently', async () => {
  const { dir, relay, deviceKey } = await setup();
  try {
    const agent = connectAgent(relay, deviceKey);
    const key = await mintAccessKey(relay, agent);
    const client = connectClient(relay, key);
    const token = sessionOf(client);

    // Browser drops (tab closed / network blip). Session must NOT be discarded.
    relay.handleClose(client);
    assert.equal(relay.stats.clients, 0);

    // Reconnect with the stored token — no new ACCESS_KEY needed.
    const back = reconnectClient(relay, token);
    const hello = back.last() as { ok: boolean; session?: string };
    assert.equal(hello.ok, true);
    assert.equal(hello.session, token, 'relay echoes the same durable token');
    assert.ok(relay.isPairedClient(back.id), 'reconnected client re-pairs with the live agent');
  } finally { await cleanup(dir); }
});

test('reconnect with an unknown session token is rejected', async () => {
  const { dir, relay, deviceKey } = await setup();
  try {
    connectAgent(relay, deviceKey);
    const back = reconnectClient(relay, 'not-a-real-token');
    assert.deepEqual(back.last(), { type: 'hello.res', ok: false, error: 'session expired' });
    assert.ok(back.closed);
  } finally { await cleanup(dir); }
});

test('session reconnect waits for a not-yet-connected agent, then pairs', async () => {
  const { dir, relay, deviceKey } = await setup();
  try {
    const agent1 = connectAgent(relay, deviceKey, 'a1');
    const key = await mintAccessKey(relay, agent1);
    const client = connectClient(relay, key);
    const token = sessionOf(client);
    relay.handleClose(client);
    relay.handleClose(agent1); // agent offline too

    // Reconnect while the agent is down: accepted but unpaired (waiting).
    const back = reconnectClient(relay, token);
    assert.equal((back.last() as any).ok, true);
    assert.equal(relay.isPairedClient(back.id), false);

    // Agent returns → client is re-paired automatically.
    const agent2 = connectAgent(relay, deviceKey, 'a2');
    assert.ok(relay.isPairedClient(back.id));
    const out: AnyFrame = { type: 'term.data', termId: 't1', data: 'resumed' };
    relay.handleFrame(agent2, encode(out));
    assert.deepEqual(back.last(), out);
  } finally { await cleanup(dir); }
});

test('client close notifies agent with peer.gone', async () => {
  const { dir, relay, deviceKey } = await setup();
  try {
    const agent = connectAgent(relay, deviceKey);
    const key = await mintAccessKey(relay, agent);
    const client = connectClient(relay, key);
    relay.handleClose(client);
    assert.deepEqual(agent.last(), { type: 'peer.gone' });
    assert.equal(relay.stats.clients, 0);
  } finally { await cleanup(dir); }
});

test('tick expires idle peers and stale access keys', async () => {
  const { dir, relay, deviceKey } = await setup();
  try {
    const agent = connectAgent(relay, deviceKey);
    await mintAccessKey(relay, agent);
    // Far future: everything idle/expired.
    relay.tick(Date.now() + 10 * 60_000);
    assert.equal(relay.stats.devices, 0);
    assert.equal(relay.stats.accessKeys, 0);
  } finally { await cleanup(dir); }
});
