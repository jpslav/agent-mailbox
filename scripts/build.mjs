// Bundles src/cli.ts (+ commander and the NATS client) into adapters/claude-code/dist/mbox.mjs, which is checked in so the
// plugin works without `npm install`.
import { build } from 'esbuild';
import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'adapters/claude-code/dist/mbox.mjs');

await build({
  entryPoints: [path.join(root, 'src/cli.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  legalComments: 'none',
  // commander is CommonJS and requires node builtins; give the ESM bundle a real `require`.
  banner: {
    js: "import { createRequire as __mbxCreateRequire } from 'node:module';\nconst require = __mbxCreateRequire(import.meta.url);",
  },
});
chmodSync(outfile, 0o755);
console.log(`built ${path.relative(root, outfile)}`);
