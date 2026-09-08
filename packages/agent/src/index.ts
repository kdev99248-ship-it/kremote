import { loadConfig, configPath } from './config.ts';
import { AgentClient } from './client.ts';

// Entry point: load config, connect to relay, print the ACCESS_KEY + QR hint.

async function main() {
  let cfg;
  try {
    cfg = await loadConfig();
  } catch (e: any) {
    console.error(`[agent] config error: ${e.message}`);
    console.error(`[agent] expected config at ${configPath()}`);
    console.error('[agent] run `npm run relay:keygen -- <name>` on the VPS to get a DEVICE_KEY,');
    console.error('[agent] then write { relayUrl, deviceKey } into that config file.');
    process.exit(1);
  }

  const client = new AgentClient(cfg);

  client.connect();

  // After connecting, ask the relay for a one-time ACCESS_KEY and show it.
  const showKey = async () => {
    try {
      const r = await client.requestAccessKey();
      console.log('\n────────────────────────────────────────────');
      console.log('  Open in your browser:');
      console.log(`    ${r.url || '(set KREMOTE_PUBLIC_URL on the relay)'}`);
      console.log('  ACCESS_KEY (one-time, expires in ' + Math.round(r.expiresMs / 60000) + ' min):');
      console.log(`    ${r.key}`);
      console.log('────────────────────────────────────────────\n');
    } catch (e: any) {
      console.error(`[agent] could not get access key: ${e.message}`);
    }
  };

  // Give the WS a moment, then request a key. Also expose a stdin command.
  setTimeout(showKey, 1500);

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    const line = String(d).trim();
    if (line === 'k' || line === 'key') void showKey();
    if (line === 'q' || line === 'quit') { client.stop(); process.exit(0); }
  });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => { console.log(`\n[agent] ${sig}`); client.stop(); process.exit(0); });
  }
}

void main();
