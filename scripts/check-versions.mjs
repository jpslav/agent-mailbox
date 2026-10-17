// Release hygiene checks, run by CI (and by hand):
//
//   node scripts/check-versions.mjs
//       package.json, package-lock.json and the Claude Code plugin manifest must carry the same
//       version.
//   node scripts/check-versions.mjs --base <git ref or sha>
//       Also: if adapters/claude-code/dist differs from <base>, the version must differ from
//       <base>'s version too. Installed plugin copies update only when the version changes, so a
//       changed build without a bump would never reach anyone. <base> must already be fetched.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = 'adapters/claude-code/.claude-plugin/plugin.json';
const DIST = 'adapters/claude-code/dist';

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const fail = (msg) => {
  console.error(`check-versions: ${msg}`);
  process.exit(1);
};

const lock = readJson('package-lock.json');
const versions = {
  'package.json': readJson('package.json').version,
  'package-lock.json': lock.version,
  'package-lock.json (packages[""])': lock.packages?.['']?.version,
  [PLUGIN]: readJson(PLUGIN).version,
};
for (const [file, v] of Object.entries(versions)) {
  if (typeof v !== 'string' || !/^\d+\.\d+\.\d+$/.test(v))
    fail(`${file} has no valid version (got ${JSON.stringify(v)})`);
}
if (new Set(Object.values(versions)).size !== 1) {
  fail(
    `versions differ:\n${Object.entries(versions)
      .map(([f, v]) => `  ${f}: ${v}`)
      .join('\n')}`,
  );
}
const version = versions['package.json'];
console.log(`versions agree: ${version}`);

const i = process.argv.indexOf('--base');
if (i !== -1) {
  const base = process.argv[i + 1];
  if (!base) fail('--base needs a git ref or sha');
  const changed = git('diff', '--name-only', base, 'HEAD', '--', DIST).trim();
  if (!changed) {
    console.log(`${DIST} is unchanged relative to ${base}: no bump required`);
  } else {
    const baseVersion = JSON.parse(git('show', `${base}:${PLUGIN}`)).version;
    if (baseVersion === version) {
      fail(
        `${DIST} changed relative to ${base} (${changed.split('\n').join(', ')}) but the version is still ${version}. Bump it in package.json, package-lock.json and ${PLUGIN} together (installed copies update only when the version changes).`,
      );
    }
    console.log(`${DIST} changed and the version moved ${baseVersion} -> ${version}`);
  }
}
