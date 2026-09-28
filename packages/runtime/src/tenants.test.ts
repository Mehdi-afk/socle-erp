// SPDX-License-Identifier: LGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { isTenantName, tenantDatabase, TenantNameError, tenantOfDatabase } from './tenants.js';

describe('tenant names', () => {
  it('map to their database and back, injectively', () => {
    for (const tenant of ['acme', 'acme-sarl', 'b2', 'x1-y2-z3']) {
      expect(tenantOfDatabase(tenantDatabase(tenant)), tenant).toBe(tenant);
    }
    expect(tenantDatabase('acme-sarl')).toBe('socle_acme_sarl');
  });

  it('refuse anything that is not a subdomain label, and ignore other databases', () => {
    for (const bad of ['a', 'Acme', '1acme', 'acme-', 'ac--me', 'ac_me', 'x'.repeat(33), '../x']) {
      expect(isTenantName(bad), bad).toBe(false);
      expect(() => tenantDatabase(bad), bad).toThrow(TenantNameError);
    }
    for (const other of [
      'postgres',
      'template1',
      'snap_2026',
      'socle_',
      'socle_ac__me',
      'socle_Acme',
    ]) {
      expect(tenantOfDatabase(other), other).toBeUndefined();
    }
  });
});
