// The mailbox panel's contract: the snapshot it draws (`mbox snapshot --json` v1, or the same
// object from the delivery daemon's ui.sock; docs/PROTOCOL.md) and the values it keeps in
// `$.state`. Every free-text field came from other sessions and is drawn as plain text only.

export type Kind = 'direct' | 'broadcast' | 'ask' | 'service';
export type Relation =
  'parent' | 'child' | 'sibling' | 'same-repo' | 'correspondent' | 'mine' | 'other';

export type Self = {
  address: string;
  aliases: string[];
  user: string;
  host: string;
  title: string | null;
  status: string | null;
  role: string | null;
  parent: string | null;
  offers: string[];
  services: string[];
  repo: string | null;
  branch: string | null;
};

export type Peer = Self & {
  agent: string | null;
  /** Epoch ms. */
  lastSeen: number;
  relation: Relation;
};

export type Mail = {
  id: string;
  from: string;
  to: string;
  kind: Kind;
  area: string | null;
  subject: string | null;
  body: string;
  isTruncated: boolean;
  verifiedUser: string;
  isMismatch: boolean;
  inReplyTo: string | null;
  /** Epoch ms. */
  time: number;
};

export type ThreadMessage = {
  id: string;
  dir: 'in' | 'out';
  time: number;
  subject: string | null;
  firstLine: string;
  inReplyTo: string | null;
};

export type Thread = {
  with: string;
  kind: Kind;
  lastAt: number;
  count: number;
  isAwaitingMe: boolean;
  messages: ThreadMessage[];
};

export type Area = { area: string; offeredBy: number; isMine: boolean };

export type Snapshot = {
  v: 1;
  at: number;
  self: Self;
  peers: Peer[];
  mail: Mail[];
  threads: Thread[];
  areas: Area[];
  socket: string | null;
};

/** Where the last snapshot came from and what it cost (the panel's footer). */
export type Source = {
  kind: 'socket' | 'snapshot' | 'none';
  /** Process spawns since the module loaded. */
  spawns: number;
  /** Socket polls since load, and how many came back 304 (unchanged). */
  polls: number;
  unchanged: number;
  /** Refreshes whose result equalled the last one (no state write, no redraw). */
  skipped: number;
  lastAt: number;
  error: string | null;
};

declare module 'claude-code' {
  interface PluginState {
    'agent-mailbox': {
      snap: Snapshot | null;
      source: Source | null;
      /** Whether the ask-for-help form is shown. */
      showAsk: boolean;
      /** The cards shown open: `t:<with>` for a conversation, `p:<address>` for a peer. */
      open: string[];
      showOthers: boolean;
      /** The last action's outcome line (copy, send, offer...). */
      notice: string | null;
      shareTitle: boolean;
      /** The copy button that just copied (its key), shown as a check mark for a moment. */
      copied: string | null;
      /** The area the ask form sends to. */
      askArea: string | null;
    };
  }
}
