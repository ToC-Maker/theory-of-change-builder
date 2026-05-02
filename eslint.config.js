import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // `.claude/worktrees/` holds peer agent checkouts (gitignored). Each contains
  // a sibling tsconfig that confuses typescript-eslint's project resolution
  // ("multiple candidate TSConfigRootDirs are present"). Skip them outright.
  { ignores: ['dist', 'coverage', '.claude'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  // Must be last: turns off ESLint stylistic rules that would conflict with
  // Prettier (the formatter owns whitespace/quotes/semi/etc.).
  eslintConfigPrettier,
);
