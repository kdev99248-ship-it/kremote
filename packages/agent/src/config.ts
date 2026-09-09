import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export interface AgentConfig {
  relayUrl: string;        // wss://host/ws
  deviceKey: string;       // plaintext, local only
  deviceId?: string;
  defaultShell?: string;
  /** Root that fs.* paths are resolved against. Defaults to homedir(). */
  root?: string;
  /** Human label printed with the access key. */
  label?: string;
}

export function configPath(): string {
  const override = process.env.KREMOTE_AGENT_CONFIG;
  if (override) return resolve(override);
  return join(homedir(), '.kremote', 'config.json');
}

export async function loadConfig(): Promise<AgentConfig> {
  const path = configPath();
  const raw = await readFile(path, 'utf8');
  const cfg = JSON.parse(raw) as AgentConfig;
  if (!cfg.relayUrl) throw new Error(`${path}: missing relayUrl`);
  if (!cfg.deviceKey) throw new Error(`${path}: missing deviceKey`);
  // KREMOTE_AGENT_ROOT overrides the config file's root (fs.*/git.* base dir).
  cfg.root = process.env.KREMOTE_AGENT_ROOT ?? cfg.root ?? homedir();
  cfg.root = resolve(cfg.root);
  return cfg;
}

export async function saveConfig(cfg: AgentConfig, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cfg, null, 2), 'utf8');
}
