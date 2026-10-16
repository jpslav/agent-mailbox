// Adapter registry and resolution of "which agent am I running in / which session is this".
import { NoSessionError, sessionIdForHostPid, validateSessionId } from '../core/state.js';
import claudeCode from './claude-code.js';

/**
 * Adapter interface (plain object):
 *   { id, displayName,
 *     detect(env) -> bool,            am I running inside this agent?
 *     sessionId(env) -> string|null,  this agent session's stable id
 *     hostPid(env) -> number|null,    the agent process, so `watch` can exit when it dies
 *     hooks: { '<event>': async (stdinJson, ctx) -> stdout string },
 *     instructions(ctx) -> string }   text to inject into the agent's context
 */
export const adapters = [claudeCode];

export const getAdapter = (id) => adapters.find((a) => a.id === id) || null;
export const detectAdapter = (env) => adapters.find((a) => a.detect(env)) || null;

/**
 * Agent resolution: --agent, AGENT_MAILBOX_AGENT, the first adapter that detects itself, else 'unknown'.
 * Returns {id, adapter|null}. An explicit id without a registered adapter is kept as a label.
 */
export function resolveAgent({ agent, env = process.env } = {}) {
  const explicit = agent || env.AGENT_MAILBOX_AGENT;
  if (explicit) return { id: explicit, adapter: getAdapter(explicit) };
  const detected = detectAdapter(env);
  return detected ? { id: detected.id, adapter: detected } : { id: 'unknown', adapter: null };
}

/**
 * Session resolution: --session, AGENT_MAILBOX_SESSION, then the resolved adapter's sessionId(env)
 * (and, failing that, a session id recorded earlier for the adapter's host pid).
 */
export function resolveSession({ session, agent, env = process.env } = {}) {
  const a = agent || resolveAgent({ env });
  const hostPid = a.adapter?.hostPid(env) ?? null;
  const sid = session || env.AGENT_MAILBOX_SESSION || a.adapter?.sessionId(env) || sessionIdForHostPid(hostPid, env);
  if (!sid) throw new NoSessionError();
  return { sid: validateSessionId(sid), agent: a.id, adapter: a.adapter, hostPid };
}
