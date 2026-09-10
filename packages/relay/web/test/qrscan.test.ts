import { test } from 'node:test';
import assert from 'node:assert/strict';
import QR from 'qrcode';
import jsQR from 'jsqr';
import { parseQrPayload } from '../src/qrscan.ts';

// ── parseQrPayload ───────────────────────────────────────────────────────
// This is what decides whether a scan logs in here or navigates the browser
// somewhere else, so the shapes it accepts matter more than the decoder does.

test('accepts the login URL the agent prints', () => {
  const hit = parseQrPayload('https://kremote.cc/?key=DY88A5ZK');
  assert.deepEqual(hit, { key: 'DY88A5ZK', origin: 'https://kremote.cc' });
});

test('uppercases a lowercase key and keeps the origin', () => {
  const hit = parseQrPayload('http://127.0.0.1:8899/?key=dy88a5zk');
  assert.deepEqual(hit, { key: 'DY88A5ZK', origin: 'http://127.0.0.1:8899' });
});

test('accepts a bare key with no URL around it', () => {
  assert.deepEqual(parseQrPayload('  DY88A5ZK '), { key: 'DY88A5ZK', origin: null });
});

test('rejects QR codes that are not ours', () => {
  // A URL with no key must not be followed — that is a redirect primitive.
  assert.equal(parseQrPayload('https://evil.example/'), null);
  assert.equal(parseQrPayload('https://evil.example/?key='), null);
  assert.equal(parseQrPayload('WIFI:S:home;T:WPA;P:hunter2;;'), null);
  assert.equal(parseQrPayload(''), null);
  assert.equal(parseQrPayload('   '), null);
});

test('rejects key-shaped junk that is too long or has punctuation', () => {
  assert.equal(parseQrPayload('A'.repeat(17)), null);
  assert.equal(parseQrPayload('ABC'), null);            // too short
  assert.equal(parseQrPayload('DY88-A5ZK'), null);
  assert.equal(parseQrPayload('https://kremote.cc/?key=DY88-A5ZK'), null);
});

// ── Encoder/decoder round-trip ───────────────────────────────────────────
// The agent encodes with `qrcode`; a browser without BarcodeDetector decodes
// with `jsqr`. Nothing else in the repo pins that pair together, so prove the
// exact URL shape survives the trip at the size a phone camera sees.

/** Render a QR to RGBA the way jsQR wants it: white ground, black modules. */
function renderRgba(text: string, scale: number, quiet: number) {
  const qr = QR.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const dim = (size + quiet * 2) * scale;
  const rgba = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!qr.modules.data[y * size + x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = (((y + quiet) * scale + dy) * dim + (x + quiet) * scale + dx) * 4;
          rgba[px] = rgba[px + 1] = rgba[px + 2] = 0;
        }
      }
    }
  }
  return { rgba, dim };
}

test('a QR of the agent login URL decodes back to the same URL', () => {
  const url = 'https://kremote.cc/?key=DY88A5ZK';
  const { rgba, dim } = renderRgba(url, 6, 4);
  const hit = jsQR(rgba, dim, dim, { inversionAttempts: 'dontInvert' });
  assert.ok(hit, 'jsQR found no code');
  assert.equal(hit.data, url);
  assert.deepEqual(parseQrPayload(hit.data), { key: 'DY88A5ZK', origin: 'https://kremote.cc' });
});

test('still decodes at the small scale a downscaled camera frame produces', () => {
  const url = 'https://kremote.cc/?key=DY88A5ZK';
  const { rgba, dim } = renderRgba(url, 2, 2);
  const hit = jsQR(rgba, dim, dim, { inversionAttempts: 'dontInvert' });
  assert.ok(hit, `jsQR found no code at ${dim}px`);
  assert.equal(hit.data, url);
});
