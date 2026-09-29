// SPDX-License-Identifier: LGPL-3.0-only
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/testing/setup.ts'],
    // CSS is checked by stylelint and by the token tests; components are tested for behaviour.
    css: false,
    // The guide tests render the whole page and run axe on it: slower on a busy machine.
    testTimeout: 30_000,
    include: ['src/**/*.test.{ts,tsx}', 'guide/**/*.test.{ts,tsx}'],
  },
});
