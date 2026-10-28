import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';

// Correctness checks, not a formatter. TypeScript owns its name resolution; unused-declaration style is out of scope;
// ESLint catches executable mistakes (unsafe finally blocks, async Promise executors, duplicate cases, etc.).
export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'vendor/**', 'state/**', 'work/**'] },
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    languageOptions: { parser: tsParser, globals: Object.fromEntries(['process', 'Buffer', 'console', 'fetch', 'URL', 'URLSearchParams', 'AbortSignal', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'window', 'document', 'performance', 'TextEncoder', 'TextDecoder', 'Headers', 'Request', 'Response', 'FormData', 'require', 'module', '__dirname', '__filename'].map(name => [name, 'readonly'])), ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'error',
      'no-unused-vars': 'off',
      'no-useless-escape': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  // These core rules cannot model TypeScript overloads/declaration merging; tsc validates them.
  { files: ['**/*.{ts,tsx}'], rules: { 'no-undef': 'off', 'no-dupe-class-members': 'off', 'no-redeclare': 'off' } },
];
