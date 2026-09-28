// SPDX-License-Identifier: LGPL-3.0-only
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createEnvironment, type UserContext } from '../orm/environment.js';
import { AccessError } from '../orm/errors.js';
import { f } from '../orm/fields.js';
import { createMemoryStorage } from '../orm/memory-storage.js';
import { defineModel } from '../orm/model.js';
import { buildModelRegistry } from '../orm/model-registry.js';
import { createAccessControl } from './access-control.js';
import {
  canAccessModel,
  canSeeField,
  effectiveGroups,
  resolveRuleDomain,
  ruleDomainFor,
} from './permissions.js';
import { buildSecurityPolicy, SecurityDefinitionError, type ModuleSecurity } from './policy.js';

const company = defineModel({ name: 'sec.company', fields: { name: f.char() } });
const invoice = defineModel({
  name: 'sec.invoice',
  fields: {
    name: f.char(),
    companyId: f.many2one('sec.company'),
    margin: f.integer({ groups: ['sec.group_manager'] }),
  },
});
const registry = buildModelRegistry([{ module: 'sec', models: [company, invoice] }], {
  side: 'server',
});
const resolve = (model: string, field: string) => registry.field(model, field);
const has = (model: string) => registry.has(model);

const security: ModuleSecurity = {
  module: 'sec',
  groups: [
    { id: 'sec.group_user', name: { fr: 'Utilisateur' } },
    { id: 'sec.group_manager', name: { fr: 'Responsable' }, implies: ['sec.group_user'] },
    { id: 'sec.group_auditor', name: { fr: 'Auditeur' } },
  ],
  access: [
    { model: 'sec.company', group: null, read: true },
    { model: 'sec.invoice', group: 'sec.group_user', read: true, create: true, write: true },
    { model: 'sec.invoice', group: 'sec.group_manager', unlink: true },
    { model: 'sec.invoice', group: 'sec.group_auditor', read: true },
  ],
  rules: [
    {
      id: 'sec.invoice_company',
      model: 'sec.invoice',
      domain: [['companyId', 'in', { $user: 'companyIds' }]],
    },
    {
      id: 'sec.invoice_own',
      model: 'sec.invoice',
      groups: ['sec.group_user'],
      domain: [['createdBy', '=', { $user: 'id' }]],
    },
    { id: 'sec.invoice_all', model: 'sec.invoice', groups: ['sec.group_manager'], domain: [] },
    {
      id: 'sec.invoice_named',
      model: 'sec.invoice',
      groups: ['sec.group_auditor'],
      domain: [['name', '=like', 'AUD%']],
      operations: ['read'],
    },
  ],
};
const policy = buildSecurityPolicy([security], has);

const user = (id: string, groupIds: string[], companyIds: string[]): UserContext => ({
  id,
  groupIds,
  companyIds,
  companyId: companyIds[0] ?? null,
  lang: 'fr',
  tz: 'UTC',
});

describe('security declarations', () => {
  const invalid = (patch: Partial<ModuleSecurity>) => () =>
    buildSecurityPolicy([{ ...security, ...patch }], has);

  it('refuses unknown groups and models, duplicates and ids of another module', () => {
    expect(invalid({ groups: [{ id: 'other.group_x', name: { fr: 'X' } }] })).toThrow(
      /prefixed by its module/,
    );
    expect(
      invalid({
        groups: [...(security.groups ?? []), { id: 'sec.group_user', name: { fr: 'X' } }],
      }),
    ).toThrow(/declared twice/);
    expect(invalid({ access: [{ model: 'sec.invoice', group: 'sec.nope', read: true }] })).toThrow(
      /unknown group/,
    );
    expect(invalid({ access: [{ model: 'sec.ghost', group: null, read: true }] })).toThrow(
      /unknown model/,
    );
    expect(
      invalid({
        groups: [{ id: 'sec.group_a', name: { fr: 'A' }, implies: ['sec.group_b'] }],
        access: [],
        rules: [],
      }),
    ).toThrow(/unknown group "sec.group_b"/);
  });

  it('only accepts scalars, lists or $user placeholders in rules', () => {
    const rule = (value: unknown) =>
      invalid({ rules: [{ id: 'sec.r', model: 'sec.invoice', domain: [['name', '=', value]] }] });
    expect(rule({ $user: 'password' })).toThrow(SecurityDefinitionError);
    expect(rule({ $eval: 'x' })).toThrow(SecurityDefinitionError);
    expect(rule('ok')).not.toThrow();
    expect(
      invalid({
        rules: [
          { id: 'sec.r', model: 'sec.invoice', domain: [], operations: ['delete' as 'unlink'] },
        ],
      }),
    ).toThrow(/unknown operation/);
  });
});

