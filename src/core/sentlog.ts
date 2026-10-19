// A session's sent log: one JSON line per message the session sent (`mbox send`, `mbox ask`), in
// `<state>/sessions/<sid>.sent.jsonl` (mode 0600). It exists because sent mail cannot be read back:
// it is stored for the recipient (their stream, the broadcast or the asks), not for the sender,
// and a sender may not read another user's mail (docs/DECISIONS.md, "Sent log and snapshot").
// `mbox snapshot` pairs it with received mail into threads.
//
// Append-only under a lock file, compacted to the newest SENT_KEEP records once the file passes
// SENT_COMPACT_BYTES. The file is hand-editable and can be cut short by a crash, so every line is
// checked on reading and a bad one is skipped; a missing file is an empty log.
import fs from 'node:fs';
import path from 'node:path';
import { areaOf } from './areas.js';
import { mkdirp, sentLogPath, withFileLock } from './state.js';
import { isService } from './services.js';
import type { Env, MailKind, SentRecord } from './types.js';

/** How many records the log keeps. */
export const SENT_KEEP = 500;
/** The body of a record is cut to this many characters. */
export const SENT_BODY_MAX = 2000;
/** A subject (of a record, or of mail in a snapshot) is cut to this many characters. */
export const SUBJECT_MAX = 300;
/**
 * Past this size the log is rewritten with only its newest SENT_KEEP records (which, with bodies
 * and subjects cut, stay well below it).
 */
export const SENT_COMPACT_BYTES = 2 * 1024 * 1024;

const KINDS: readonly MailKind[] = ['direct', 'broadcast', 'ask', 'service'];

/** How a message to `to` travels. */
export function kindOf(to: string): MailKind {
  if (to === 'all') return 'broadcast';
  if (areaOf(to) !== null) return 'ask';
  if (isService(to)) return 'service';
  return 'direct';
}

/** `s` cut to `max` characters (code units, never splitting a surrogate pair). */
export function cutText(s: string, max: number): { text: string; isTruncated: boolean } {
  if (s.length <= max) return { text: s, isTruncated: false };
  let text = s.slice(0, max);
  if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
  return { text, isTruncated: true };
}

/** What `mbox send` / `mbox ask` know about a message they sent. */
export interface SentInput {
  id: string;
  to: string;
  subject: string | null;
  body: string;
  inReplyTo: string | null;
  time?: number;
}

/** A subject cut to SUBJECT_MAX characters; null stays null. */
export const cutSubject = (s: string | null): string | null =>
  s === null ? null : cutText(s, SUBJECT_MAX).text;

/** The record for a sent message: kind and area from `to`, the body cut to SENT_BODY_MAX. */
export function sentRecord(m: SentInput): SentRecord {
  const { text, isTruncated } = cutText(m.body, SENT_BODY_MAX);
  return {
    id: m.id,
    to: m.to,
    kind: kindOf(m.to),
    area: areaOf(m.to),
    subject: cutSubject(m.subject),
    body: text,
    isTruncated,
    inReplyTo: m.inReplyTo,
    time: m.time ?? Date.now(),
  };
}

/** A line of the log, or null when it is not a well-formed record. */
export function checkSentRecord(v: unknown): SentRecord | null {
  if (!v || typeof v !== 'object') return null;
  // Read from a local, hand-editable file: untrusted until each field is checked.
  const o = v as Partial<Record<keyof SentRecord, unknown>>;
  const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
  if (typeof o.id !== 'string' || !o.id || typeof o.to !== 'string' || !o.to) return null;
  if (typeof o.body !== 'string' || typeof o.time !== 'number' || !Number.isFinite(o.time))
    return null;
  const kind = KINDS.find((k) => k === o.kind) ?? kindOf(o.to);
  const { text, isTruncated } = cutText(o.body, SENT_BODY_MAX);
  return {
    id: o.id,
    to: o.to,
    kind,
    area: areaOf(o.to),
    subject: cutSubject(str(o.subject)),
    body: text,
    isTruncated: isTruncated || o.isTruncated === true,
    inReplyTo: str(o.inReplyTo),
    time: o.time,
  };
}

function parseLines(text: string): SentRecord[] {
  const out: SentRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = checkSentRecord(JSON.parse(line) as unknown);
      if (r) out.push(r);
    } catch {
      /* a corrupt line: skipped */
    }
  }
  return out;
}

/** The session's sent records, oldest first: at most the newest SENT_KEEP. Never throws. */
export function readSentLog(sid: string, env: Env = process.env): SentRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(sentLogPath(sid, env), 'utf8');
  } catch {
    return [];
  }
  return parseLines(text).slice(-SENT_KEEP);
}

/**
 * Append `rec` to the session's sent log, compacting it when it grew past SENT_COMPACT_BYTES.
 * Throws when the state directory cannot be written; the caller only warns (the message is sent).
 */
export function appendSentLog(
  sid: string,
  rec: SentRecord,
  env: Env = process.env,
  {
    compactBytes = SENT_COMPACT_BYTES,
    keep = SENT_KEEP,
  }: { compactBytes?: number; keep?: number } = {},
): void {
  const file = sentLogPath(sid, env);
  mkdirp(path.dirname(file));
  withFileLock(`${file}.lock`, () => {
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', { mode: 0o600 });
    if (fs.statSync(file).size <= compactBytes) return;
    const kept = parseLines(fs.readFileSync(file, 'utf8')).slice(-keep);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, kept.map((r) => JSON.stringify(r) + '\n').join(''), { mode: 0o600 });
    fs.renameSync(tmp, file);
  });
}
