import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { USER_RE } from './addr.js';

export class ConfigError extends Error {}

/** XDG base directory: the variable's value if it is an absolute path, else the default under $HOME. */
export function xdgDir(envVar, fallback, env = process.env) {
  const v = env[envVar];
  return v && path.isAbsolute(v) ? v : path.join(os.homedir(), fallback);
}

export function configPath(env = process.env) {
  return env.AGENT_MAILBOX_CONFIG || path.join(xdgDir('XDG_CONFIG_HOME', '.config', env), 'agent-mailbox', 'config.json');
}

export function readConfigFile(env = process.env) {
  const p = configPath(env);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new ConfigError(`cannot read config ${p}: ${e.message}`);
  }
}

export const splitServers = (s) => String(s ?? '').split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean);

/**
 * Load config (file, then env overrides). Throws ConfigError if incomplete.
 * -> {servers[], user, password, maxBytes|null}
 */
export function loadConfig(env = process.env) {
  const file = readConfigFile(env) || {};
  const servers = env.AGENT_MAILBOX_SERVERS ? splitServers(env.AGENT_MAILBOX_SERVERS) : (Array.isArray(file.servers) ? file.servers.flatMap(splitServers) : []);
  const user = String(env.AGENT_MAILBOX_USER || file.user || '').trim();
  const password = String(env.AGENT_MAILBOX_PASSWORD || file.password || '');
  const maxBytes = Number(env.AGENT_MAILBOX_MAX_BYTES || file.maxMessageBytes || 0);
  const missing = [];
  if (!servers.length) missing.push('servers');
  if (!user) missing.push('user');
  if (!password) missing.push('password');
  if (missing.length) {
    throw new ConfigError(
      `mailbox is not configured (missing ${missing.join(', ')}; looked in ${configPath(env)}). ` +
        'Run: mbox setup --servers <url> --user <name> --password-stdin',
    );
  }
  if (!USER_RE.test(user)) throw new ConfigError(`user "${user}" is invalid (allowed: a-z 0-9 -)`);
  return { servers, user, password, maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : null };
}

/** Write the client config with mode 0600 (it holds the password). */
export function writeConfig({ servers, user, password }, env = process.env) {
  const p = configPath(env);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const existing = readConfigFile(env) || {};
  delete existing.server;
  delete existing.token;
  const data = { ...existing, servers, user, password };
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, p);
  return p;
}
