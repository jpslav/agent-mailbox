---
name: add-adapter
description: Add support for a new agent type (for example Codex) to agent-mailbox as an adapter. Use when asked to make the mailbox work with another coding agent; nothing in src/core should need to change.
---

# Add an agent adapter

An adapter teaches the mailbox three things about an agent: how to identify a session, how to get
mail into it, and how to tell it its address. The full description is README.md, "Adding an agent
adapter"; the interface is documented at the top of `src/agents/index.ts`; the reference
implementation is `src/agents/claude-code.ts` with `adapters/claude-code/`. `<agent>` below is the
adapter id (lowercase, for example `codex`).

1. **Research the agent first, from its documentation or by experiment, and write down what you
   find** (put it in `docs/PROTOCOL.md` as a new section if it is an undocumented protocol, and
   record any non-obvious choice in `docs/DECISIONS.md`):
   - What is a stable per-conversation session id (an env var, a field in a hook payload)? Which
     process is the agent (for `hostPid`)?
   - How can text get into a running session? Best: a push channel that a local process can post
     into, which starts a turn when the session is idle (Claude Code's inbox socket). Otherwise
     the generic fallbacks apply: `mbox wait` (needs background tasks that notify the model when
     they exit) or `mbox watch` (needs a stdout-to-model stream).
   - Where can the agent be told its address at session start (a hook, an instructions file)? And
     is there a session-end hook?
2. **Write `src/agents/<agent>.ts`**, a plain object that `satisfies Adapter` (the interface in
   `src/agents/adapter.ts`, with its `HookContext`, `HookInput` and `InstructionsContext`):
   `{id, displayName, detect(env), sessionId(env), hostPid(env), hookInput?, canWait?, delivery?, hooks, instructions(ctx)}`.
   It is strict TypeScript: no `any`, and a hook payload is `unknown` until you have checked it.
   A `delivery` capability is a `DeliveryCapability` (`src/core/types.ts`).
   `hooks['session-start']` returns the text injected into the agent's context (use
   `instructions(ctx)`); with push delivery it registers the session (`ctx.register`) and starts
   the daemon (`ctx.startDeliverd()`), and `hooks['session-end']` calls `ctx.deregister`. A
   `delivery` capability is `{kind, sessionEnv, endpointFromHook(stdinJson, env), async deliver(endpoint, text, meta)}`
   and must throw when the agent did not take the text (the mail is acknowledged only after
   `deliver` succeeds). Never assert a permission mode, a relay chain or a reply address that the
   mailbox is not (the "honest sender" rule, `docs/DECISIONS.md`).
3. **Register it** in `src/agents/index.ts` (add the import and append to `adapters`).
4. **Add `adapters/<agent>/`** with whatever that agent loads: its manifest or config, hooks
   config calling `mbox hook <agent> <event>`, an instructions or skill file, and a POSIX `sh`
   launcher (copy `adapters/claude-code/bin/mbox`; it finds a Node.js >= 18 and runs
   `dist/mbox.mjs`). The bundled CLI is built once for all adapters; do not fork it.
5. **Do not touch `src/core/`.** If you must, the abstraction is wrong: stop and ask the repo
   owner. Do not mention NATS concepts in `src/agents/` (`test/transport.test.ts` enforces it).
6. **Tests**, modelled on `test/agents.test.ts` (registry, `detect`/`sessionId`/`hostPid`,
   `instructions`) and `test/hook.test.ts` (the hooks through the real CLI, with a temp
   `AGENT_MAILBOX_CONFIG` and `AGENT_MAILBOX_STATE_DIR`). For push delivery, add a fake endpoint
   like `FakeInbox` in `test/helpers.ts` and a daemon test like `test/deliverd.test.ts`. Tests must
   not depend on timing (CLAUDE.md, "Tests must hold under load").
7. **Build and verify**:

   ```sh
   npm run typecheck && npm run lint && npm run format:check
   npm run build && npm test
   claude plugin validate ./adapters/claude-code --strict && claude plugin validate . --strict
   for f in adapters/*/bin/mbox server/*.sh; do sh -n "$f"; done
   ```

   Then try it in a real session of that agent, in a visible terminal where a human can watch
   (the `live-test` skill is the recipe: adapt the two prompts and the launch command to the
   agent). Never run the agent headless for this.
8. **Docs**: README.md (supported agents, the adapter section if the interface grew), CHANGELOG.md
   (Added), and a CLAUDE.md line if a new rule came out of it. If the adapter ships files users
   install, bump the version (`release` skill) and make sure the marketplace entry covers it.
9. **Ship** with the `ship-change` skill. A new delivery protocol (a new way of pushing text into
   sessions) is a `needs-owner` change.
