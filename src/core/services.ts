// Service addresses: a stable, host-independent address `<user>.<name>` (for example
// alice.helpdesk) that at most one live session of that user holds at a time
// (`mbox name --service <name>`). Mail to it queues on the server while nobody holds it and goes to
// the holder once there is one; whoever holds it next also gets what an earlier holder never
// acknowledged. A service address has two parts, a session address three, so the two never look
// alike. How a service maps onto the broker is the transport's business (transport.services and
// subscribe).
//
// The claim is one compare-and-set entry per service (Services in types.ts): claiming reads the
// entry and writes it back only if nobody wrote it in between, so of two sessions claiming at once
// exactly one wins. The entry expires with its holder's presence unless the holder's receiver keeps
// refreshing it, and a claim whose holder is not live (no presence entry for its session) may be
// taken without asking. Taking a live holder's claim needs `takeover`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BROADCAST, SEG_RE } from './addr.js';
import type { PresenceEntry, ServiceClaim, ServiceClaimRecord, Services } from './types.js';

/** The longest service name (the part after the user). */
export const SERVICE_NAME_MAX = 32;
/** The most service addresses one session may hold. */
export const MAX_SERVICES = 8;

export interface ParsedService {
  user: string;
  name: string;
}

/** `<user>.<name>` -> its parts, or null for anything else (a session address has three parts). */
export function parseService(s: unknown): ParsedService | null {
  if (typeof s !== 'string') return null;
  const parts = s.split('.');
  if (parts.length !== 2) return null;
  const [user, name] = parts as [string, string];
  if (!SEG_RE.test(user) || user === BROADCAST) return null;
  return checkServiceName(name) ? { user, name } : null;
}

export const isService = (s: unknown): boolean => parseService(s) !== null;

/** A well-formed service name: [a-z0-9-]+, at most SERVICE_NAME_MAX characters. */
export const checkServiceName = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= SERVICE_NAME_MAX && SEG_RE.test(v);

export const serviceAddress = (user: string, name: string): string => `${user}.${name}`;

/**
 * Service addresses as read from a session's state file: well-formed ones of `user` (any user when
 * not given), de-duplicated, sorted, at most MAX_SERVICES.
 */
export function checkServices(v: unknown, user?: string): string[] {
  if (!Array.isArray(v)) return [];
  const ok = new Set<string>();
  for (const s of v as unknown[]) {
    const p = parseService(s);
    if (p && (user === undefined || p.user === user)) ok.add(s as string); // parseService accepted it
  }
  return [...ok].sort().slice(0, MAX_SERVICES);
}

/** Who claims a service: the holding session's address and id. */
export interface ClaimInput {
  service: string;
  holder: string;
  session: string;
}

const record = (h: ClaimInput): ServiceClaimRecord => ({
  service: h.service,
  holder: h.holder,
  session: h.session,
  at: new Date().toISOString(),
});

/** How `claimService` went. */
export type ClaimResult =
  /** Now held by this session; `replaced` is the claim of another session it took over, if any. */
  | { status: 'claimed'; replaced: ServiceClaim | null }
  /** This session already held it (the claim is refreshed). */
  | { status: 'held' }
  /** Another live session holds it, and `takeover` was not asked for. */
  | { status: 'taken'; by: ServiceClaim };

export interface ClaimOptions {
  /** Take the service even from a live holder. */
  takeover?: boolean;
  /** Whether the session holding `claim` is live; a claim whose holder is not live is free. */
  isLive: (claim: ServiceClaim) => boolean | Promise<boolean>;
  /** Test-only fault injection: runs once, between reading the claim and writing it. */
  beforeWrite?: () => Promise<void>;
}

const ATTEMPTS = 5;

/**
 * Claim `h.service` for session `h.session`. Compare-and-set: the entry is written only if it is
 * still what was read, so of two sessions claiming at once one wins and the other, reading again,
 * finds the winner's claim (and gets 'taken' while the winner is live).
 */
export async function claimService(
  services: Services,
  h: ClaimInput,
  opts: ClaimOptions,
): Promise<ClaimResult> {
  for (let i = 0; i < ATTEMPTS; i++) {
    const { claim, version } = await services.read(h.service);
    if (claim && claim.session === h.session) {
      if (await services.write(record(h), version)) return { status: 'held' };
      continue;
    }
    if (claim && !opts.takeover && (await opts.isLive(claim)))
      return { status: 'taken', by: claim };
    if (i === 0) await opts.beforeWrite?.();
    if (await services.write(record(h), version)) return { status: 'claimed', replaced: claim };
  }
  const { claim } = await services.read(h.service);
  if (claim && claim.session !== h.session) return { status: 'taken', by: claim };
  throw new Error(`could not claim ${h.service}: its claim kept changing; try again`);
}

/**
 * Keep a held claim alive (a receiver's heartbeat): rewrite it while it still names this session,
 * or claim it again when it lapsed (no entry at all: it expired) and nobody took it. 'lost' when
 * another session holds it now, or released it: only `mbox name --service --release` releases a
 * claim, and the session releasing its own drops the service from its state first, so a released
 * service still in a session's state was taken over and then given up by someone else.
 */
export async function keepClaim(services: Services, h: ClaimInput): Promise<'held' | 'lost'> {
  for (let i = 0; i < ATTEMPTS; i++) {
    const { claim, version } = await services.read(h.service);
    if (claim ? claim.session !== h.session : version !== 0) return 'lost';
    if (await services.write(record(h), version)) return 'held';
  }
  const { claim } = await services.read(h.service);
  return claim?.session === h.session ? 'held' : 'lost';
}

/** Release `h.service` if this session holds it; true when it did. */
export async function releaseClaim(services: Services, h: ClaimInput): Promise<boolean> {
  for (let i = 0; i < ATTEMPTS; i++) {
    const { claim, version } = await services.read(h.service);
    if (!claim || claim.session !== h.session) return false;
    if (await services.remove(h.service, version)) return true;
  }
  return false;
}

/** Is the session holding `claim` live: does a presence entry of its user name its session? */
export function holderLive(claim: ServiceClaim, peers: PresenceEntry[]): boolean {
  const user = parseService(claim.service)?.user;
  return peers.some((p) => p.live && p.user === user && p.session === claim.session);
}

/**
 * Test-only fault injection (AGENT_MAILBOX_TEST_CLAIM_BARRIER=<dir>): a claim stops between reading
 * and writing until the test lets it go, so two claims are forced to read the same entry before
 * either writes. It writes `<dir>/<id>.ready` and waits for `<dir>/go` (60 s at most).
 */
export function claimBarrier(dir: string, sid: string): () => Promise<void> {
  return async () => {
    const id = crypto.createHash('sha256').update(sid).digest('hex').slice(0, 12);
    fs.writeFileSync(path.join(dir, `${id}.ready`), '');
    for (let i = 0; i < 2400 && !fs.existsSync(path.join(dir, 'go')); i++)
      await new Promise((r) => setTimeout(r, 25));
  };
}
