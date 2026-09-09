import { loadConfig, configPath } from './config.ts';
import { AgentClient } from './client.ts';
import type { AgentConfig } from './config.ts';
import QR from 'qrcode';

// Entry point: load config, connect to relay. The moment the relay accepts our
// hello the agent mints a one-time ACCESS_KEY and prints it with a scannable
// QR. The browser is NEVER auto-opened: the key is one-time, and a PC browser
// redeeming it first would leave the phone with "invalid or expired access
// key". Scan the QR (or copy the URL) to the device you actually want to use.

/** Derive the http(s) login URL from the relay's ws(s):// URL. */
function httpUrl(cfg: AgentConfig, key: string): string {
  try {
    const u = new URL(cfg.relayUrl);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '/';
    u.search = `?key=${key}`;
    return u.toString();
  } catch {
    return `/?key=${key}`;
  }
}

/** Half-block QR for phones to scan straight off the terminal. Best-effort:
 * a rendering failure must never break the key/URL display. */
async function qrBlock(url: string): Promise<string> {
  try {
    const art = await QR.toString(url, {
      type: 'terminal', small: true, errorCorrectionLevel: 'L', margin: 1,
    });
    return `\n  Scan with your phone (one-time key — don't open the URL here):\n\n${art}\n`;
  } catch {
    return ''; // QR is decoration; URL + key are always printed as text
  }
}

async function main(): Promise<void> {
  let cfg: AgentConfig;
  try {
    cfg = await loadConfig();
  } catch (e: any) {
    console.error(`[agent] config error: ${e.message}`);
    console.error(`[agent] expected config at ${configPath()}`);
    console.error('[agent] the config only needs a relayUrl, e.g.:');
    console.error(JSON.stringify({ relayUrl: 'wss://kremote.cc/ws', root: 'C:/works' }, null, 2));
    process.exit(1);
  }

  const client = new AgentClient(cfg);
  client.connect();

  /** Mint an ACCESS_KEY, print it + QR. Never opens a browser: the key is
   * one-time, so whoever opens the URL first consumes it. */
  const showKey = async (): Promise<void> => {
    try {
      const r = await client.requestAccessKey();
      const url = r.url.startsWith('http') ? r.url : httpUrl(cfg, r.key);
      console.log('\n────────────────────────────────────────────');
      console.log('  Open on your phone (or any browser you want to use):');
      console.log(`    ${url}`);
      console.log('  ACCESS_KEY (one-time, expires in ' + Math.round(r.expiresMs / 60000) + ' min):');
      console.log(`    ${r.key}`);
      console.log(await qrBlock(url));
      console.log('────────────────────────────────────────────\n');
    } catch (e: any) {
      console.error(`[agent] could not get access key: ${e.message}`);
    }
  };

  // Relay accepted our hello (relay up + device key valid) → mint a key.
  client.onHelloOk = () => { void showKey(); };

  // Manual re-issue from the console: `k` (key), `q` (quit).
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
