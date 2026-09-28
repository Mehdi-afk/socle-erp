// SPDX-License-Identifier: LGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { parseDomain } from './domain.js';
import { f } from './fields.js';
import { createMemoryStorage } from './memory-storage.js';
import { defineModel } from './model.js';
import { buildModelRegistry } from './model-registry.js';

const model = defineModel({
  name: 'mem.item',
  fields: { score: f.decimal(), data: f.json(), label: f.char() },
});
const registry = buildModelRegistry([{ module: 'mem', models: [model] }], { side: 'server' });
const meta = registry.get('mem.item');
const id = (n: number): string => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

describe('memory storage (reference semantics)', () => {
  // Regression: decimals were ordered as text ("10" before "9"), unlike PostgreSQL numeric.
  it('orders decimal fields by value', async () => {
    const storage = createMemoryStorage(registry);
    await storage.insert(meta, [
      { id: id(1), values: { score: '10' } },
      { id: id(2), values: { score: '9' } },
      { id: id(3), values: { score: '-2' } },
      { id: id(4), values: { score: '9.5' } },
    ]);
    const ids = await storage.search(
      meta,
      { kind: 'true' },
      { order: [{ field: 'score', direction: 'asc' }] },
    );
    expect(ids).toEqual([id(3), id(2), id(4), id(1)]);
  });

  it('treats equal decimals written differently as a tie (next sort key decides)', async () => {
    const storage = createMemoryStorage(registry);
    await storage.insert(meta, [
      { id: id(2), values: { score: '1.50', label: 'b' } },
      { id: id(1), values: { score: '1.5', label: 'a' } },
    ]);
    const order = [
      { field: 'score', direction: 'asc' as const },
      { field: 'label', direction: 'desc' as const },
    ];
    expect(await storage.search(meta, { kind: 'true' }, { order })).toEqual([id(2), id(1)]);
  });

  // Regression: an array stored in a json field was treated like a list of related ids, so
  // `data = 1` matched `[1, 2]`.
  it('treats json values as opaque', async () => {
    const storage = createMemoryStorage(registry);
    await storage.insert(meta, [
      { id: id(1), values: { data: [1, 2] } },
      { id: id(2), values: { data: 1 } },
      { id: id(3), values: { data: null } },
    ]);
    const search = (domain: Parameters<typeof parseDomain>[0]) =>
      storage.search(
        meta,
        parseDomain(domain, 'mem.item', (model, field) => registry.field(model, field)),
        {},
      );
    expect(await search([['data', '=', 1]])).toEqual([id(2)]);
    expect(await search([['data', 'in', [1, 2]]])).toEqual([id(2)]);
    expect(await search([['data', '=', null]])).toEqual([id(3)]);
    expect(await search([['data', '!=', null]])).toEqual([id(1), id(2)]);
  });
});
