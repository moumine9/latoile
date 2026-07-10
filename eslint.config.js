// ESLint flat config: latest recommended rules for JS + TypeScript.
// Compiled output and the browser bundle are linted at their TypeScript
// sources (src/, test/), never as build artifacts.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'public/', 'node_modules/', '.neo4j/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Repo convention: no `any` anywhere (CLAUDE.md); make it an error.
      '@typescript-eslint/no-explicit-any': 'error',
      // Intentionally-unused values must be prefixed with _ to stay visible.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  }
);
