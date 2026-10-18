// Help areas: what a session offers help on (`mbox offer <area>`) and where a session asks for
// help (`mbox ask <area> "<question>"`), for example `repo:github.com/acme/web`. An ask is
// delivered to every live session offering its area and stays queued on the server for sessions
// that offer it later. (The user-facing word is "area": "topic" is reserved for broker concepts by
// the transport-seam test, and "subject" is a message's subject line.)
//
// Like 'all' for broadcasts, an area travels through the transport as a pseudo-address,
// `area:<area>`; how it maps onto the broker is the transport's business.

/** The pseudo-address prefix of an area. */
export const AREA_PREFIX = 'area:';
/** The most areas one session may offer. */
export const MAX_OFFERS = 20;
/** The longest area name. */
export const AREA_MAX = 100;
// Lower case; a letter or digit first; then letters, digits and . _ : / @ + -
const AREA_RE = /^[a-z0-9][a-z0-9._:/@+-]*$/;

/** A well-formed area, or null. */
export const checkArea = (v: unknown): string | null =>
  typeof v === 'string' && v.length <= AREA_MAX && AREA_RE.test(v) ? v : null;

/** An area as a person types it: trimmed and lower-cased, or null when it is not well formed. */
export const normalizeArea = (v: string): string | null => checkArea(v.trim().toLowerCase());

/** The pseudo-address an area travels under. */
export const areaAddress = (area: string): string => `${AREA_PREFIX}${area}`;

/** The area of a pseudo-address `area:<area>`, or null for anything else (an address, 'all'). */
export function areaOf(to: unknown): string | null {
  if (typeof to !== 'string' || !to.startsWith(AREA_PREFIX)) return null;
  return checkArea(to.slice(AREA_PREFIX.length));
}

/**
 * Offers as read from a file or a peer's presence entry: the well-formed areas, de-duplicated,
 * sorted, at most MAX_OFFERS.
 */
export function checkOffers(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const ok = new Set<string>();
  for (const a of v as unknown[]) {
    const area = checkArea(a);
    if (area) ok.add(area);
  }
  return [...ok].sort().slice(0, MAX_OFFERS);
}
