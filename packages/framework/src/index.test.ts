// SPDX-License-Identifier: LGPL-3.0-only
import { describe, expect, it } from 'vitest';

import pkg from '../package.json' with { type: 'json' };
import { SOCLE_VERSION } from './index.js';

describe('@socle/framework', () => {
  it('exposes a core version equal to the package version', () => {
    expect(SOCLE_VERSION).toBe(pkg.version);
  });
});
