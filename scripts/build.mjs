// Bundles src/cli.ts (+ commander and the NATS client) into adapters/claude-code/dist/mbox.mjs, which is checked in so the
// plugin works without `npm install`.
import { build } from 'esbuild';
import { chmodSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'adapters/claude-code/dist/mbox.mjs');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

await build({
  entryPoints: [path.join(root, 'src/cli.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  legalComments: 'none',
  // The bundle knows its own release (src/core/version.ts): the delivery daemon records it, and a
  // newer session-start hook takes delivery over from an older daemon.
  define: { __MBOX_VERSION__: JSON.stringify(version) },
  // commander is CommonJS and requires node builtins; give the ESM bundle a real `require`.
  banner: {
    js: "import { createRequire as __mbxCreateRequire } from 'node:module';\nconst require = __mbxCreateRequire(import.meta.url);",
  },
});
chmodSync(outfile, 0o755);
console.log(`built ${path.relative(root, outfile)}`);
