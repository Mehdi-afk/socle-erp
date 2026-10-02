// SPDX-License-Identifier: LGPL-3.0-only
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { f } from '../orm/fields.js';
import type { UserContext } from '../orm/environment.js';
import { defineModel } from '../orm/model.js';
import { buildModelRegistry } from '../orm/model-registry.js';
import { buildSecurityPolicy } from '../security/policy.js';
import { button, field, form, group, header, list, node, type ViewNode } from '../views/nodes.js';
import { buildViewRegistry, defineView } from '../views/view.js';
import { createRegistrySnapshot } from './projection.js';
import { hydrateRegistrySnapshot, parseRegistrySnapshot } from './snapshot.js';
import { isStoredMetadata, type ModelCatalog, type RegistrySnapshot } from './types.js';

function fixture(
  options: {
    groups?: string[];
    inverse?: 'hidden' | 'sensitive' | 'nonstored';
    currency?: 'hidden' | 'link' | 'code' | 'decimals' | 'sensitive';
  } = {},
) {
  const managerOnly = { groups: ['app.manager'] };
  const registry = buildModelRegistry(
    [
      {
        module: 'app',
        models: [
          defineModel({ name: 'app.mixin', abstract: true, fields: { inherited: f.char() } }),
          defineModel({ name: 'app.hidden', fields: { name: f.char() } }),
          defineModel({
            name: 'res.currency',
            fields: {
              code: f.char(options.currency === 'code' ? managerOnly : {}),
              decimals: f.integer(
                options.currency === 'decimals'
                  ? managerOnly
                  : options.currency === 'sensitive'
                    ? { sensitive: true }
                    : {},
              ),
            },
          }),
          defineModel({
            name: 'app.note',
            fields: {
              partnerId: f.many2one(
                'app.partner',
                options.inverse === 'hidden'
                  ? managerOnly
                  : options.inverse === 'sensitive'
                    ? { sensitive: true }
                    : options.inverse === 'nonstored'
                      ? { compute: 'computePartner' }
                      : {},
              ),
              name: f.char(),
              privateNote: f.char(managerOnly),
            },
            methods: (Base) =>
              class extends Base {
                computePartner(): void {
                  /* fixture computation */
                }
              },
          }),
          defineModel({
            name: 'app.partner',
            mixins: ['app.mixin'],
            description: { fr: 'Contacts', en: 'Contacts', ar: 'جهات الاتصال' },
            fields: {
              name: f.char({
                label: { fr: 'Nom', en: 'Name' },
                help: { fr: 'Nom du contact' },
                required: true,
                size: 120,
                default: 'INTERNAL_DEFAULT',
                index: true,
                tracking: true,
              }),
              secret: f.char(managerOnly),
              sensitive: f.char({ sensitive: true }),
              state: f.selection([
                ['draft', 'Brouillon'],
                ['done', 'Terminé'],
              ]),
              rate: f.decimal({ digits: [12, 4] }),
              hiddenId: f.many2one('app.hidden'),
              currencyId: f.many2one(
                'res.currency',
                options.currency === 'link' ? managerOnly : {},
              ),
              amount: f.monetary(),
              notes: f.one2many('app.note', 'partnerId'),
              total: f.integer({ compute: 'hiddenCompute', depends: ['secret'], store: true }),
              virtual: f.integer({ compute: 'hiddenCompute' }),
              relatedName: f.char({ related: 'name' }),
            },
            order: 'secret, name desc',
            constraints: [{ fields: ['name'], check: 'privateCheck' }],
            unique: [{ name: 'private_unique', fields: ['name'] }],
            methods: (Base) =>
              class extends Base {
                hiddenCompute(): void {
                  /* fixture computation */
                }
                privateCheck(): void {
                  /* fixture constraint */
                }
                actionApprove(): void {
                  /* declared presentation action */
                }
              },
            serverMethods: (Base) =>
              class extends Base {
                privateServerAction(): void {
                  /* never sent */
                }
              },
          }),
        ],
      },
    ],
    { side: 'server' },
  );
  const security = buildSecurityPolicy(
    [
      {
        module: 'app',
        groups: [
          { id: 'app.user', name: { fr: 'Utilisateur' } },
          { id: 'app.editor', name: { fr: 'Éditeur' }, implies: ['app.user'] },
          { id: 'app.manager', name: { fr: 'Gestionnaire' }, implies: ['app.editor'] },
        ],
        access: registry.names().map((model) => ({
          model,
          group:
            model === 'app.hidden' || (model === 'res.currency' && options.currency === 'hidden')
              ? 'app.manager'
              : 'app.user',
          read: true,
        })),
        rules: [
          {
            id: 'app.private_rule',
            model: 'app.partner',
            domain: [['name', '!=', 'PRIVATE_RULE_LITERAL']],
          },
        ],
      },
      {
        module: 'edit',
        access: [
          { model: 'app.partner', group: 'app.editor', create: true, write: true, unlink: true },
        ],
      },
    ],
    (model) => registry.has(model),
  );
  const views = buildViewRegistry(
    [
      {
        module: 'app',
        views: [
          defineView({
            id: 'app.partner.form',
            model: 'app.partner',
            type: 'form',
            arch: form(
              { domain: [['secret', '=', 'PRIVATE_DOMAIN']], ignored: 'PRIVATE_ATTRIBUTE' },
              [
                header({ title: 'name', subtitle: 'secret', avatar: 'sensitive' }, [
                  button('actionApprove', {
                    label: { fr: 'Approuver' },
                    primary: true,
                    states: ['draft'],
                    arbitrary: 'PRIVATE_BUTTON',
                  }),
                ]),
                group({ name: 'public', label: { fr: 'Données' } }, [
                  field('name', { widget: 'email', readonly: true, arbitrary: 'PRIVATE_FIELD' }),
                  field('state', {
                    widget: 'status_badge',
                    tones: { draft: 'info', done: 'success', ignored: 'PRIVATE_TONE' },
                  }),
                  field('hiddenId'),
                  field('currencyId'),
                  field('amount'),
                  field('sensitive'),
                  field('total'),
                  field('virtual'),
                  field('relatedName'),
                  node('field', { name: 'notes' }, [list([field('name'), field('privateNote')])]),
                ]),
                group({ groups: ['app.manager'] }, [field('secret')]),
              ],
            ),
          }),
          defineView({
            id: 'app.partner.list',
            model: 'app.partner',
            type: 'list',
            priority: 10,
            arch: list([field('name'), field('secret'), field('total'), field('virtual')]),
          }),
          defineView({
            id: 'app.partner.later',
            model: 'app.partner',
            type: 'list',
            priority: 20,
            arch: list([field('name')]),
          }),
          defineView({
            id: 'app.root_restricted',
            model: 'app.partner',
            type: 'form',
            arch: form({ groups: ['app.manager'] }, [field('secret')]),
          }),
          defineView({
            id: 'app.hidden.form',
            model: 'app.hidden',
            type: 'form',
            arch: form([field('name')]),
          }),
          defineView({
            id: 'app.partner.kanban',
            model: 'app.partner',
            type: 'kanban',
            arch: node('kanban', {}, [field('name')]),
          }),
        ],
      },
    ],
    registry,
  );
  const user: UserContext = {
    id: 'reader',
    companyId: 'company-1',
    companyIds: ['company-1'],
    groupIds: options.groups ?? ['app.editor'],
    lang: 'fr',
    tz: 'Africa/Algiers',
  };
  return { registry, views, security, user };
}

