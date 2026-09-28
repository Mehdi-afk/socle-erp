// SPDX-License-Identifier: LGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from './index.js';

describe('@socle/ui', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@socle/ui');
  });
});
