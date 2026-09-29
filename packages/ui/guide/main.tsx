// SPDX-License-Identifier: LGPL-3.0-only
import { createRoot } from 'react-dom/client';

import '../src/styles.css';
import './guide.css';
import { Guide } from './guide.js';

const root = document.getElementById('root');
if (root) createRoot(root).render(<Guide />);
