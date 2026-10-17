// Claude Code's per-session inbox socket: how the delivery daemon (`mbox deliverd`) posts mail
// into a session. Documented at https://code.claude.com/docs/en/cross-session-messaging
// ("The session's inbox socket"), which this relies on:
//   - its purpose includes the case "when you want a script or hook to post into a session";
//   - "Claude Code exports it to hooks and Bash commands as the CLAUDE_CODE_MESSAGING_SOCKET
//     environment variable", "before any hook runs, including SessionStart";
//   - "A script posting to its own session's socket can send {"type":"auth","token":"<token>"} as
//     the first line of its connection, where <token> is the value of CLAUDE_CODE_MESSAGING_TOKEN"
//     ("macOS and Linux, including WSL 2: the line is optional");
//   - "Claude Code closes a connection that hasn't sent a complete line within 30 seconds, so
//     capture a slow command's output first and then open the connection to send it";
//   - "When the receiving session is idle, Claude Code starts a new turn with the message";
//   - "Claude receives the message with the sender's name and a reply address";
//   - limits: "rate-limits repeated messages per sender, drops identical repeats arriving within a
//     short window, and queues at most 50 accepted messages"; inbound controls
//     (`crossSessionInbound`, permission-mode classes) can hold or refuse a message.
//
// The line format itself is NOT documented. It is taken from the Claude Code bundle (2.1.295,
// 2.1.296 and 2.1.299 agree). Its debug log prints this example:
//   { echo '{"type":"auth","token":"'"$CLAUDE_CODE_MESSAGING_TOKEN"'"}';
//     echo '{"type":"user","message":{"role":"user","content":"hello"}}'; } | socat - UNIX-CONNECT:<path>
// and its handler for a "user" line reads (minified):
//   let s=e.message?.content;if(typeof s!=="string"||s.length===0){...Ignoring user message with
//   missing or non-string content...}  if(!Ie(e))return;   // Ie: drops a line whose session_id
//   is set and differs from the session's id
//   ... origin {kind:"peer", from:e.from??"unknown", ...D$e(s)}   // D$e parses the content when it
//   is exactly <cross-session-message from="..." from-name="...">\n<body>\n</cross-session-message>
// Claude Code's own senders wrap a message that way; `from-name` is the sender name shown in the UI
// and to the model, `from` the reply address for its SendMessage tool. Lines are newline-delimited
// JSON, at most 1,048,576 characters per line. Nothing is written back on the connection.
//
// So each delivery is one connection: optional auth line, one "user" line, end. Mail is wrapped as
// a cross-session message whose from-name is the sender's mailbox address, WITHOUT a `from`
// attribute (SendMessage cannot reach a mailbox address; the text says to reply with `mbox send`).
// No `from-mode` is asserted: a session that bypasses permission prompts holds the message for its
// user's approval, exactly as for any sender that asserts nothing. If a future version stops
// accepting this shape, the line is still read as plain text ("content" is the only required
// field); if it rejects the line entirely, nothing reaches the session and the mail stays readable
// with `mbox inbox` / `mbox show` (see README, Delivery).
import net from 'node:net';

export const ENDPOINT_KIND = 'claude-inbox-socket';
export const TAG = 'cross-session-message';
export const MAX_LINE_CHARS = 1048576;
const ADDR_RE = /^[a-z0-9-]+\.[a-z0-9-]+\.[a-z0-9-]+$/;

/** The inbox endpoint a hook sees, or null when this session has no inbox socket. */
export function endpointFromEnv(env) {
  let p = env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (typeof p !== 'string' || !p) return null;
  if (p.startsWith('uds:')) {
    try { p = decodeURIComponent(p.slice(4)); } catch { return null; }
  }
  if (!p.startsWith('/')) return null; // native Windows named pipes: unsupported
  const token = typeof env.CLAUDE_CODE_MESSAGING_TOKEN === 'string' && env.CLAUDE_CODE_MESSAGING_TOKEN ? env.CLAUDE_CODE_MESSAGING_TOKEN : null;
  return { kind: ENDPOINT_KIND, path: p, token };
}

/** The sender name for a batch: the one sender's address, else a neutral name. */
export function senderName(senders = []) {
  return senders.length === 1 && ADDR_RE.test(senders[0]) ? senders[0] : 'agent-mailbox';
}

/** The message text Claude sees: mail blocks wrapped as one cross-session message. */
export function inboxContent(text, { senders = [] } = {}) {
  const name = senderName(senders);
  const lead =
    'Agent mailbox delivery (the mbox CLI, not Claude Code\'s own cross-session messaging). ' +
    'Reply with `mbox send <from> --re <id> "<text>"`; SendMessage cannot reach mailbox addresses.';
  // A body must not close the wrapper early (Claude Code escapes it the same way, "<\/...").
  const body = `${lead}\n${String(text).replace(/\n+$/, '')}`.replace(new RegExp(`<(?=/${TAG})`, 'gi'), '<\\');
  return `<${TAG} from-name="${name}">\n${body}\n</${TAG}>`;
}

/** The JSON lines for one delivery (auth line first when there is a token). */
export function inboxLines(endpoint, text, meta = {}) {
  const content = inboxContent(text, meta);
  const msg = { type: 'user', message: { role: 'user', content }, from: `mbox:${senderName(meta.senders)}` };
  if (meta.sid) msg.session_id = meta.sid; // Claude Code drops it if the session changed (e.g. /clear)
  const line = JSON.stringify(msg) + '\n';
  if (line.length > MAX_LINE_CHARS) throw Object.assign(new Error(`message too large for the inbox socket (${line.length} characters)`), { code: 'ETOOBIG' });
  return (endpoint.token ? JSON.stringify({ type: 'auth', token: endpoint.token }) + '\n' : '') + line;
}

/**
 * Connect, write, end, and resolve once Claude Code has closed its side (it has read everything).
 * Rejects with the socket error (ENOENT: no socket file; ECONNREFUSED: nobody listening) or ETIMEDOUT.
 */
export function postToSocket(socketPath, payload, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const sock = net.createConnection({ path: socketPath });
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => finish(Object.assign(new Error('inbox socket did not answer'), { code: 'ETIMEDOUT' })), timeoutMs);
    sock.on('connect', () => sock.end(payload));
    sock.on('error', (e) => finish(e));
    sock.on('close', (hadError) => finish(hadError ? Object.assign(new Error('inbox socket closed with an error'), { code: 'ECONNRESET' }) : undefined));
    sock.resume(); // it writes nothing today; never let a reply stall us
  });
}

export const inboxDelivery = {
  kind: ENDPOINT_KIND,
  /** Variables that name one session; the shared daemon must not inherit them. */
  sessionEnv: ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID'],
  endpointFromHook(_input, env) {
    return endpointFromEnv(env);
  },
  async deliver(endpoint, text, meta) {
    if (!endpoint || endpoint.kind !== ENDPOINT_KIND || typeof endpoint.path !== 'string') throw Object.assign(new Error('not an inbox socket endpoint'), { code: 'EINVAL' });
    await postToSocket(endpoint.path, inboxLines(endpoint, text, meta));
  },
};
