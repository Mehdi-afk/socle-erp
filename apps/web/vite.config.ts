// SPDX-License-Identifier: LGPL-3.0-only
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** API and HTML share an origin; cookies, Origin and CSRF are preserved by the dev proxy. */
export default defineConfig({
  plugins: [react()],
  envDir: false,
  server: {
    host: 'localhost',
    proxy: {
      '/auth/': { target: 'http://127.0.0.1:8069' },
      '/web/metadata': { target: 'http://127.0.0.1:8069' },
      '/rpc/': { target: 'http://127.0.0.1:8069' },
      '/mail/': { target: 'http://127.0.0.1:8069' },
    },
  },
});
