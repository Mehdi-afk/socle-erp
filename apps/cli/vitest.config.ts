// SPDX-License-Identifier: LGPL-3.0-only
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // One PostgreSQL container for every test file of the package (see global-setup.ts).
    globalSetup: ['./src/global-setup.ts'],
    // Module installs take snapshots (database copies): slower than a unit test.
    testTimeout: 60_000,
    // Modules written by the tests (with their own tests) live in .tmp-tests: never collected,
    // even when an interrupted run left some behind.
    exclude: [...configDefaults.exclude, '.tmp-tests/**'],
  },
});
