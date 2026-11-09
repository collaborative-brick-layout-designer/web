// ESLint flat config for the whole workspace. It checks for real mistakes
// (unused code, hooks used wrongly, unsafe patterns); formatting is left
// alone on purpose, so there is no style churn. Lint runs without type
// information to stay fast.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    rules: {
      // Leading underscore marks an intentionally unused name.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ['apps/server/**/*.ts', 'packages/**/*.ts', 'apps/web/scripts/**', 'apps/web/e2e/**', '**/*.config.{js,ts}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // The app's own notices and questions (showNotice, showToast,
      // askConfirm, RenameDialog), never the browser's alert boxes.
      'no-alert': 'error',
    },
  },
);
