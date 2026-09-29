// SPDX-License-Identifier: LGPL-3.0-only
//
// The demo of the view engine (`pnpm --filter @socle/view-engine demo`): a contact list of 5 000
// records and a contact card, on in-memory data, to see the screens before the server is connected.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'demo',
  plugins: [react()],
  build: { outDir: '../dist/demo', emptyOutDir: true },
  server: { port: 6007, host: '127.0.0.1' },
});