describe('permissions (pure functions)', () => {
  it('expands implied groups transitively, even with cycles', () => {
    const cyclic = buildSecurityPolicy(
      [
        {
          module: 'cyc',
          groups: [
            { id: 'cyc.a', name: { fr: 'A' }, implies: ['cyc.b'] },
            { id: 'cyc.b', name: { fr: 'B' }, implies: ['cyc.c'] },
            { id: 'cyc.c', name: { fr: 'C' }, implies: ['cyc.a'] },
          ],
        },
      ],
      has,
    );
    expect([...effectiveGroups(cyclic, ['cyc.a'])].sort()).toEqual(['cyc.a', 'cyc.b', 'cyc.c']);
    expect([...effectiveGroups(policy, ['sec.group_manager'])].sort()).toEqual([
      'sec.group_manager',
      'sec.group_user',
    ]);
  });

  it('denies by default and grants the union of the entries', () => {
    const none = effectiveGroups(policy, []);
    const userGroups = effectiveGroups(policy, ['sec.group_user']);
    const manager = effectiveGroups(policy, ['sec.group_manager']);
    expect(canAccessModel(policy, none, 'sec.company', 'read')).toBe(true);
    expect(canAccessModel(policy, none, 'sec.company', 'write')).toBe(false);
    expect(canAccessModel(policy, none, 'sec.invoice', 'read')).toBe(false);
    expect(canAccessModel(policy, userGroups, 'sec.invoice', 'write')).toBe(true);
    expect(canAccessModel(policy, userGroups, 'sec.invoice', 'unlink')).toBe(false);
    expect(canAccessModel(policy, manager, 'sec.invoice', 'unlink')).toBe(true);
    expect(canAccessModel(policy, manager, 'sec.unknown', 'read')).toBe(false);
  });

  it('never loses a right when a group is added (monotonic)', () => {
    const ids = [...policy.groups.keys()];
    fc.assert(
      fc.property(
        fc.subarray(ids),
        fc.constantFrom(...ids),
        fc.constantFrom('sec.company', 'sec.invoice'),
        fc.constantFrom('read' as const, 'create' as const, 'write' as const, 'unlink' as const),
        (groups, extra, model, operation) => {
          const before = canAccessModel(policy, effectiveGroups(policy, groups), model, operation);
          const after = canAccessModel(
            policy,
            effectiveGroups(policy, [...groups, extra]),
            model,
            operation,
          );
          return !before || after;
        },
      ),
    );
  });

  it('hides fields restricted to groups', () => {
    const margin = registry.field('sec.invoice', 'margin');
    if (!margin) throw new Error('missing field');
    expect(canSeeField(effectiveGroups(policy, ['sec.group_user']), margin)).toBe(false);
    expect(canSeeField(effectiveGroups(policy, ['sec.group_manager']), margin)).toBe(true);
  });

  it('resolves $user placeholders', () => {
    const u = user('u1', [], ['c1', 'c2']);
    expect(
      resolveRuleDomain(
        [
          ['companyId', 'in', { $user: 'companyIds' }],
          ['createdBy', '=', { $user: 'id' }],
        ],
        u,
      ),
    ).toEqual([
      ['companyId', 'in', ['c1', 'c2']],
      ['createdBy', '=', 'u1'],
    ]);
  });

  it('combines global rules with AND and group rules with OR', () => {
    const domain = (u: UserContext, operation: 'read' | 'write' = 'read') =>
      ruleDomainFor(
        policy,
        u,
        effectiveGroups(policy, u.groupIds),
        'sec.invoice',
        operation,
        resolve,
      );
    const company = { kind: 'condition', path: ['companyId'], operator: 'in', value: ['c1'] };
    // A user: company rule AND own records.
    expect(domain(user('u1', ['sec.group_user'], ['c1']))).toEqual({
      kind: 'and',
      children: [company, { kind: 'condition', path: ['createdBy'], operator: '=', value: 'u1' }],
    });
    // A manager is also a user (implied): own records OR everything → company rule still applies.
    expect(domain(user('u1', ['sec.group_manager'], ['c1']))).toEqual({
      kind: 'and',
      children: [
        company,
        {
          kind: 'or',
          children: [
            { kind: 'condition', path: ['createdBy'], operator: '=', value: 'u1' },
            { kind: 'true' },
          ],
        },
      ],
    });
    // A rule limited to reads does not restrict writes.
    expect(domain(user('u1', ['sec.group_auditor'], ['c1']), 'write')).toEqual(company);
    // Nobody escapes the global rule.
    expect(domain(user('u1', [], []))).toEqual({
      kind: 'condition',
      path: ['companyId'],
      operator: 'in',
      value: [],
    });
  });
});