const snapshot = (options?: Parameters<typeof fixture>[0]): RegistrySnapshot =>
  createRegistrySnapshot(fixture(options));
const fieldNames = (value: RegistrySnapshot, model = 'app.partner'): string[] =>
  value.models.find((entry) => entry.name === model)?.fields.map((field) => field.name) ?? [];
const flatten = (node: ViewNode): ViewNode[] => [node, ...node.children.flatMap(flatten)];

describe('metadata projection', () => {
  it('projects the visible composed metadata without implementation details or private rules', () => {
    const input = fixture();
    const result = createRegistrySnapshot(input);
    expect(result.version).toBe(1);
    expect(result.userId).toBe('reader');
    expect(result.companyId).toBe('company-1');
    expect(result.models.map((model) => model.name)).toEqual([
      'app.note',
      'app.partner',
      'res.currency',
    ]);
    const partner = result.models.find((model) => model.name === 'app.partner');
    expect(partner?.permissions).toEqual({ create: true, write: true, unlink: true });
    expect(partner?.order).toEqual([{ field: 'name', direction: 'desc' }]);
    expect(fieldNames(result)).toContain('inherited');
    expect(fieldNames(result)).not.toContain('secret');
    expect(fieldNames(result)).not.toContain('hiddenId');
    expect(partner?.fields.find((field) => field.name === 'name')).toMatchObject({
      type: 'char',
      label: { fr: 'Nom', en: 'Name' },
      help: { fr: 'Nom du contact' },
      required: true,
      size: 120,
      stored: true,
      readonly: false,
    });
    const wire = JSON.stringify(result);
    for (const forbidden of [
      'INTERNAL_DEFAULT',
      'PRIVATE_',
      'hiddenCompute',
      'privateCheck',
      'privateServerAction',
      'private_unique',
      'app.manager',
      '"groups"',
      '"compute"',
      '"related"',
      '"recordClass"',
      '"constraints"',
      '"table"',
    ])
      expect(wire).not.toContain(forbidden);
    expect(input.registry.get('app.partner').fields.get('name')?.default).toBe('INTERNAL_DEFAULT');
    expect(input.views.get('app.partner.form').arch.attrs.ignored).toBe('PRIVATE_ATTRIBUTE');
  });

  it('keeps computed and related fields read-only without losing their storage semantics', () => {
    const hydrated = hydrateRegistrySnapshot(snapshot());
    expect(hydrated.registry.field('app.partner', 'total')).toMatchObject({
      readonly: true,
      stored: true,
    });
    expect(hydrated.registry.field('app.partner', 'virtual')).toMatchObject({
      readonly: true,
      stored: false,
    });
    expect(hydrated.registry.field('app.partner', 'relatedName')).toMatchObject({
      readonly: true,
      stored: false,
    });
    expect(hydrated.registry.field('app.partner', 'notes')).toMatchObject({
      readonly: true,
      stored: false,
    });
    expect(isStoredMetadata(hydrated.registry.field('app.partner', 'virtual') ?? f.char())).toBe(
      false,
    );
    const original = fixture().registry;
    const compatible: ModelCatalog = original;
    expect(isStoredMetadata(compatible.field('app.partner', 'virtual') ?? f.char())).toBe(false);
    expect(isStoredMetadata(compatible.field('app.partner', 'total') ?? f.char())).toBe(true);
  });

  it('uses implied groups and marks every field read-only without global write rights', () => {
    const reader = snapshot({ groups: ['app.user'] });
    const partner = reader.models.find((model) => model.name === 'app.partner');
    expect(partner?.permissions).toEqual({ create: false, write: false, unlink: false });
    expect(partner?.fields.every((field) => field.readonly)).toBe(true);
    const manager = snapshot({ groups: ['app.manager'] });
    expect(fieldNames(manager)).toContain('secret');
    expect(fieldNames(manager)).toContain('hiddenId');
    expect(manager.views.some((view) => view.id === 'app.root_restricted')).toBe(true);
  });

  it('filters roots, subviews and header references and keeps only supported action attributes', () => {
    const result = snapshot();
    expect(result.views.map((view) => view.id)).toEqual([
      'app.partner.form',
      'app.partner.later',
      'app.partner.list',
    ]);
    const arch = result.views.find((view) => view.id === 'app.partner.form')?.arch;
    expect(arch?.attrs).toEqual({});
    const nodes = arch ? flatten(arch) : [];
    expect(nodes.find((node) => node.type === 'header')?.attrs).toEqual({ title: 'name' });
    expect(nodes.find((node) => node.type === 'button')).toEqual({
      type: 'button',
      attrs: { name: 'actionApprove', label: { fr: 'Approuver' }, primary: true },
      children: [],
    });
    expect(
      nodes.filter((node) => node.type === 'field').map((node) => node.attrs.name),
    ).not.toContain('privateNote');
    expect(nodes.find((node) => node.attrs.name === 'state')?.attrs.tones).toEqual({
      draft: 'info',
      done: 'success',
    });
  });

  it.each(['hidden', 'sensitive', 'nonstored'] as const)(
    'removes an embedded relation when its inverse is %s',
    (inverse) => {
      const result = snapshot({ inverse });
      expect(fieldNames(result)).not.toContain('notes');
      expect(JSON.stringify(result.views)).not.toContain('"name":"notes"');
    },
  );

  it.each(['hidden', 'link', 'code', 'decimals', 'sensitive'] as const)(
    'closes monetary and currency relations when currency metadata is %s',
    (currency) => {
      const result = snapshot({ currency });
      expect(fieldNames(result)).not.toContain('amount');
      expect(fieldNames(result)).not.toContain('currencyId');
      expect(JSON.stringify(result.views)).not.toContain('"name":"currencyId"');
    },
  );

  it('works with no views and refuses models by default', () => {
    const input = fixture();
    expect(
      createRegistrySnapshot({
        registry: input.registry,
        security: input.security,
        user: { ...input.user, groupIds: [] },
      }),
    ).toEqual({ version: 1, userId: 'reader', companyId: 'company-1', models: [], views: [] });
    expect(
      createRegistrySnapshot({
        registry: input.registry,
        security: input.security,
        user: input.user,
      }).views,
    ).toEqual([]);
  });

  it.each([
    { groups: 'app.editor' },
    { groups: ['app.editor', 12] },
    { groups: { name: 'app.editor' } },
  ])('refuses malformed node groups at the root and in descendants: $groups', ({ groups }) => {
    const input = fixture();
    const views = buildViewRegistry(
      [
        {
          module: 'app',
          views: [
            defineView({
              id: 'app.bad_root',
              model: 'app.partner',
              type: 'form',
              arch: { type: 'form', attrs: { groups }, children: [field('name')] },
            }),
            defineView({
              id: 'app.bad_child',
              model: 'app.partner',
              type: 'form',
              arch: form([{ type: 'group', attrs: { groups }, children: [field('name')] }]),
            }),
          ],
        },
      ],
      input.registry,
    );
    const result = createRegistrySnapshot({ ...input, views });
    expect(result.views.map((view) => view.id)).toEqual(['app.bad_child']);
    expect(result.views[0]?.arch.children).toEqual([]);
  });

  it('does not turn a hidden explicit relation subview into an implicit list', () => {
    const input = fixture();
    const views = buildViewRegistry(
      [
        {
          module: 'app',
          views: [
            defineView({
              id: 'app.restricted_relation',
              model: 'app.partner',
              type: 'form',
              arch: form([
                node('field', { name: 'notes' }, [
                  list({ groups: ['app.manager'] }, [field('name')]),
                ]),
              ]),
            }),
          ],
        },
      ],
      input.registry,
    );
    const result = createRegistrySnapshot({ ...input, views });
    expect(result.views[0]?.arch.children).toEqual([]);
    const manager = createRegistrySnapshot({
      ...input,
      views,
      user: { ...input.user, groupIds: ['app.manager'] },
    });
    expect(manager.views[0]?.arch.children[0]?.attrs.name).toBe('notes');
  });
});

