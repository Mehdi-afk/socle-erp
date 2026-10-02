// SPDX-License-Identifier: LGPL-3.0-only
import {
  buildModelRegistry,
  buildSecurityPolicy,
  buildViewRegistry,
  rulesOf,
  securityRecords,
  type ModelDefinition,
  type ViewNode,
} from '@socle/framework';
import { describe, expect, it } from 'vitest';

import manifest from '../manifest.js';
import companyScoped from '../models/company-scoped.js';
import attachment from '../models/ir-attachment.js';
import configParameter from '../models/ir-config-parameter.js';
import cronModels from '../models/ir-cron.js';
import sequence, { formatSequence, localDate } from '../models/ir-sequence.js';
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
  sequence,
  attachment,
  ...cronModels,
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

  it('declares contact widgets so composed forms and lists preserve their direction in Arabic', () => {
    const registry = buildModelRegistry([{ module: 'base', models }], { side: 'server' });
    const composed = buildViewRegistry([{ module: 'base', views }], registry);
    const fieldsOf = (node: ViewNode): readonly ViewNode[] =>
      node.type === 'field' ? [node] : node.children.flatMap(fieldsOf);
    for (const [view, expected] of [
      ['base.company_form', ['email', 'phone']],
      ['base.partner_form', ['email', 'phone']],
      ['base.partner_list', ['email', 'phone']],
      ['base.users_form', ['email']],
    ] as const) {
      const fields = fieldsOf(composed.get(view).arch);
      for (const name of expected) {
        const matching = fields.filter((node) => node.attrs.name === name);
        expect(matching, `${view}: ${name}`).toHaveLength(1);
        expect(matching[0]?.attrs.widget, `${view}: ${name}`).toBe(name);
      }
    }
  });

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

describe('sequence numbers', () => {
  it('format prefix, zero-padded number and suffix with date variables', () => {
    const date = { year: '2026', month: '09', day: '28' };
    expect(formatSequence({ prefix: 'FAC/{YYYY}/', suffix: '', padding: 5 }, 42, date)).toBe(
      'FAC/2026/00042',
    );
    expect(formatSequence({ prefix: '{YY}{MM}{DD}-', suffix: '-DZ', padding: 0 }, 7, date)).toBe(
      '260928-7-DZ',
    );
    expect(formatSequence({ prefix: '', suffix: '', padding: 3 }, 12345, date)).toBe('12345');
    expect(() => formatSequence({ prefix: '', suffix: '', padding: 3 }, -1, date)).toThrow();
    expect(() => formatSequence({ prefix: '', suffix: '', padding: 3 }, 1.5, date)).toThrow();
  });

  it('take the date in the user time zone', () => {
    // 23:30 UTC on 31 December: already 1 January in Algiers (UTC+1), still 31 in UTC.
    expect(localDate('2026-12-31T23:30:00.000Z', 'Africa/Algiers')).toEqual({
      year: '2027',
      month: '01',
      day: '01',
    });
    expect(localDate('2026-12-31T23:30:00.000Z', 'UTC')).toEqual({
      year: '2026',
      month: '12',
      day: '31',
    });
    expect(localDate('2026-12-31T23:30:00.000Z', 'Not/AZone').day).toBe('31');
  });
});
