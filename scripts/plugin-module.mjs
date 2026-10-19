#!/usr/bin/env node
// Checks the plugin's hooks module (adapters/claude-code/hooks/register.tsx and its files), which
// Claude Code loads itself rather than through the esbuild bundle.
//
//   node scripts/plugin-module.mjs typecheck   tsc against the Claude Code API declarations the
//                                              engine lays in .claude-plugin/types/ (git-ignored);
//                                              skipped, saying how to lay them, when they are absent
//   node scripts/plugin-module.mjs test        `claude plugin validate --strict` and
//                                              `claude plugin test` on the plugin, with the
//                                              Claude Code in CLAUDE_BIN (default: claude on PATH),
//                                              which must be at least the module's MIN_VERSION
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = join(root, 'adapters', 'claude-code');

/** The module's own minimum, so the number is written in one place. */
function minVersion() {
  const src = readFileSync(join(plugin, 'hooks', 'register.tsx'), 'utf8');
  const m = /const MIN_VERSION = '(\d+\.\d+\.\d+)'/.exec(src);
  if (!m) throw new Error('MIN_VERSION not found in hooks/register.tsx');
  return m[1];
}

// As isAtLeast in hooks/model.ts: `2.1.300-dev` counts as 2.1.300.
const parts = (v) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v) ?? [0, 0, 0, 0]).slice(1).map(Number);
function atLeast(v, min) {
  const [a, b] = [parts(v), parts(min)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

function typecheck() {
  if (!existsSync(join(plugin, '.claude-plugin', 'types', 'tsconfig.json'))) {
    console.log(
      'typecheck:plugin skipped: no Claude Code API declarations in adapters/claude-code/.claude-plugin/types/.\n' +
        'An interactive `claude --plugin-dir adapters/claude-code` session lays them (Claude Code ' +
        `${minVersion()} or newer); then run this again.`,
    );
    return 0;
  }
  return run(process.execPath, [
    join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p',
    plugin,
  ]);
}

function test() {
  const claude = process.env.CLAUDE_BIN || 'claude';
  const v = spawnSync(claude, ['--version'], { encoding: 'utf8' });
  if (v.error || v.status !== 0) {
    console.error(`test:plugin: cannot run ${claude} (set CLAUDE_BIN to a Claude Code binary)`);
    return 1;
  }
  const version = /(\d+\.\d+\.\d+\S*)/.exec(v.stdout)?.[1] ?? '0.0.0';
  const min = minVersion();
  if (!atLeast(version, min)) {
    console.error(
      `test:plugin: ${claude} is Claude Code ${version}; the hooks module needs ${min} or newer ` +
        '(set CLAUDE_BIN to a newer binary)',
    );
    return 1;
  }
  console.log(`test:plugin: Claude Code ${version}`);
  return (
    run(claude, ['plugin', 'validate', '--strict', plugin]) ||
    run(claude, ['plugin', 'test', plugin])
  );
}

const mode = process.argv[2];
const modes = { typecheck, test };
if (!(mode in modes)) {
  console.error('usage: node scripts/plugin-module.mjs typecheck|test');
  process.exit(2);
}
process.exit(modes[mode]());
