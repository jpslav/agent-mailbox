// Presence records and peer resolution. Storing/expiring presence is the transport's job
// (transport.presence); this file only builds the record and resolves "who did the user mean".
import { isAddr, parseAddr } from './addr.js';
import type { Config, PresenceEntry, PresenceRecord, SessionState } from './types.js';

export const HEARTBEAT_MS = 10 * 60 * 1000;

/** The presence record for a session: what peers see in `mbox peers`. */
export function presenceRecord(
  st: SessionState,
  { sid, cfg, agent = 'unknown', pid = process.pid }: { sid: string; cfg: Pick<Config, 'user'>; agent?: string; pid?: number },
): PresenceRecord {
  return {
    address: st.address,
    aliases: st.aliases,
    session: sid,
    agent,
    user: cfg.user,
    host: parseAddr(st.address)?.host ?? null,
    cwd: st.cwd,
    pid,
  };
}

export class ResolveError extends Error {}

/** Who `resolveTarget` decided the user meant. */
export interface ResolvedTarget {
  to: string;
  live: boolean;
  peer: PresenceEntry | null;
}

/**
 * Resolve a user-supplied target against `peers` (transport.presence.list()).
 * Returns {to, live, peer}; `to` is 'all' for broadcast.
 */
export function resolveTarget(input: unknown, peers: PresenceEntry[]): ResolvedTarget {
  const raw = String(input).trim();
  if (!raw) throw new ResolveError('missing recipient');
  if (raw === 'all') return { to: 'all', live: true, peer: null };
  const live = peers.filter((p) => p.live);
  const nameOwners = new Map<string, PresenceEntry>(); // name -> peer
  for (const p of live) for (const n of [p.address, ...p.aliases]) if (!nameOwners.has(n)) nameOwners.set(n, p);

  if (isAddr(raw)) {
    const peer = nameOwners.get(raw) || null;
    return { to: raw, live: !!peer, peer };
  }
  // Every name here is a valid address (the transport only lists those), so `labelOf` never gets ''.
  const labelOf = (n: string): string => parseAddr(n)?.label ?? '';
  const tiers: Array<(n: string) => boolean> = [
    (n) => n === raw,
    (n) => labelOf(n) === raw,
    (n) => n.endsWith('.' + raw),
    (n) => n.startsWith(raw),
    (n) => labelOf(n).startsWith(raw),
  ];
  for (const match of tiers) {
    const hits = [...nameOwners.entries()].filter(([n]) => match(n));
    const first = hits[0];
    if (!first) continue;
    const sessions = new Set(hits.map(([, p]) => p.session));
    if (sessions.size > 1) {
      const lines = hits.map(([n, p]) => `  ${n}${n !== p.address ? ` (alias of ${p.address})` : ''}`);
      throw new ResolveError(`"${raw}" is ambiguous; matches ${sessions.size} live sessions:\n${lines.join('\n')}\nUse a longer prefix or the full address.`);
    }
    const peer = first[1];
    // Several names for one session: prefer an exact alias hit, else the primary address.
    const exact = hits.find(([n]) => n === raw);
    const name = exact ? exact[0] : hits.find(([n]) => n === peer.address)?.[0] ?? first[0];
    return { to: name, live: true, peer };
  }
  throw new ResolveError(
    `no live peer matches "${raw}". Run \`mbox peers\` to see live sessions, or use a full address (<user>.<host>.<label>) to queue a message anyway.`,
  );
}
