// Adapter registry and resolution of "which agent am I running in / which session is this".
import { NoSessionError, sessionIdForHostPid, validateSessionId } from '../core/state.js';
import type { Env } from '../core/types.js';
import type { Adapter } from './adapter.js';
import claudeCode from './claude-code.js';

export type { Adapter, HookContext, HookHandler, HookInput, InstructionsContext } from './adapter.js';

/**
 * The adapter interface is `Adapter` in ./adapter.ts (a plain object):
 *   { id, displayName,
 *     detect(env) -> bool,            am I running inside this agent?
 *     sessionId(env) -> string|null,  this agent session's stable id
 *     hostPid(env) -> number|null,    the agent process, so `watch`/`wait` can exit when it dies
 *     hookInput(stdinJson) -> {sessionId, cwd}   (optional) what a hook payload says
 *     canWait(env) -> bool,           (optional) may `mbox wait --hook-stdin` block here? (default true)
 *     delivery: {                     (optional) push mail into a running session (`mbox deliverd`)
 *       kind,                           endpoint kind this adapter delivers to
 *       sessionEnv: [name],             env variables naming one session (the daemon drops them)
 *       endpointFromHook(stdinJson, env) -> endpoint|null    {kind, ...} saved in the registration
 *       async deliver(endpoint, text, meta) },  resolves once the agent has the text; throws if not.
 *                                       meta = {sid, address, count, ids, senders}
 *     hooks: { '<event>': async (stdinJson, ctx) -> stdout string },
 *     instructions(ctx) -> string }   text to inject into the agent's context
 */
export const adapters: Adapter[] = [claudeCode];

export const getAdapter = (id: string): Adapter | null => adapters.find((a) => a.id === id) || null;
export const detectAdapter = (env: Env): Adapter | null => adapters.find((a) => a.detect(env)) || null;

/**
 * Agent resolution: --agent, AGENT_MAILBOX_AGENT, the first adapter that detects itself, else 'unknown'.
 * Returns {id, adapter|null}. An explicit id without a registered adapter is kept as a label.
 */
export interface ResolvedAgent {
  id: string;
  adapter: Adapter | null;
}

export function resolveAgent({ agent, env = process.env }: { agent?: string; env?: Env } = {}): ResolvedAgent {
  const explicit = agent || env.AGENT_MAILBOX_AGENT;
  if (explicit) return { id: explicit, adapter: getAdapter(explicit) };
  const detected = detectAdapter(env);
  return detected ? { id: detected.id, adapter: detected } : { id: 'unknown', adapter: null };
}

/**
 * Session resolution: --session, AGENT_MAILBOX_SESSION, the session named by a hook payload (when
 * the command was given one), then the resolved adapter's sessionId(env) (and, failing that, a
 * session id recorded earlier for the adapter's host pid).
 */
export interface ResolvedSession {
  sid: string;
  /** The agent's id. */
  agent: string;
  adapter: Adapter | null;
  hostPid: number | null;
}

export function resolveSession({
  session,
  agent,
  hookSession = null,
  env = process.env,
}: { session?: string; agent?: ResolvedAgent; hookSession?: string | null; env?: Env } = {}): ResolvedSession {
  const a = agent || resolveAgent({ env });
  const hostPid = a.adapter?.hostPid(env) ?? null;
  const sid = session || env.AGENT_MAILBOX_SESSION || hookSession || a.adapter?.sessionId(env) || sessionIdForHostPid(hostPid, env);
  if (!sid) throw new NoSessionError();
  return { sid: validateSessionId(sid), agent: a.id, adapter: a.adapter, hostPid };
}
