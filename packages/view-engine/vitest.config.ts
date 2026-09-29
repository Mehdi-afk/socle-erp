// SPDX-License-Identifier: LGPL-3.0-only
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // The same browser stubs and matchers as the design system's component tests.
    setupFiles: ['../ui/src/testing/setup.ts'],
    css: false,
    include: ['src/**/*.test.{ts,tsx}'],
    testTimeout: 30_000,
  },
});
