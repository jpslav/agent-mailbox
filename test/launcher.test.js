import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { LAUNCHER } from './helpers.js';

const home = os.homedir();
const system = ['/opt/homebrew/bin/node', '/home/linuxbrew/.linuxbrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
const known = [path.join(home, '.local/share/fnm/aliases/default/bin/node'), ...system];
// The launcher falls back to these fixed locations, so tests that need it to find nothing (or a
// specific fake node) only make sense on a machine that has no node in them.
const haveSystemNode = system.some((p) => fs.existsSync(p));
const haveKnownNode = known.some((p) => fs.existsSync(p)) || fs.existsSync(path.join(home, '.nvm/versions/node'));

describe('bin/mbox launcher', () => {
  it('finds node >= 18 with a minimal PATH', { skip: !haveKnownNode && 'no node in the launcher\'s well-known locations' }, () => {
    const r = spawnSync('env', ['-i', `HOME=${home}`, 'PATH=/usr/bin:/bin', LAUNCHER, '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Agent mailbox/);
  });
  it('explains itself when no node can be found', { skip: haveSystemNode && 'a system node exists in a fixed location the launcher checks' }, () => {
    const r = spawnSync('/bin/sh', [LAUNCHER, '--help'], { encoding: 'utf8', env: { PATH: '/nonexistent', HOME: '/nonexistent' } });
    assert.equal(r.status, 127);
    assert.match(r.stderr, /Node\.js >= 18/);
  });
  it('is executable and starts with a POSIX sh shebang', () => {
    assert.ok(fs.statSync(LAUNCHER).mode & 0o111);
    assert.equal(fs.readFileSync(LAUNCHER, 'utf8').split('\n')[0], '#!/bin/sh');
  });

  // A fake "node" that accepts the version probe and then identifies itself, planted where each
  // version manager keeps its installs, with a private HOME and a PATH that has no node.
  const fakeNode = (dir) => {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.writeFileSync(dir, '#!/bin/sh\n[ "$1" = -e ] && exit 0\necho "fake-node $0 $*"\n', { mode: 0o755 });
  };
  const run = (tmpHome, extra = {}) =>
    spawnSync('/bin/sh', [LAUNCHER, 'x'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: tmpHome, ...extra } });
  const skip = haveSystemNode && 'a system node exists in a fixed location the launcher checks';
  const mkHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'amb-launch-'));
  it('finds fnm under $XDG_DATA_HOME', { skip }, () => {
    const h = mkHome();
    fakeNode(path.join(h, 'xdg/fnm/node-versions/v20.1.0/installation/bin/node'));
    const r = run(h, { XDG_DATA_HOME: path.join(h, 'xdg') });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^fake-node .*mbox\.mjs x/);
  });
  it('finds nvm installs under $NVM_DIR and prefers the newest', { skip }, () => {
    const h = mkHome();
    fakeNode(path.join(h, 'nvm/versions/node/v18.2.0/bin/node'));
    fakeNode(path.join(h, 'nvm/versions/node/v20.10.0/bin/node'));
    const r = run(h, { NVM_DIR: path.join(h, 'nvm') });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^fake-node \S*v20\.10\.0\/bin\/node /);
  });
  it('finds the fnm default alias under ~/.local/share', { skip }, () => {
    const h = mkHome();
    fakeNode(path.join(h, '.local/share/fnm/aliases/default/bin/node'));
    assert.equal(run(h).status, 0);
  });
});
