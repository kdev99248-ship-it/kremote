import test from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION, decode, encode } from '@kremote/shared';
import type { AnyFrame } from '@kremote/shared';

const FRAMES: AnyFrame[] = [
  { type: 'hello.agent', deviceKey: 'abc123', protocol: PROTOCOL_VERSION },
  { type: 'hello.client', accessKey: 'XK9M2Q', protocol: PROTOCOL_VERSION },
  { type: 'hello.res', ok: true },
  { type: 'hello.res', ok: false, error: 'unknown device key' },
  { type: 'term.open', id: 'r1', shell: 'powershell.exe', cols: 80, rows: 24 },
  { type: 'term.open.res', id: 'r1', termId: 't1', ok: true },
  { type: 'term.open.res', id: 'r2', ok: false, error: 'spawn failed' },
  { type: 'term.close', id: 'r3', termId: 't1' },
  { type: 'term.close.res', id: 'r3', ok: true },
  { type: 'term.list', id: 'r4' },
  { type: 'term.list.res', id: 'r4', terms: [{ termId: 't1', shell: 'powershell.exe', cwd: 'C:\\' }] },
  { type: 'term.data', termId: 't1', data: 'hello\r\n' },
  { type: 'term.input', termId: 't1', data: 'ls\r' },
  { type: 'term.resize', termId: 't1', cols: 120, rows: 40 },
  { type: 'term.exit', termId: 't1', code: 0 },
  { type: 'accesskey.req', id: 'ak1' },
  { type: 'accesskey.res', id: 'ak1', key: 'Q7ZW3N', url: 'https://x/?key=Q7ZW3N', expiresMs: 300000 },
  { type: 'peer.gone' },
];

test('encode/decode round-trip preserves every frame verbatim', () => {
  for (const frame of FRAMES) {
    const wire = encode(frame);
    assert.equal(typeof wire, 'string');
    assert.deepEqual(decode(wire), frame, `round-trip failed for ${frame.type}`);
  }
});

test('decode accepts a Buffer (ws messages)', () => {
  const frame: AnyFrame = { type: 'term.data', termId: 't1', data: 'ok' };
  assert.deepEqual(decode(Buffer.from(encode(frame), 'utf8')), frame);
});

test('round-trip survives escape sequences and unicode', () => {
  const nasty = '\x1b[31mred\x1b[0m\r\n日本語 \u0000 trailing';
  const frame: AnyFrame = { type: 'term.data', termId: 't1', data: nasty };
  assert.equal(decode(encode(frame)).type === 'term.data'
    && (decode(encode(frame)) as any).data, nasty);
});

test('decode rejects non-frames', () => {
  assert.throws(() => decode('null'));
  assert.throws(() => decode('"just a string"'));
  assert.throws(() => decode('{"noType":1}'));
  assert.throws(() => decode('{ not json'));
});
