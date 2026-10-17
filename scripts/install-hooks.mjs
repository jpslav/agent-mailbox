// Run by `npm run prepare` (so by `npm install` and `npm ci`): installs the git hooks that
// package.json configures under "simple-git-hooks" (pre-commit: lint-staged; pre-push: typecheck
// and the fast unit tests). It never fails an install, and does nothing in CI, outside a git
// checkout, or when the dev dependencies are not installed.
//
// Skip it explicitly with SKIP_INSTALL_SIMPLE_GIT_HOOKS=1 (simple-git-hooks's own switch, which
// also stops its postinstall). Bypass an installed hook for one command with `--no-verify` or
// SKIP_SIMPLE_GIT_HOOKS=1 (see CONTRIBUTING.md).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'node_modules', '.bin', 'simple-git-hooks');
const skip = (why) => console.log(`git hooks not installed: ${why}`);

if (process.env.CI) skip('CI is set');
else if (['1', 'true'].includes(process.env.SKIP_INSTALL_SIMPLE_GIT_HOOKS ?? ''))
  skip('SKIP_INSTALL_SIMPLE_GIT_HOOKS is set');
else if (!existsSync(path.join(root, '.git'))) skip('not a git checkout');
else if (!existsSync(bin)) skip('dev dependencies are not installed');
else {
  const r = spawnSync(bin, [], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) console.log('git hooks could not be installed; continuing');
}
