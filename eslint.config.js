import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config({ ignores: ['**/dist/**', 'node_modules/**', '.runtime/**', 'playwright-report/**', 'test-results/**'] },
  js.configs.recommended, ...ts.configs.recommended,
  { languageOptions: { globals: { process: 'readonly', Buffer: 'readonly', console: 'readonly', fetch: 'readonly', URL: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', AbortController: 'readonly', AbortSignal: 'readonly', TextDecoder: 'readonly', window: 'readonly', document: 'readonly', EventSource: 'readonly', localStorage: 'readonly', crypto: 'readonly', RequestInit: 'readonly', HTMLElement: 'readonly' } }, rules: { '@typescript-eslint/no-explicit-any': 'error', '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } });
