// SPDX-License-Identifier: LGPL-3.0-only
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // One PostgreSQL container for every test file of the package (see global-setup.ts).
    globalSetup: ['./src/global-setup.ts'],
    // Real PostgreSQL: a full parallel run of every package can slow the first queries down.
    testTimeout: 30_000,
  },
});
