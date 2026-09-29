// SPDX-License-Identifier: LGPL-3.0-only
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/testing/setup.ts'],
    // CSS is checked by stylelint and by the token tests; components are tested for behaviour.
    css: false,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
