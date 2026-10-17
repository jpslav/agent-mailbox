// Claude Code's per-session inbox socket: how the delivery daemon (`mbox deliverd`) posts mail
// into a session. The documented parts, the reverse-engineered line format (with the source
// excerpts it was read from), what Claude sees, and how to tell that a new Claude Code version
// changed it are all in docs/PROTOCOL.md; keep this file, that document and `FakeInbox` in
// test/helpers.ts in step.
//
// In short: each delivery is one connection carrying an optional auth line (when the session has
// a token) and one `{"type":"user","message":{"role":"user","content":...}}` line, newline
// terminated, at most MAX_LINE_CHARS long. The content is the mail wrapped as a
// <cross-session-message from-name="<sender>"> element WITHOUT a `from` attribute (SendMessage
// cannot reach a mailbox address), and no permission mode, chain or hop is ever asserted.
import net from 'node:net';
import type { DeliveryCapability, DeliveryMeta, Endpoint, Env } from '../core/types.js';

export const ENDPOINT_KIND = 'claude-inbox-socket';
export const TAG = 'cross-session-message';
export const MAX_LINE_CHARS = 1048576;
const ADDR_RE = /^[a-z0-9-]+\.[a-z0-9-]+\.[a-z0-9-]+$/;

/** Where a Claude Code session's inbox socket is (the registration's `endpoint`). */
export interface InboxEndpoint extends Endpoint {
  kind: typeof ENDPOINT_KIND;
  /** The Unix socket path. */
  path: string;
  /** Sent as the first line when the session has one. */
  token: string | null;
}

/** The inbox endpoint a hook sees, or null when this session has no inbox socket. */
export function endpointFromEnv(env: Env): InboxEndpoint | null {
  let p = env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (typeof p !== 'string' || !p) return null;
  if (p.startsWith('uds:')) {
    try {
      p = decodeURIComponent(p.slice(4));
    } catch {
      return null;
    }
  }
  if (!p.startsWith('/')) return null; // native Windows named pipes: unsupported
  const token =
    typeof env.CLAUDE_CODE_MESSAGING_TOKEN === 'string' && env.CLAUDE_CODE_MESSAGING_TOKEN
      ? env.CLAUDE_CODE_MESSAGING_TOKEN
      : null;
  return { kind: ENDPOINT_KIND, path: p, token };
}

/** The sender name for a batch: the one sender's address, else a neutral name. */
export function senderName(senders: readonly string[] = []): string {
  const [only] = senders;
  return senders.length === 1 && only !== undefined && ADDR_RE.test(only) ? only : 'agent-mailbox';
}

/** The message text Claude sees: mail blocks wrapped as one cross-session message. */
export function inboxContent(
  text: string,
  { senders = [] }: { senders?: readonly string[] } = {},
): string {
  const name = senderName(senders);
  const lead =
    "Agent mailbox delivery (the mbox CLI, not Claude Code's own cross-session messaging). " +
    'Reply with `mbox send <from> --re <id> "<text>"`; SendMessage cannot reach mailbox addresses.';
  // A body must not close the wrapper early (Claude Code escapes it the same way, "<\/...").
  const body = `${lead}\n${String(text).replace(/\n+$/, '')}`.replace(
    new RegExp(`<(?=/${TAG})`, 'gi'),
    '<\\',
  );
  return `<${TAG} from-name="${name}">\n${body}\n</${TAG}>`;
}

/** The user line Claude Code reads from the socket. */
interface InboxUserLine {
  type: 'user';
  message: { role: 'user'; content: string };
  from: string;
  session_id?: string;
}

/** The JSON lines for one delivery (auth line first when there is a token). */
export function inboxLines(
  endpoint: Endpoint,
  text: string,
  meta: Partial<DeliveryMeta> = {},
): string {
  const content = inboxContent(text, meta);
  const msg: InboxUserLine = {
    type: 'user',
    message: { role: 'user', content },
    from: `mbox:${senderName(meta.senders)}`,
  };
  if (meta.sid) msg.session_id = meta.sid; // Claude Code drops it if the session changed (e.g. /clear)
  const line = JSON.stringify(msg) + '\n';
  if (line.length > MAX_LINE_CHARS)
    throw Object.assign(
      new Error(`message too large for the inbox socket (${line.length} characters)`),
      { code: 'ETOOBIG' },
    );
  return (
    (endpoint.token ? JSON.stringify({ type: 'auth', token: endpoint.token }) + '\n' : '') + line
  );
}

/**
 * Connect, write, end, and resolve once Claude Code has closed its side (it has read everything).
 * Rejects with the socket error (ENOENT: no socket file; ECONNREFUSED: nobody listening) or ETIMEDOUT.
 */
export function postToSocket(
  socketPath: string,
  payload: string,
  { timeoutMs = 10000 }: { timeoutMs?: number } = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false;
    const sock = net.createConnection({ path: socketPath });
    const finish = (err?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(Object.assign(new Error('inbox socket did not answer'), { code: 'ETIMEDOUT' })),
      timeoutMs,
    );
    sock.on('connect', () => sock.end(payload));
    sock.on('error', (e) => finish(e));
    sock.on('close', (hadError) =>
      finish(
        hadError
          ? Object.assign(new Error('inbox socket closed with an error'), { code: 'ECONNRESET' })
          : undefined,
      ),
    );
    sock.resume(); // it writes nothing today; never let a reply stall us
  });
}

export const inboxDelivery: DeliveryCapability = {
  kind: ENDPOINT_KIND,
  /** Variables that name one session; the shared daemon must not inherit them. */
  sessionEnv: [
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_PID',
  ],
  endpointFromHook(_input, env) {
    return endpointFromEnv(env);
  },
  async deliver(endpoint, text, meta) {
    if (!endpoint || endpoint.kind !== ENDPOINT_KIND || typeof endpoint.path !== 'string')
      throw Object.assign(new Error('not an inbox socket endpoint'), { code: 'EINVAL' });
    await postToSocket(endpoint.path, inboxLines(endpoint, text, meta));
  },
};
