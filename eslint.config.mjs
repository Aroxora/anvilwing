// ESLint v9 flat config. The repo had eslint + the typescript-eslint plugins
// in deps and a `npm run lint` script but no config file, so lint was a
// no-op. This is a minimal v9 setup that mirrors what the package.json was
// implying (TS in src/**/*.ts, recommended typescript-eslint rules).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

export default [
  {
    ignores: [
      'dist/**',
      'build/**',
      'node_modules/**',
      'scripts/**',
      'test/**',
      '__mocks__/**',
      '*.cjs',
      '*.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    plugins: { import: importPlugin },
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    rules: {
      // The codebase has many established patterns that pre-date v9; keep
      // these warnings rather than errors so the loop surfaces real bugs
      // (parse failures, unreachable code) without 1,000s of style nags.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
      'no-useless-escape': 'warn',
      'no-misleading-character-class': 'off',
      'no-prototype-builtins': 'off',
      'no-async-promise-executor': 'warn',
      'no-undef': 'off',
    },
  },
];
