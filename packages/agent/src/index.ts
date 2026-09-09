import { spawn } from 'node:child_process';
import { loadConfig, configPath } from './config.ts';
import { AgentClient } from './client.ts';
import type { AgentConfig } from './config.ts';
import QR from 'qrcode';

// Entry point: load config, connect to relay. The moment the relay accepts our
// hello the agent mints a one-time ACCESS_KEY, prints it with a scannable QR
// and — in an interactive terminal — opens the browser straight into the
// logged-in UI.

/** Best-effort "open URL in the default browser"; the URL is printed anyway. */
function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      // `start` eats the first quoted arg as a window title, hence the ''.
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* no browser available — key/URL are on screen */ }
}

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
    return `\n  Scan to open (or type the URL):\n\n${art}\n`;
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

  const canAutoOpen = process.stdout.isTTY && process.env.KREMOTE_AGENT_NO_OPEN !== '1';

  /** Mint an ACCESS_KEY, print it + QR, optionally open the browser. */
  const showKey = async (open: boolean): Promise<void> => {
    try {
      const r = await client.requestAccessKey();
      const url = r.url.startsWith('http') ? r.url : httpUrl(cfg, r.key);
      console.log('\n────────────────────────────────────────────');
      console.log('  Open in your browser:');
      console.log(`    ${url}`);
      console.log('  ACCESS_KEY (one-time, expires in ' + Math.round(r.expiresMs / 60000) + ' min):');
      console.log(`    ${r.key}`);
      console.log(await qrBlock(url));
      console.log('────────────────────────────────────────────\n');
      if (open) openBrowser(url);
    } catch (e: any) {
      console.error(`[agent] could not get access key: ${e.message}`);
    }
  };

  // Relay accepted our hello (relay up + device key valid) → mint a key.
  // Auto-open the browser on the first hello only; later reconnects just print.
  let firstHello = true;
  client.onHelloOk = () => {
    void showKey(firstHello && canAutoOpen);
    firstHello = false;
  };

  // Manual re-issue from the console: `k` (key), `q` (quit).
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    const line = String(d).trim();
    if (line === 'k' || line === 'key') void showKey(canAutoOpen);
    if (line === 'q' || line === 'quit') { client.stop(); process.exit(0); }
  });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => { console.log(`\n[agent] ${sig}`); client.stop(); process.exit(0); });
  }
}

void main();
