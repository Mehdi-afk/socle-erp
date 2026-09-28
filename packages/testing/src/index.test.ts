// SPDX-License-Identifier: LGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { POSTGRES_IMAGE } from './index.js';

describe('@socle/testing', () => {
  it('pins the PostgreSQL image by digest', () => {
    expect(POSTGRES_IMAGE).toMatch(/^postgres:18\.\d+-alpine@sha256:[0-9a-f]{64}$/);
  });
});
