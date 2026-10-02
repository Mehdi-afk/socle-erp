// SPDX-License-Identifier: LGPL-3.0-only
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/browser/*.test.ts'],
    globalSetup: ['./src/global-setup.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 90_000,
    hookTimeout: 120_000,
  },
});