describe('access control in the ORM', () => {
  const access = createAccessControl(policy, registry);
  const storage = createMemoryStorage(registry);
  const envFor = (u: UserContext) =>
    createEnvironment({ registry, storage, user: u, access, audit: { record: () => undefined } });

  it('isolates companies, keeps users to their own records, lets managers see all', async () => {
    const admin = envFor(user('admin', [], [])).sudo('test fixtures');
    await admin.model('sec.company').create([{ name: 'C1' }, { name: 'C2' }]);
    const [first, second] = [...(await admin.model('sec.company').search([], { order: 'name' }))];
    if (!first || !second) throw new Error('fixtures');

    const alice = envFor(user('alice', ['sec.group_user'], [first.id]));
    const bob = envFor(user('bob', ['sec.group_user'], [first.id]));
    const carol = envFor(user('carol', ['sec.group_manager'], [first.id]));
    const dave = envFor(user('dave', ['sec.group_manager'], [second.id]));

    await alice.model('sec.invoice').create({ name: 'A1', companyId: first.id });
    await bob.model('sec.invoice').create({ name: 'B1', companyId: first.id });
    await admin.model('sec.invoice').create({ name: 'X2', companyId: second.id });

    const names = async (env: ReturnType<typeof envFor>) =>
      [...(await env.model('sec.invoice').search([], { order: 'name' }))].map(
        (record) => (record as unknown as { name: string }).name,
      );
    expect(await names(alice)).toEqual(['A1']);
    expect(await names(carol)).toEqual(['A1', 'B1']);
    expect(await names(dave)).toEqual(['X2']);

    // Writing someone else's record: refused by the record rules.
    const b1 = await bob.model('sec.invoice').search([['name', '=', 'B1']]);
    await expect(
      alice.model('sec.invoice').browse(b1.ids).write({ name: 'hacked' }),
    ).rejects.toThrow(AccessError);
    // Creating in a company the user does not belong to: refused.
    await expect(
      alice.model('sec.invoice').create({ name: 'A2', companyId: second.id }),
    ).rejects.toThrow(AccessError);
    // ACL: a user cannot delete, a manager can.
    const a1 = await alice.model('sec.invoice').search([['name', '=', 'A1']]);
    await expect(a1.unlink()).rejects.toThrow(AccessError);
    await carol.model('sec.invoice').browse(a1.ids).unlink();
    // No access entry at all: refused (deny by default).
    const nobody = envFor(user('eve', [], [first.id]));
    await expect(nobody.model('sec.invoice').search([])).rejects.toThrow(AccessError);
  });
});
