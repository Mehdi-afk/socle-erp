// SPDX-License-Identifier: LGPL-3.0-only
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import security from 'eslint-plugin-security';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const NODE_BUILTINS = [
  'node:*',
  'assert',
  'buffer',
  'child_process',
  'crypto',
  'dns',
  'events',
  'fs',
  'fs/promises',
  'http',
  'https',
  'net',
  'os',
  'path',
  'process',
  'stream',
  'tls',
  'url',
  'util',
  'worker_threads',
  'zlib',
];

const NETWORK_MODULES = [
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'dgram',
  'node:http',
  'node:https',
  'node:http2',
  'node:net',
  'node:tls',
  'node:dgram',
  'undici',
  'axios',
  'node-fetch',
  'got',
  'ky',
];

export default tseslint.config(
  {
    // spikes/*/builds: third-party code downloaded by a spike, never committed.
    // **/.tmp-tests: module directories written by the CLI tests, deleted after the run.
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '**/coverage/',
      '**/.turbo/',
      'spikes/**/builds/',
      '**/.tmp-tests/',
    ],
  },

  js.configs.recommended,
  security.configs.recommended,

  // Rules shared by every file (ARCHITECTURE.md §9.2, CLAUDE.md "Règles de code sécurisé")
  {
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Use the DOMPurify-based SafeHtml component instead of dangerouslySetInnerHTML.',
        },
      ],
    },
  },

  // TypeScript sources: type-aware rules
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-implied-eval': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      // Flags every `obj[variable]` (typed-array indices included): pure noise in typed code.
      // Compensated by strict typing (noUncheckedIndexedAccess), Map for untrusted keys and
      // Semgrep's prototype-pollution rules. Still active for plain JavaScript files.
      'security/detect-object-injection': 'off',
    },
  },

  // Tooling scripts and config files run on Node
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // Scripts deliberately read/execute paths they compute themselves.
    files: ['scripts/**/*.mjs'],
    rules: {
      'security/detect-non-literal-fs-filename': 'off',
      'security/detect-child-process': 'off',
    },
  },
  {
    // The CLI works on directories given by its operator (module roots, export and scaffold
    // directories). Paths are confined in code instead: loaded files must resolve inside their
    // module root (loader.ts), scaffolded names are validated by the manifest rules, exports
    // never overwrite (flag "wx").
    files: ['apps/cli/**/*.ts', 'packages/runtime/**/*.ts'],
    rules: { 'security/detect-non-literal-fs-filename': 'off' },
  },

  // Isomorphic core: no Node and no DOM dependency (ARCHITECTURE.md §3.2)
  {
    files: ['packages/framework/**/*.ts', 'packages/sync/**/*.ts', 'packages/crypto/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          // Exact module names: a pattern like "crypto" would also match "@socle/crypto".
          paths: NODE_BUILTINS.filter((name) => name !== 'node:*').map((name) => ({
            name,
            message: 'The isomorphic core must not depend on Node.',
          })),
          patterns: [
            { group: ['node:*'], message: 'The isomorphic core must not depend on Node.' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...[
          'window',
          'document',
          'navigator',
          'localStorage',
          'process',
          'Buffer',
          'require',
          '__dirname',
        ].map((name) => ({
          name,
          message: 'The isomorphic core must not depend on Node or the DOM.',
        })),
      ],
    },
  },

  // Modules may only use the public entry points of @socle/* packages (ARCHITECTURE.md §11.7)
  // and never reach the network directly: outgoing calls go through the capability-checked
  // HTTP client (ARCHITECTURE.md §11 bis).
  {
    files: ['modules/**/*.ts', 'modules/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NETWORK_MODULES.map((name) => ({
            name,
            message: 'Modules must use the HTTP client of their runtime context (capabilities).',
          })),
          patterns: [
            {
              group: [
                '@socle/*/src',
                '@socle/*/src/**',
                '**/packages/*/src',
                '**/packages/*/src/**',
              ],
              message: 'Modules may only import the public API of @socle/* packages.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'].map((name) => ({
          name,
          message: 'Modules must use the HTTP client of their runtime context (capabilities).',
        })),
      ],
    },
  },

  prettier,
);
