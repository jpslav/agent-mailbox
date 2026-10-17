/**
 * `String(v)` for a value that came from outside the program (hand-edited JSON, an environment
 * variable, the wire): null and undefined become '', anything else is stringified as JavaScript
 * does. It is lenient on purpose: whatever a bad file or message holds, the caller gets a string
 * to validate or print, never an exception.
 */
export function lenientString(v: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- see above: coercing untrusted values is the point
  return String(v ?? '');
}
