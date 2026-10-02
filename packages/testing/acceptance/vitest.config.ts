// SPDX-License-Identifier: LGPL-3.0-only
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/*.test.ts'],
    // One PostgreSQL container for the whole run (see src/global-setup.ts).
    globalSetup: ['./src/global-setup.ts'],
    // End-to-end: module installation (snapshots), HTTP server, several devices.
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
