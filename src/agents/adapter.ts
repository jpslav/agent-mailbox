// The adapter contract: what an agent (Claude Code today) must provide so the mailbox can identify
// its sessions, get mail into them and tell them their address. Agent-neutral: nothing in
// src/core knows a specific agent; it only sees these interfaces. To add an agent, see the
// `add-adapter` skill.
import type { DeliveryCapability, Env, RegistrationInput, SessionState } from '../core/types.js';

export type { DeliveryCapability, DeliveryMeta } from '../core/types.js';

/** What a hook payload says: the session and the directory it works in. */
export interface HookInput {
  sessionId: string | null;
  cwd: string | null;
}

/** What `mbox hook <agent> <event>` hands to a hook handler, besides the hook's stdin JSON. */
export interface HookContext {
  env: Env;
  /** `--session` / AGENT_MAILBOX_SESSION: wins over what the hook payload says. */
  sessionOverride: string | null;
  /** The command that runs `mbox`, as the instructions should tell the model to call it. */
  launcher: string;
  /** Why the mailbox is not configured, or null when it is. */
  configError: string | null;
  /** Make sure the session has an address and a cursor; resolves to its state. */
  ensure(sid: string, cwd: string): Promise<SessionState>;
  /** The session ended: remove its presence entry. */
  endSession(sid: string): Promise<void>;
  /** Register the session for push delivery (writes its registration file). */
  register(reg: RegistrationInput): unknown;
  deregister(sid: string): unknown;
  /** Start the delivery daemon unless one is running. */
  startDeliverd(): unknown;
}

/** A hook handler: returns the text the hook prints on stdout ('' for nothing). */
export type HookHandler = (input: unknown, ctx: HookContext) => Promise<string>;

/** What `instructions` needs to know to tell the agent how to use the mailbox. */
export type InstructionsContext =
  | { configured: false; error: string; launcher: string }
  | { configured: true; address: string; launcher: string; /** Does the session receive mail by push? (default: yes) */ push?: boolean };

export interface Adapter {
  id: string;
  displayName: string;
  /** Am I running inside this agent? */
  detect(env: Env): boolean;
  /** This agent session's stable id. */
  sessionId(env: Env): string | null;
  /** The agent process, so receivers exit when it dies (no orphans). */
  hostPid(env: Env): number | null;
  /** What a hook payload says (session id, working directory). */
  hookInput?(input: unknown): HookInput;
  /** May `mbox wait --hook-stdin` block here? (default: yes) */
  canWait?(env: Env): boolean;
  /** Push mail into a running session (`mbox deliverd`). Agents without one use wait / watch. */
  delivery?: DeliveryCapability;
  /** Hook handlers by event name (`session-start`, `session-end`, ...). */
  hooks: Record<string, HookHandler>;
  /** Text to inject into the agent's context. */
  instructions(ctx: InstructionsContext): string;
}
