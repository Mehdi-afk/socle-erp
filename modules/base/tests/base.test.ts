// SPDX-License-Identifier: LGPL-3.0-only
import {
  buildModelRegistry,
  buildSecurityPolicy,
  buildViewRegistry,
  rulesOf,
  securityRecords,
  type ModelDefinition,
} from '@socle/framework';
import { describe, expect, it } from 'vitest';

import manifest from '../manifest.js';
import companyScoped from '../models/company-scoped.js';
import configParameter from '../models/ir-config-parameter.js';
import accessAndRules from '../models/ir-model-access.js';
import company from '../models/res-company.js';
import countries from '../models/res-country.js';
import currencies from '../models/res-currency.js';
import groupsModel from '../models/res-groups.js';
import partner from '../models/res-partner.js';
import users from '../models/res-users.js';
import access from '../security/access.js';
import groups from '../security/groups.js';
import rules from '../security/rules.js';
import views from '../views/base.views.js';

const models: ModelDefinition[] = [
  companyScoped,
  company,
  partner,
  users,
  groupsModel,
  ...accessAndRules,
  ...currencies,
  ...countries,
  configParameter,
];
const security = { module: manifest.name, groups, access, rules };

describe('base', () => {
  for (const side of ['server', 'client'] as const) {
    it(`composes on the ${side}`, () => {
      const registry = buildModelRegistry([{ module: 'base', models }], { side });
      buildSecurityPolicy([security], (m) => registry.has(m));
      buildViewRegistry([{ module: 'base', views }], registry);
      // A user exposes the fields of its contact (delegation).
      expect(registry.field('res.users', 'email')?.related).toBe('partnerId.email');
    });
  }

  it('applies the authorised-company rule to every company-scoped model', () => {
    const registry = buildModelRegistry([{ module: 'base', models }], { side: 'server' });
    const policy = buildSecurityPolicy([security], (m) => registry.has(m));
    for (const model of ['res.partner', 'res.currency.rate', 'ir.config_parameter']) {
      const meta = registry.get(model);
      expect(meta.mixins, model).toContain('company.scoped');
      expect(
        rulesOf(policy, model, meta.mixins).map((rule) => rule.id),
        model,
      ).toContain('base.company_scoped');
    }
    expect(rulesOf(policy, 'res.country', registry.get('res.country').mixins)).toEqual([]);
  });

  it('mirrors its security declarations as data of the base models', () => {
    const data = securityRecords(security, () => true);
    expect(data.map((set) => set.model)).toEqual(['res.groups', 'ir.model.access', 'ir.rule']);
    const [groupData, accessData, ruleData] = data;
    expect(groupData?.records.map((record) => record.id)).toEqual([
      'group_user',
      'group_erp_manager',
      'group_system',
    ]);
    expect(groupData?.records[2]?.values.impliedIds).toEqual([{ $ref: 'base.group_erp_manager' }]);
    expect(new Set(accessData?.records.map((record) => record.id)).size).toBe(access.length);
    expect(ruleData?.records.map((record) => record.values.code)).toEqual([
      'base.company_scoped',
      'base.company_allowed',
    ]);
    expect(securityRecords(security, () => false)).toEqual([]);
  });
});
