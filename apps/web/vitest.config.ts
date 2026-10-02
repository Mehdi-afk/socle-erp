// SPDX-License-Identifier: LGPL-3.0-only
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'transport', environment: 'node', include: ['src/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'screens',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
          setupFiles: ['../../packages/ui/src/testing/setup.ts'],
          css: false,
        },
      },
    ],
  },
});
