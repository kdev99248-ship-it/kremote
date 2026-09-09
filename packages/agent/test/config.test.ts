import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';

test('loadConfig reads relayUrl/deviceKey and resolves root', async () => {
  const base = await mkdtemp(join(tmpdir(), 'kremote-cfg-test-'));
  const cfgPath = join(base, 'config.json');
  const root = join(base, 'root');
  await mkdir(root, { recursive: true });
  await writeFile(cfgPath, JSON.stringify({
    relayUrl: 'ws://localhost:8787/ws',
    deviceKey: 'k'.repeat(32),
    root,
  }), 'utf8');

  const oldOverride = process.env.KREMOTE_AGENT_CONFIG;
  const oldRoot = process.env.KREMOTE_AGENT_ROOT;
  try {
    process.env.KREMOTE_AGENT_CONFIG = cfgPath;
    delete process.env.KREMOTE_AGENT_ROOT;

    const cfg = await loadConfig();
    assert.equal(cfg.relayUrl, 'ws://localhost:8787/ws');
    assert.equal(cfg.root, root); // resolve() of an absolute path is itself

    // KREMOTE_AGENT_ROOT overrides the config file's root.
    process.env.KREMOTE_AGENT_ROOT = join(base, 'env-root');
    const cfg2 = await loadConfig();
    assert.equal(cfg2.root, join(base, 'env-root'));

    // Relative env root resolves against cwd.
    process.env.KREMOTE_AGENT_ROOT = 'some/relative/path';
    const cfg3 = await loadConfig();
    assert.ok(cfg3.root!.endsWith(join('some', 'relative', 'path')));

    // Missing keys are rejected.
    await writeFile(cfgPath, JSON.stringify({ relayUrl: 'ws://x' }), 'utf8');
    const cfg4 = await loadConfig();
    assert.equal(cfg4.deviceKey, undefined); // optional: agent will self-enroll
  } finally {
    if (oldOverride === undefined) delete process.env.KREMOTE_AGENT_CONFIG;
    else process.env.KREMOTE_AGENT_CONFIG = oldOverride;
    if (oldRoot === undefined) delete process.env.KREMOTE_AGENT_ROOT;
    else process.env.KREMOTE_AGENT_ROOT = oldRoot;
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
