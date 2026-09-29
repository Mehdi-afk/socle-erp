// SPDX-License-Identifier: LGPL-3.0-only
//
// Writes `src/tokens.css` from the design tokens: `pnpm --filter @socle/ui build:tokens`.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { tokensCss } from '../src/css.js';

const target = join(import.meta.dirname, '..', 'src', 'tokens.css');
writeFileSync(target, tokensCss(), 'utf8');
process.stdout.write(`Wrote ${target}\n`);
