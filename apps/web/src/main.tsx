// SPDX-License-Identifier: LGPL-3.0-only
import '@socle/ui/styles.css';
import { createRoot } from 'react-dom/client';

import { WebApp } from './app.js';
import { parseAuthCallback } from './auth-client.js';

// Remove short-lived OIDC challenges from the address bar before any session lookup or render.
const callback = parseAuthCallback(window.location.hash);
if (window.location.hash !== '')
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
const root = document.getElementById('root');
if (root === null) throw new Error('Missing application root.');
createRoot(root).render(<WebApp {...(callback === undefined ? {} : { callback })} />);
