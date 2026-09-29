// SPDX-License-Identifier: LGPL-3.0-only
//
// The interactive style guide (`pnpm --filter @socle/ui guide`): a small page that shows the
// tokens and every component, with switches for the theme, the language (French, English,
// Arabic, right to left) and the density.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'guide',
  plugins: [react()],
  build: { outDir: '../dist/guide', emptyOutDir: true },
  server: { port: 6006, host: '127.0.0.1' },
});
