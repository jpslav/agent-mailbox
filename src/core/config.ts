import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { USER_RE } from './addr.js';
import { lenientString } from './text.js';
import type { Config, Env } from './types.js';

export class ConfigError extends Error {}

/** XDG base directory: the variable's value if it is an absolute path, else the default under $HOME. */
export function xdgDir(envVar: string, fallback: string, env: Env = process.env): string {
  const v = env[envVar];
  return v && path.isAbsolute(v) ? v : path.join(os.homedir(), fallback);
}

/** A profile name, as `--profile` and AGENT_MAILBOX_PROFILE take it. */
export const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * The selected profile (AGENT_MAILBOX_PROFILE, which `--profile` sets), or null for the default
 * one: unset, empty and "default" all mean the default profile. An invalid name throws rather than
 * falling back to the default profile, which may be someone else's identity.
 */
export function profileName(env: Env = process.env): string | null {
  const v = (env.AGENT_MAILBOX_PROFILE ?? '').trim();
  if (!v || v === 'default') return null;
  if (!PROFILE_RE.test(v))
    throw new ConfigError(
      `profile "${v.slice(0, 40)}" is invalid (allowed: a-z 0-9 -, starting with a letter or digit, at most 32 characters)`,
    );
  return v;
}

/**
 * The client config file: `profiles/<name>.json` for a named profile, else AGENT_MAILBOX_CONFIG,
 * else `config.json`. A named profile together with AGENT_MAILBOX_CONFIG is ambiguous (which
 * identity?), so it is an error, not a silent choice.
 */
export function configPath(env: Env = process.env): string {
  const profile = profileName(env);
  if (profile && env.AGENT_MAILBOX_CONFIG)
    throw new ConfigError(
      `both a profile (${profile}) and AGENT_MAILBOX_CONFIG are set; unset one of them`,
    );
  const dir = path.join(xdgDir('XDG_CONFIG_HOME', '.config', env), 'agent-mailbox');
  if (profile) return path.join(dir, 'profiles', `${profile}.json`);
  return env.AGENT_MAILBOX_CONFIG || path.join(dir, 'config.json');
}

/**
 * The client config file as parsed JSON. It is hand-editable, so nothing in it is trusted:
 * `loadConfig` checks every field it uses.
 */
export interface ConfigFile {
  servers?: unknown;
  user?: unknown;
  password?: unknown;
  maxMessageBytes?: unknown;
  [field: string]: unknown;
}

/** The config file, or null when there is none. */
export function readConfigFile(env: Env = process.env): ConfigFile | null {
  const p = configPath(env);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as ConfigFile | null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ConfigError(`cannot read config ${p}: ${(e as Error).message}`);
  }
}

export const splitServers = (s: unknown): string[] =>
  lenientString(s)
    .split(',')
    .map((x) => x.trim().replace(/\/+$/, ''))
    .filter(Boolean);

/**
 * Load config (file, then env overrides). Throws ConfigError if incomplete.
 * -> {servers[], user, password, maxBytes|null}
 */
export function loadConfig(env: Env = process.env): Config {
  const profile = profileName(env);
  // A named profile is an identity: its user and password come from its file alone, so the
  // environment cannot quietly mix one person's profile with another's credentials.
  if (profile && (env.AGENT_MAILBOX_USER || env.AGENT_MAILBOX_PASSWORD))
    throw new ConfigError(
      `profile ${profile} takes its user and password from ${configPath(env)}; unset AGENT_MAILBOX_USER and AGENT_MAILBOX_PASSWORD`,
    );
  const file = readConfigFile(env) || {};
  const servers = env.AGENT_MAILBOX_SERVERS
    ? splitServers(env.AGENT_MAILBOX_SERVERS)
    : Array.isArray(file.servers)
      ? file.servers.flatMap(splitServers)
      : [];
  const user = lenientString(env.AGENT_MAILBOX_USER || file.user).trim();
  const password = lenientString(env.AGENT_MAILBOX_PASSWORD || file.password);
  const maxBytes = Number(env.AGENT_MAILBOX_MAX_BYTES || file.maxMessageBytes || 0);
  const missing: string[] = [];
  if (!servers.length) missing.push('servers');
  if (!user) missing.push('user');
  if (!password) missing.push('password');
  if (missing.length) {
    throw new ConfigError(
      `mailbox is not configured (missing ${missing.join(', ')}; looked in ${configPath(env)}). ` +
        `Run: mbox setup${profile ? ` --profile ${profile}` : ''} --servers <url> --user <name> --password-stdin`,
    );
  }
  if (!USER_RE.test(user)) throw new ConfigError(`user "${user}" is invalid (allowed: a-z 0-9 -)`);
  return {
    servers,
    user,
    password,
    maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : null,
  };
}

/** Write the client config with mode 0600 (it holds the password). */
export function writeConfig(
  { servers, user, password }: Pick<Config, 'servers' | 'user' | 'password'>,
  env: Env = process.env,
): string {
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
