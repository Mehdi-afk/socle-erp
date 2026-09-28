// SPDX-License-Identifier: LGPL-3.0-only
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { f } from '../orm/fields.js';
import { defineModel } from '../orm/model.js';
import { buildModelRegistry } from '../orm/model-registry.js';
import {
  button,
  field,
  form,
  group,
  header,
  list,
  node,
  notebook,
  page,
  type ViewNode,
} from './nodes.js';
import { parseSelector, ViewError } from './selector.js';
import {
  applyViewChanges,
  buildViewRegistry,
  defineView,
  extendView,
  visibleArch,
} from './view.js';

const partner = defineModel({ name: 'res.partner', fields: { name: f.char() } });
const line = defineModel({
  name: 'sale.order.line',
  fields: { orderId: f.many2one('sale.order'), price: f.monetary() },
});
const order = defineModel({
  name: 'sale.order',
  fields: {
    partnerId: f.many2one('res.partner'),
    currencyId: f.char(),
    lines: f.one2many('sale.order.line', 'orderId'),
    amountUntaxed: f.monetary(),
    state: f.selection([
      ['draft', 'Brouillon'],
      ['sale', 'Vente'],
    ]),
  },
  methods: (Base) =>
    class extends Base {
      actionConfirm(): void {
        /* business logic elsewhere */
      }
    },
});
const margin = defineModel({
  name: 'sale.order.margin',
  fields: {
    orderId: f.many2one('sale.order'),
    secret: f.integer({ groups: ['sale.group_manager'] }),
  },
});
const models = buildModelRegistry([{ module: 'sale', models: [partner, line, order, margin] }], {
  side: 'server',
});

// The example of ARCHITECTURE.md §4.5.
const saleOrderForm = defineView({
  id: 'sale.order.form',
  model: 'sale.order',
  type: 'form',
  arch: form([
    header([
      button('actionConfirm', { label: { fr: 'Confirmer' }, states: ['draft'], primary: true }),
    ]),
    group([field('partnerId'), field('currencyId')]),
    notebook([page('lines', 'Lignes', [field('lines', { widget: 'editable-list' })])]),
    group({ name: 'totals' }, [field('amountUntaxed')]),
  ]),
});

const names = (arch: ViewNode): string[] => {
  const out: string[] = [];
  const walk = (n: ViewNode): void => {
    out.push(typeof n.attrs.name === 'string' ? `${n.type}:${n.attrs.name}` : n.type);
    n.children.forEach(walk);
  };
  walk(arch);
  return out;
};

describe('selectors', () => {
  it('parses types, attributes and combinators', () => {
    expect(parseSelector('group[name=\'totals\'] > field[name="amountUntaxed"]')).toEqual([
      { type: 'group', attributes: [['name', 'totals']], combinator: 'descendant' },
      { type: 'field', attributes: [['name', 'amountUntaxed']], combinator: 'child' },
    ]);
    expect(parseSelector("form   notebook page[name='lines']")).toHaveLength(3);
    expect(parseSelector("*[name='x']")[0]?.type).toBe('*');
  });

  it('rejects malformed selectors explicitly', () => {
    for (const bad of [
      '',
      '   ',
      "field[name='x'",
      'field[name=x]',
      'field >',
      '> field',
      'fi$ld',
      "[name='a'][",
      'a'.repeat(501),
    ]) {
      expect(() => parseSelector(bad), bad).toThrow(ViewError);
    }
  });

  it('never loops or throws anything but ViewError on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (input) => {
        try {
          parseSelector(input);
        } catch (error) {
          return error instanceof ViewError;
        }
        return true;
      }),
    );
  });
});

