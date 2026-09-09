import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TailManager } from '../src/tail.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('tail streams appended bytes and replays the tail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kremote-tail-'));
  const file = join(dir, 'app.log');
  await writeFile(file, 'line1\nline2\n');
  try {
    const chunks: string[] = [];
    let dead = '';
    const t = new TailManager(dir, (_id, c) => chunks.push(c), (_id, r) => { dead = r; });
    const h = await t.watch('app.log');       // no fromEnd: replays last bytes
    await t.initialReplay(h.watchId);         // caller acks first, then replays
    await sleep(300);
    await appendFile(file, 'line3\n');
    await sleep(500);
    const all = chunks.join('');
    assert.match(all, /line1/);                 // replayed
    assert.match(all, /line3/);                 // appended live
    assert.equal(dead, '');
    h.close();
    assert.equal(t.size, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('tail fromEnd skips the existing content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kremote-tail2-'));
  const file = join(dir, 'app.log');
  await writeFile(file, 'old-content\n');
  try {
    const chunks: string[] = [];
    const t = new TailManager(dir, (_id, c) => chunks.push(c), () => {});
    await t.watch('app.log', { fromEnd: true });
    await sleep(300);
    assert.equal(chunks.length, 0);             // nothing replayed
    await appendFile(file, 'new-line\n');
    await sleep(500);
    const all = chunks.join('');
    assert.ok(!all.includes('old-content'), 'old content must not arrive');
    assert.match(all, /new-line/);
    t.closeAll();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('tail detects rotation (shrink → restart from 0)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kremote-tail3-'));
  const file = join(dir, 'rot.log');
  await writeFile(file, 'a'.repeat(100) + '\n');
  try {
    const chunks: string[] = [];
    const t = new TailManager(dir, (_id, c) => chunks.push(c), () => {});
    await t.watch('rot.log', { fromEnd: true });
    await sleep(200);
    // Rotate: truncate + write fresh content (size shrinks below our offset).
    await writeFile(file, 'fresh-rotated\n');
    await sleep(600);
    const all = chunks.join('');
    assert.match(all, /fresh-rotated/);
    t.closeAll();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('tail setNotify fires onMatch once per chunk for matching lines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kremote-tailn-'));
  const file = join(dir, 'app.log');
  await writeFile(file, 'boot\n');
  try {
    const matches: { path: string; line: string }[] = [];
    const t = new TailManager(
      dir,
      () => {},
      () => {},
      (_id, path, line) => matches.push({ path, line }),
    );
    const h = await t.watch('app.log', { fromEnd: true });
    assert.equal(t.setNotify(h.watchId, 'ERROR'), true);
    await sleep(200);
    await appendFile(file, 'INFO ok\nERROR boom\nERROR again\n'); // one chunk, 2 matches
    await sleep(500);
    assert.equal(matches.length, 1, 'one push per chunk, not per line');
    assert.match(matches[0].line, /ERROR boom/);
    assert.equal(matches[0].path, 'app.log');
    // Clearing the pattern stops alerts.
    assert.equal(t.setNotify(h.watchId, ''), true);
    await appendFile(file, 'ERROR silent\n');
    await sleep(400);
    assert.equal(matches.length, 1);
    t.closeAll();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('tail setNotify returns false for unknown watch / invalid regex', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kremote-tailn2-'));
  await writeFile(join(dir, 'f.log'), 'x\n');
  try {
    const t = new TailManager(dir, () => {}, () => {});
    assert.equal(t.setNotify('nope', 'ERROR'), false);
    const h = await t.watch('f.log', { fromEnd: true });
    assert.equal(t.setNotify(h.watchId, '('), false); // invalid regex
    t.closeAll();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('tail rejects paths outside root and caps concurrent watches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kremote-tail4-'));
  await writeFile(join(dir, 'f1.log'), 'x');
  try {
    const t = new TailManager(dir, () => {}, () => {});
    await assert.rejects(() => t.watch('../outside.log'), /outside root|forbidden|escape/i);
    // Fill to the cap.
    const handles = [];
    for (let i = 0; i < 8; i++) handles.push(await t.watch('f1.log'));
    assert.equal(t.size, 8);
    await assert.rejects(() => t.watch('f1.log'), /too many/i);
    handles.forEach((h) => h.close());
    t.closeAll();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
