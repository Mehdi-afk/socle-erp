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

export default tseslint.config(
  {
    ignores: ['**/node_modules/', '**/dist/', '**/coverage/', '**/.turbo/'],
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

  // Isomorphic core: no Node and no DOM dependency (ARCHITECTURE.md §3.2)
  {
    files: ['packages/framework/**/*.ts', 'packages/sync/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: NODE_BUILTINS, message: 'The isomorphic core must not depend on Node.' },
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
  {
    files: ['modules/**/*.ts', 'modules/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
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
    },
  },

  prettier,
);