describe('view extensions', () => {
  const apply = (changes: Parameters<typeof applyViewChanges>[1]) =>
    applyViewChanges(saleOrderForm.arch, changes, 'test');

  it('inserts after the node of the example (§4.5)', () => {
    const arch = apply([
      {
        at: "group[name='totals'] > field[name='amountUntaxed']",
        position: 'after',
        node: field('margin', { groups: ['sale.group_manager'] }),
      },
    ]);
    expect(names(arch).slice(-3)).toEqual(['group:totals', 'field:amountUntaxed', 'field:margin']);
  });

  it('supports before, inside, replace (and removal) and attributes', () => {
    const arch = apply([
      { at: "field[name='currencyId']", position: 'before', node: field('state') },
      { at: 'header', position: 'inside', nodes: [button('actionCancel')] },
      {
        at: "page[name='lines'] > field[name='lines']",
        position: 'attributes',
        attributes: { widget: 'list', readonly: true },
      },
      { at: "field[name='partnerId']", position: 'replace', nodes: [] },
    ]);
    expect(names(arch)).toEqual([
      'form',
      'header',
      'button:actionConfirm',
      'button:actionCancel',
      'group',
      'field:state',
      'field:currencyId',
      'notebook',
      'page:lines',
      'field:lines',
      'group:totals',
      'field:amountUntaxed',
    ]);
    const lines = arch.children[2]?.children[0]?.children[0];
    expect(lines?.attrs).toEqual({ name: 'lines', widget: 'list', readonly: true });
    // The original view is untouched (immutability).
    expect(names(saleOrderForm.arch)).toContain('field:partnerId');
  });

  it('removes an attribute with null, and refuses renaming a node', () => {
    const arch = apply([{ at: 'button', position: 'attributes', attributes: { primary: null } }]);
    expect(arch.children[0]?.children[0]?.attrs.primary).toBeUndefined();
    expect(() =>
      apply([{ at: 'button', position: 'attributes', attributes: { name: 'other' } }]),
    ).toThrow(/cannot change/);
  });

  it('fails when a selector matches nothing or several nodes — never silently', () => {
    expect(() =>
      apply([{ at: "field[name='nope']", position: 'after', node: field('x') }]),
    ).toThrow(/matches no node/);
    expect(() => apply([{ at: 'group > field', position: 'after', node: field('x') }])).toThrow(
      /matches 3 nodes/,
    );
    expect(() => apply([{ at: 'form', position: 'before', node: field('x') }])).toThrow(
      /root node/,
    );
  });

  it('validates the payload of a change when it is declared', () => {
    expect(() => extendView('sale.order.form', [{ at: 'header', position: 'after' }])).toThrow(
      ViewError,
    );
    expect(() =>
      extendView('sale.order.form', [{ at: 'header', position: 'attributes', node: field('x') }]),
    ).toThrow(ViewError);
    expect(() => extendView('sale.order.form', [{ at: 'header[', position: 'replace' }])).toThrow(
      /Invalid selector/,
    );
  });
});

describe('view registry', () => {
  it('composes extensions in module order and records who changed the view', () => {
    const registry = buildViewRegistry(
      [
        { module: 'sale', views: [saleOrderForm] },
        {
          module: 'sale_margin',
          views: [
            extendView('sale.order.form', [
              {
                at: "group[name='totals']",
                position: 'attributes',
                attributes: { string: 'Totaux' },
              },
            ]),
          ],
        },
        {
          module: 'sale_stock',
          views: [
            extendView('sale.order.form', [
              {
                at: "group[name='totals']",
                position: 'before',
                node: group({ name: 'delivery' }, []),
              },
            ]),
          ],
        },
      ],
      models,
    );
    const view = registry.get('sale.order.form');
    expect(view.modules).toEqual(['sale', 'sale_margin', 'sale_stock']);
    expect(names(view.arch).slice(-3)).toEqual([
      'group:delivery',
      'group:totals',
      'field:amountUntaxed',
    ]);
    expect(view.arch.children.find((child) => child.attrs.name === 'totals')?.attrs.string).toBe(
      'Totaux',
    );
    expect(registry.default('sale.order', 'form')?.id).toBe('sale.order.form');
    expect(registry.default('sale.order', 'list')).toBeUndefined();
  });

  it('refuses unknown fields, methods, node types and models, and extensions of missing views', () => {
    const build =
      (arch: ViewNode, model = 'sale.order') =>
      () =>
        buildViewRegistry(
          [{ module: 'sale', views: [defineView({ id: 'sale.v', model, type: 'form', arch })] }],
          models,
        );
    expect(build(form([field('nope')]))).toThrow(/unknown field "nope" on "sale.order"/);
    expect(build(form([button('actionNope')]))).toThrow(/no such method/);
    expect(build(form([node('script', {}, [])]))).toThrow(/unknown node type "script"/);
    expect(build(form([]), 'ghost.model')).toThrow(/unknown model/);
    // Sub-views of a one2many describe the target model.
    expect(build(form([node('field', { name: 'lines' }, [list([field('price')])])]))).not.toThrow();
    expect(build(form([node('field', { name: 'lines' }, [list([field('partnerId')])])]))).toThrow(
      /unknown field "partnerId" on "sale.order.line"/,
    );
    expect(() =>
      buildViewRegistry(
        [{ module: 'sale_margin', views: [extendView('sale.order.form', [])] }],
        models,
      ),
    ).toThrow(/not defined by a module it depends on/);
    expect(() => buildViewRegistry([{ module: 'other', views: [saleOrderForm] }], models)).toThrow(
      /prefixed by its module/,
    );
  });
});

describe('visible architecture', () => {
  it('hides nodes and fields restricted to groups the user is not in', () => {
    const view = buildViewRegistry(
      [
        {
          module: 'sale',
          views: [
            saleOrderForm,
            defineView({
              id: 'sale.margin.form',
              model: 'sale.order.margin',
              type: 'form',
              arch: form([
                field('orderId'),
                field('secret'),
                group({ groups: ['sale.group_manager'] }, [field('orderId')]),
              ]),
            }),
          ],
        },
      ],
      models,
    ).get('sale.margin.form');
    expect(names(visibleArch(view, new Set(), models))).toEqual(['form', 'field:orderId']);
    expect(names(visibleArch(view, new Set(['sale.group_manager']), models))).toEqual([
      'form',
      'field:orderId',
      'field:secret',
      'group',
      'field:orderId',
    ]);
  });
});
