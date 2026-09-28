// SPDX-License-Identifier: LGPL-3.0-only
import { describe, expect, expectTypeOf, it } from 'vitest';

import { createEnvironment } from './environment.js';
import { f } from './fields.js';
import { createMemoryStorage } from './memory-storage.js';
import { defineModel, extendModel } from './model.js';
import { buildModelRegistry } from './model-registry.js';
import type { Recordset } from './recordset.js';
import type { FieldsOf, Money, RecordsetOf } from './typing.js';

// ─── a module defining two models, as a module author would write it ─────────

const typOrder = defineModel({
  name: 'typ.order',
  fields: {
    name: f.char({ required: true }),
    state: f.selection([
      ['draft', 'Brouillon'],
      ['done', 'Terminé'],
    ]),
    lines: f.one2many('typ.line', 'orderId'),
    total: f.monetary({ compute: 'computeTotal', store: true, depends: ['lines.amount'] }),
    urgent: f.boolean(),
  },
  methods: (Base) =>
    class extends Base {
      computeTotal(): void {
        // Fields are typed: `lines` is a recordset of typ.line, `amount` is a number.
        for (const order of this)
          order.total = [...order.lines].reduce((sum, line) => sum + line.amount, 0);
      }
    },
});

const typLine = defineModel({
  name: 'typ.line',
  fields: {
    orderId: f.many2one('typ.order', { required: true, ondelete: 'cascade' }),
    amount: f.monetary(),
  },
});

// ─── a second module extending typ.order, a third one extending it too ────────

const typMargin = extendModel('typ.order', {
  fields: { margin: f.monetary({ compute: 'computeMargin', store: true, depends: ['total'] }) },
  methods: (Base) =>
    class extends Base {
      computeMargin(): void {
        // Base knows the fields of the definition (total) and of this extension (margin).
        for (const order of this) order.margin = Math.round(order.total / 4);
      }
    },
});

const typPriority = extendModel('typ.order', { fields: { priority: f.integer() } });

declare module './typing.js' {
  interface ModelFields {
    'typ.order': FieldsOf<typeof typOrder>;
    'typ.line': FieldsOf<typeof typLine>;
  }
  interface ModelExtensions {
    typ_margin: { 'typ.order': { margin: Money } };
    typ_priority: { 'typ.order': { priority: number } };
  }
}

describe('record typing (ADR 009)', () => {
  it('types fields of the definition and of every extension', () => {
    type Order = RecordsetOf<'typ.order'>;
    expectTypeOf<Order['name']>().toEqualTypeOf<string | null>();
    expectTypeOf<Order['state']>().toEqualTypeOf<'draft' | 'done' | null>();
    expectTypeOf<Order['total']>().toEqualTypeOf<number>();
    expectTypeOf<Order['urgent']>().toEqualTypeOf<boolean>();
    expectTypeOf<Order['margin']>().toEqualTypeOf<number>();
    expectTypeOf<Order['priority']>().toEqualTypeOf<number>();
    expectTypeOf<Order['lines']>().toExtend<Recordset>();
    expectTypeOf<Order['lines']['amount']>().toEqualTypeOf<number>();
    expectTypeOf<RecordsetOf<'typ.line'>['orderId']['margin']>().toEqualTypeOf<number>();
    // @ts-expect-error unknown field
    expectTypeOf<Order['nope']>();
  });

  it('runs the typed models end to end', async () => {
    const registry = buildModelRegistry(
      [
        { module: 'typ', models: [typOrder, typLine] },
        { module: 'typ_margin', models: [typMargin] },
        { module: 'typ_priority', models: [typPriority] },
      ],
      { side: 'server' },
    );
    const env = createEnvironment({
      registry,
      storage: createMemoryStorage(registry),
      user: { id: 'u', groupIds: [], companyIds: [], companyId: null, lang: 'fr', tz: 'UTC' },
      access: { checkModel: () => undefined, ruleDomain: () => ({ kind: 'true' }) },
      audit: { record: () => undefined },
    });
    const order = await env.model('typ.order').create({
      name: 'SO1',
      lines: [{ amount: 1000 }, { amount: 600 }],
    });
    expectTypeOf(order).toExtend<RecordsetOf<'typ.order'>>();
    expect(order.total).toBe(1600);
    expect(order.margin).toBe(400);
    expect(order.priority).toBe(0);
    expect(order.urgent).toBe(false);
  });
});
