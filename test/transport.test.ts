// NATS transport: pure parts (address <-> subject mapping, names) and the seam itself.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  consumerName,
  createTransport,
  parseSubject,
  presenceKey,
  streamFor,
  subjectFor,
} from '../src/core/transport/nats.js';
import { ROOT } from './helpers.js';
import { describe, it } from './suite.js';

describe('subject mapping', () => {
  it('direct mail carries the sender user as the last token; broadcast is mbx.all.<sender>', () => {
    assert.equal(subjectFor('bob.build-box.web-1a2b', 'alice'), 'mbx.bob.build-box.web-1a2b.alice');
    assert.equal(subjectFor('all', 'alice'), 'mbx.all.alice');
    assert.deepEqual(parseSubject('mbx.bob.build-box.web-1a2b.alice'), {
      to: 'bob.build-box.web-1a2b',
      sender: 'alice',
    });
    assert.deepEqual(parseSubject('mbx.all.alice'), { to: 'all', sender: 'alice' });
    assert.equal(parseSubject('mbx.bob.h'), null);
    assert.equal(parseSubject('other.subject'), null);
  });
  it("maps a service address <user>.<name> into its user's stream, with the sender last", () => {
    assert.equal(subjectFor('bob.helpdesk', 'alice'), 'mbx.bob._svc.helpdesk.alice');
    assert.deepEqual(parseSubject('mbx.bob._svc.helpdesk.alice'), {
      to: 'bob.helpdesk',
      sender: 'alice',
    });
    // `_svc` is no host ([a-z0-9-]+), so no session address maps there, and a malformed one is no mail
    assert.equal(parseSubject('mbx.bob._svc.Help.alice'), null);
    assert.equal(parseSubject('mbx.bob._svc.helpdesk'), null);
    assert.throws(() => subjectFor('all.helpdesk', 'alice'));
    assert.throws(() => subjectFor(`bob.${'x'.repeat(33)}`, 'alice'));
    assert.throws(() => subjectFor('bob.help_desk', 'alice'));
  });
  it('rejects bad addresses, the reserved user "all", and bad senders', () => {
    assert.throws(() => subjectFor('a', 'alice'));
    assert.throws(() => subjectFor('a.b.c.d', 'alice'));
    assert.throws(() => subjectFor('all.h.l', 'alice'), /reserved/);
    assert.throws(() => subjectFor('bob.h.l', 'Alice'), /sender/);
    assert.throws(() => subjectFor('bob.h.*', 'alice'));
  });
  it('per-user stream names map "-" to "_" (user names cannot contain "_", so no collisions)', () => {
    assert.equal(streamFor('alice'), 'MBX_ALICE');
    assert.equal(streamFor('mary-jo'), 'MBX_MARY_JO');
  });
  it('consumer names and presence keys are safe tokens', () => {
    assert.equal(consumerName('9f3e1c2a-d607-4257'), '9f3e1c2a-d607-4257');
    assert.match(consumerName('has.dots.in.it'), /^s-[0-9a-f]{32}$/);
    assert.notEqual(consumerName('a.b'), consumerName('a_b'));
    assert.match(presenceKey('alice', 'laptop', 'sess.1'), /^alice\.laptop\.[0-9a-f]{12}$/);
  });
  it('validates server URLs and caps labels', () => {
    assert.throws(
      () => createTransport({ servers: ['http://x'], user: 'u', password: 'p' }),
      /nats:\/\//,
    );
    const t = createTransport({
      servers: ['nats://127.0.0.1:1', 'tls://mailbox-host.example.ts.net:4222'],
      user: 'u',
      password: 'p',
    });
    assert.equal(t.limits.maxLabelLen('alice', 'laptop'), 128 - 'alice.laptop.'.length);
  });
});

describe('transport seam', () => {
  // Every .ts source file under `d`, except the transport directory (the one place that may name the broker).
  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((f) => {
      if (f.isDirectory()) return f.name === 'transport' ? [] : walk(path.join(d, f.name));
      return f.name.endsWith('.ts') ? [path.join(d, f.name)] : [];
    });
  const strip = (code: string): string =>
    code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // Broker concepts that must stay inside src/core/transport/.
  const FORBIDDEN =
    /\bnats\b|@nats-io|\$JS|\$KV|jetstream|\bmbx\.|_INBOX|filter_subjects?|\bsubjects\b|\bdurable|\bconsumer|\bKvm\b|\bfetch\(|\btopic|ntfy|Authorization/i;
  it('core, agents and the CLI know nothing about subjects, $JS, JetStream or NATS', () => {
    const files = [...walk(path.join(ROOT, 'src/core')), ...walk(path.join(ROOT, 'src/agents'))];
    assert.ok(files.length >= 8);
    for (const f of files)
      assert.doesNotMatch(strip(fs.readFileSync(f, 'utf8')), FORBIDDEN, path.relative(ROOT, f));
    const cli = fs.readFileSync(path.join(ROOT, 'src/cli.ts'), 'utf8');
    const imports = [...cli.matchAll(/from '([^']+)'/g)].map((m) => m[1] ?? '');
    assert.deepEqual(
      imports.filter((i) => i.includes('transport')),
      ['./core/transport/nats.js'],
    ); // the single place that picks the broker
    assert.doesNotMatch(strip(cli).replace("'./core/transport/nats.js'", ''), FORBIDDEN);
  });
  it('the transport directory holds only the NATS transport', () => {
    assert.deepEqual(fs.readdirSync(path.join(ROOT, 'src/core/transport')), ['nats.ts']);
  });
});

describe('subscribe', () => {
  it('an abort while it is still connecting ends it at once with an AbortError', async () => {
    // A server that accepts the connection and never answers: connecting hangs until its timeout.
    const sockets = new Set<net.Socket>();
    const server = net.createServer((s) => void sockets.add(s));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as net.AddressInfo; // listening on TCP: an AddressInfo
    try {
      const t = createTransport({
        servers: [`nats://127.0.0.1:${port}`],
        user: 'u',
        password: 'p',
      });
      const ac = new AbortController();
      const sub = t.subscribe({
        session: 's',
        addresses: ['u.h.l'],
        signal: ac.signal,
        onMessage: () => undefined,
      });
      while (!sockets.size) await new Promise((r) => setTimeout(r, 10)); // it is connecting
      ac.abort();
      // Without honouring the abort it would end with the connect timeout's error instead.
      await assert.rejects(sub, { name: 'AbortError' });
    } finally {
      for (const s of sockets) s.destroy();
      server.close();
    }
  });
});