const minimal = (): RegistrySnapshot => ({
  version: 1,
  userId: 'user',
  companyId: null,
  models: [
    {
      name: 'app.item',
      permissions: { create: false, write: false, unlink: false },
      fields: [{ name: 'id', type: 'char', required: true, readonly: true, stored: true }],
      order: [{ field: 'id', direction: 'asc' }],
    },
  ],
  views: [],
});

describe('metadata wire parsing and hydration', () => {
  it('hydrates lookup-only catalogues and deterministic default views', () => {
    const hydrated = hydrateRegistrySnapshot(snapshot());
    expect(hydrated.registry.names()).toEqual(['app.note', 'app.partner', 'res.currency']);
    expect(hydrated.registry.get('app.partner').abstract).toBe(false);
    expect(hydrated.registry.get('app.partner')).not.toHaveProperty('recordClass');
    expect(hydrated.registry.get('app.partner')).not.toHaveProperty('constraints');
    expect(hydrated.views.default('app.partner', 'list')?.id).toBe('app.partner.list');
    expect(hydrated.views.default('res.currency', 'form')).toBeUndefined();
    expect(hydrated.permissions.get('app.partner')).toEqual({
      create: true,
      write: true,
      unlink: true,
    });
    expect(() => hydrated.registry.get('missing')).toThrow('Unknown model');
    expect(() => hydrated.views.get('missing')).toThrow('Unknown view');
  });

  it('round-trips filtered snapshots across group combinations without executable content', () => {
    fc.assert(
      fc.property(fc.subarray(['app.user', 'app.editor', 'app.manager']), (groups) => {
        const value = snapshot({ groups });
        const wire: unknown = JSON.parse(JSON.stringify(value));
        expect(parseRegistrySnapshot(wire)).toEqual(value);
        expect(hydrateRegistrySnapshot(value).registry.names()).toEqual(
          value.models.map((model) => model.name),
        );
      }),
      { numRuns: 20 },
    );
  });

  it.each([
    ['unsupported version', { ...minimal(), version: 2 }],
    ['unknown root property', { ...minimal(), rules: [] }],
    ['duplicate models', { ...minimal(), models: [...minimal().models, ...minimal().models] }],
    [
      'private field attribute',
      {
        ...minimal(),
        models: [
          {
            ...minimal().models[0],
            fields: [
              {
                name: 'id',
                type: 'char',
                required: true,
                readonly: true,
                stored: true,
                compute: 'internal',
              },
            ],
          },
        ],
      },
    ],
    [
      'missing required storage flag',
      {
        ...minimal(),
        models: [
          {
            ...minimal().models[0],
            fields: [{ name: 'id', type: 'char', required: true, readonly: true }],
          },
        ],
      },
    ],
    [
      'non-readable reference',
      {
        ...minimal(),
        views: [
          { id: 'app.view', model: 'missing.model', type: 'form', priority: 1, arch: form([]) },
        ],
      },
    ],
    [
      'unknown attribute',
      {
        ...minimal(),
        views: [
          {
            id: 'app.view',
            model: 'app.item',
            type: 'form',
            priority: 1,
            arch: form({ domain: [] }, []),
          },
        ],
      },
    ],
    [
      'unknown field in header',
      {
        ...minimal(),
        views: [
          {
            id: 'app.view',
            model: 'app.item',
            type: 'form',
            priority: 1,
            arch: form([header({ title: 'missing' }, [])]),
          },
        ],
      },
    ],
  ])('rejects %s', (_name, value) => {
    expect(() => parseRegistrySnapshot(value)).toThrow();
  });

  it('rejects open relations, unsafe order terms and duplicate field identifiers', () => {
    const model = minimal().models[0];
    expect(() =>
      parseRegistrySnapshot({
        ...minimal(),
        models: [
          {
            ...model,
            fields: [
              ...(model?.fields ?? []),
              {
                name: 'linkId',
                type: 'many2one',
                comodel: 'missing.model',
                readonly: true,
                stored: true,
              },
            ],
          },
        ],
      }),
    ).toThrow('dependency');
    expect(() =>
      parseRegistrySnapshot({
        ...minimal(),
        models: [{ ...model, order: [{ field: 'hidden', direction: 'asc' }] }],
      }),
    ).toThrow('Order');
    expect(() =>
      parseRegistrySnapshot({
        ...minimal(),
        models: [{ ...model, fields: [...(model?.fields ?? []), ...(model?.fields ?? [])] }],
      }),
    ).toThrow('Duplicate field');
  });

  it('bounds JSON before recursion and refuses cycles, getters and non-JSON values', () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => parseRegistrySnapshot(cycle)).toThrow('cycle');
    let deep: unknown = {};
    for (let index = 0; index < 100; index += 1) deep = { child: deep };
    expect(() => parseRegistrySnapshot(deep)).toThrow('structural limits');
    let accessed = false;
    const getter = Object.defineProperty({}, 'models', {
      enumerable: true,
      get: () => {
        accessed = true;
        return [];
      },
    });
    expect(() => parseRegistrySnapshot(getter)).toThrow('property');
    expect(accessed).toBe(false);
    expect(() => parseRegistrySnapshot({ ...minimal(), extra: () => 1 })).toThrow('non-JSON');
    expect(() => parseRegistrySnapshot({ ...minimal(), userId: 'x'.repeat(5000) })).toThrow(
      'text limits',
    );
    expect(() => parseRegistrySnapshot({ ...minimal(), extra: Array(100_001) })).toThrow(
      'array limits',
    );
  });

  it('copies and freezes validated JSON without rejecting harmless shared references', () => {
    const input = minimal();
    const value = parseRegistrySnapshot({
      ...input,
      models: [
        { ...input.models[0], fields: input.models[0]?.fields },
        { ...input.models[0], name: 'app.other', fields: input.models[0]?.fields },
      ],
    });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.models[0]?.fields[0])).toBe(true);
    expect(value.models[0]?.fields).not.toBe(input.models[0]?.fields);
  });

  it('accepts the renderer decimal scale limit and rejects the next value', () => {
    const withScale = (scale: number): unknown => ({
      ...minimal(),
      models: [
        {
          ...minimal().models[0],
          fields: [
            ...(minimal().models[0]?.fields ?? []),
            { name: 'rate', type: 'decimal', stored: true, readonly: true, digits: [1000, scale] },
          ],
        },
      ],
    });
    expect(() => parseRegistrySnapshot(withScale(100))).not.toThrow();
    expect(() => parseRegistrySnapshot(withScale(101))).toThrow();
  });
});
