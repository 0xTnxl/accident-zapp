import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-sim/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/test-results/**',
      '**/playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Plain Node scripts (icon generation and similar) run outside the browser bundle.
    files: ['**/*.mjs', '**/scripts/**/*.{js,mjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    // The service worker runs in a worker scope. The two placeholders are replaced with the list of
    // built files by the Vite plugin at build time.
    files: ['**/sw.template.js'],
    languageOptions: {
      globals: { ...globals.serviceworker, __VERSION__: 'readonly', __PRECACHE__: 'readonly' },
    },
  },
);
