// ESLint flat config: ESLint's recommended rules, typescript-eslint's recommended type-checked
// rules, and eslint-config-prettier last (it turns off every rule that would fight Prettier's
// formatting). A rule is disabled only at the line that needs it, with a comment saying why.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['adapters/claude-code/dist/**', 'node_modules/**'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    // Plain Node scripts: not part of the TypeScript project, so no type information.
    files: ['**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
  },
  prettier,
);
