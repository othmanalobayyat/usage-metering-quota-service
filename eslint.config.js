import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // k6 scripts run in k6's own JS runtime, which provides these globals.
  {
    files: ['load/**/*.js'],
    languageOptions: { globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly', console: 'readonly' } },
  },
  // Node scripts that load/uncontended.sh runs inside the API container.
  {
    files: ['load/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', fetch: 'readonly', performance: 'readonly' } },
  },
);
