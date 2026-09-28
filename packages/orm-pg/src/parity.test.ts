// SPDX-License-Identifier: LGPL-3.0-only
//
// Parity with the in-memory reference storage: random data and random domains must give the
// same ids, in the same order, the same counts and the same values on PostgreSQL.
import {
  buildModelRegistry,
  createMemoryStorage,
  defineModel,
  f,
  parseDomain,
  type Domain,
  type ModelRegistry,
  type OrderTerm,
  type Storage,
  type StoredValues,
} from '@socle/framework';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { applySchema } from './apply.js';
import type { Executor } from './database.js';
import { createPgStorage } from './storage.js';
import { useTestDatabases } from './test-support.js';

const partner = defineModel({
  name: 'par.partner',
  fields: {
    name: f.char(),
    note: f.text(),
    rank: f.integer(),
    score: f.decimal(),
    active: f.boolean(),
    born: f.date(),
    seen: f.datetime(),
    kind: f.selection([
      ['a', 'A'],
      ['b', 'B'],
    ]),
    parentId: f.many2one('par.partner'),
    tagIds: f.many2many('par.tag'),
    orderIds: f.one2many('par.order', 'partnerId'),
    data: f.json(),
  },
});
const tag = defineModel({ name: 'par.tag', fields: { name: f.char() } });
const order = defineModel({
  name: 'par.order',
  fields: { partnerId: f.many2one('par.partner'), total: f.integer(), ref: f.char() },
});

const registry: ModelRegistry = buildModelRegistry(
  [{ module: 'par', models: [partner, tag, order] }],
  { side: 'server' },
);

const resolve = (model: string, field: string) => registry.field(model, field);

const uuid = (n: number): string => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const PARTNERS = [1, 2, 3, 4, 5, 6].map(uuid);
const TAGS = [11, 12, 13].map(uuid);
const ORDERS = [21, 22, 23, 24].map(uuid);
const UNKNOWN = uuid(99);

const TEXTS = [
  null,
  '',
  'a',
  'A',
  'ab',
  'Ab',
  'b%',
  'b_c',
  '10',
  '9',
  '1.5',
  'é',
  'Z',
  'abc',
  'a\\',
];
const INTEGERS = [0, 1, -1, 9, 10, 2 ** 40];
const DECIMALS = [null, '0', '1.5', '1.50', '9', '10', '-2', '9.99'];
const DATES = [null, '2024-01-01', '2023-12-31', '2024-02-29'];
const INSTANTS = [
  null,
  '2024-01-01T00:00:00.000Z',
  '2024-01-01T10:30:00.000Z',
  '1999-12-31T23:59:59.999Z',
];
const JSONS = [null, 1, 'a', true, { x: 1 }, [1, 2]];

// ─── data ────────────────────────────────────────────────────────────────────────────────

interface Dataset {
  readonly partners: { id: string; values: StoredValues }[];
  readonly tags: { id: string; values: StoredValues }[];
  readonly orders: { id: string; values: StoredValues }[];
}

const technical = {
  createdAt: null,
  createdBy: 'u',
  updatedAt: null,
  updatedBy: 'u',
  version: 0,
  deletedAt: null,
  originDevice: null,
};

const dataset: fc.Arbitrary<Dataset> = fc
  .record({
    partners: fc.array(
      fc.record({
        name: fc.constantFrom(...TEXTS),
        note: fc.constantFrom(...TEXTS),
        rank: fc.constantFrom(...INTEGERS),
        score: fc.constantFrom(...DECIMALS),
        active: fc.boolean(),
        born: fc.constantFrom(...DATES),
        seen: fc.constantFrom(...INSTANTS),
        kind: fc.constantFrom(null, 'a', 'b'),
        parent: fc.nat(PARTNERS.length),
        tagIds: fc.subarray(TAGS),
        data: fc.constantFrom(...JSONS),
      }),
      { minLength: PARTNERS.length, maxLength: PARTNERS.length },
    ),
    tags: fc.array(fc.constantFrom(...TEXTS), { minLength: TAGS.length, maxLength: TAGS.length }),
    orders: fc.array(
      fc.record({
        partner: fc.nat(PARTNERS.length),
        total: fc.constantFrom(...INTEGERS),
        ref: fc.constantFrom(...TEXTS),
      }),
      { minLength: ORDERS.length, maxLength: ORDERS.length },
    ),
  })
  .map(({ partners, tags, orders }) => ({
    tags: tags.map((name, i) => ({ id: TAGS[i] as string, values: { ...technical, name } })),
    partners: partners.map(({ parent, ...values }, i) => ({
      id: PARTNERS[i] as string,
      values: { ...technical, ...values, parentId: PARTNERS[parent] ?? null },
    })),
    orders: orders.map(({ partner: p, ...values }, i) => ({
      id: ORDERS[i] as string,
      values: { ...technical, ...values, partnerId: PARTNERS[p] ?? null },
    })),
  }));

// ─── domains ─────────────────────────────────────────────────────────────────────────────

type Leaf = readonly [string, string, unknown];

const scalarOperand = fc.constantFrom<unknown>(
  ...TEXTS,
  ...INTEGERS,
  ...DECIMALS,
  ...DATES,
  ...INSTANTS,
  '2024-01-01T00:00:00Z',
  false,
  true,
  2024,
  1e21,
  PARTNERS[0],
  TAGS[0],
  UNKNOWN,
);
const listOperand = fc.array(scalarOperand, { maxLength: 4 });

const ALL_OPERATORS = [
  '=',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'in',
  'not in',
  'like',
  'not like',
  'ilike',
  'not ilike',
  '=like',
  '=ilike',
];

const PARTNER_PATHS = [
  'id',
  'name',
  'note',
  'rank',
  'score',
  'active',
  'born',
  'seen',
  'kind',
  'data',
  'parentId',
  'parentId.name',
  'parentId.rank',
  'parentId.parentId.kind',
  'tagIds',
  'tagIds.name',
  'orderIds',
  'orderIds.total',
  'orderIds.ref',
  'orderIds.partnerId.name',
];

const leaf = (paths: readonly string[]): fc.Arbitrary<Leaf> =>
  fc
    .tuple(fc.constantFrom(...paths), fc.constantFrom(...ALL_OPERATORS))
    .chain(([path, operator]) =>
      (operator === 'in' || operator === 'not in' ? listOperand : scalarOperand).map(
        (value) => [path, operator, value] as const,
      ),
    );

const domain = (model: string, paths: readonly string[]): fc.Arbitrary<Domain> =>
  fc
    .array(fc.oneof(leaf(paths), fc.constantFrom('&', '|', '!')), { maxLength: 7 })
    .map((terms) => terms as unknown as Domain)
    // Keep the domains the parser accepts (the parser is not what is under test here).
    .filter((candidate) => {
      try {
        parseDomain(candidate, model, resolve);
        return true;
      } catch {
        return false;
      }
    });

const ORDERABLE = [
  'name',
  'note',
  'rank',
  'score',
  'active',
  'born',
  'seen',
  'kind',
  'parentId',
  'id',
];
const orderTerms: fc.Arbitrary<OrderTerm[]> = fc.array(
  fc.record({
    field: fc.constantFrom(...ORDERABLE),
    direction: fc.constantFrom('asc' as const, 'desc' as const),
  }),
  { maxLength: 3 },
);

// ─── harness ─────────────────────────────────────────────────────────────────────────────

class Rollback extends Error {}

/** Runs `work` with a PostgreSQL storage inside a transaction that is always rolled back. */
async function inRollback(db: Executor, work: (storage: Storage) => Promise<void>): Promise<void> {
  try {
    await db.transaction().execute(async (trx) => {
      await work(createPgStorage(trx, registry));
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

async function load(storage: Storage, data: Dataset): Promise<void> {
  await storage.insert(registry.get('par.tag'), data.tags);
  await storage.insert(registry.get('par.partner'), data.partners);
  await storage.insert(registry.get('par.order'), data.orders);
}

const databases = useTestDatabases();

/** More cases on demand: `PARITY_RUNS=2000 pnpm test`. */
const RUNS = Number(process.env.PARITY_RUNS ?? '60');

describe('PostgreSQL storage parity with the reference storage', () => {
  it('finds the same records, in the same order, for random domains', async () => {
    const db = await databases.create();
    await applySchema(db, registry);
    const partners = registry.get('par.partner');
    const orders = registry.get('par.order');
    const orderPaths = [
      'partnerId',
      'partnerId.name',
      'partnerId.tagIds.name',
      'partnerId.orderIds',
      'total',
      'ref',
    ];

    await fc.assert(
      fc.asyncProperty(
        dataset,
        fc.array(fc.tuple(domain('par.partner', PARTNER_PATHS), orderTerms, fc.option(fc.nat(4))), {
          minLength: 1,
          maxLength: 12,
        }),
        fc.array(domain('par.order', orderPaths), { minLength: 1, maxLength: 4 }),
        async (data, partnerQueries, orderQueries) => {
          const memory = createMemoryStorage(registry);
          await load(memory, data);
          await inRollback(db, async (pgStorage) => {
            await load(pgStorage, data);
            for (const [query, order, limit] of partnerQueries) {
              const where = parseDomain(query, 'par.partner', resolve);
              const options = { order, limit: limit ?? undefined };
              const context = JSON.stringify({ query, order, limit });
              expect(await pgStorage.search(partners, where, options), context).toEqual(
                await memory.search(partners, where, options),
              );
              expect(await pgStorage.count(partners, where), context).toBe(
                await memory.count(partners, where),
              );
            }
            for (const query of orderQueries) {
              const where = parseDomain(query, 'par.order', resolve);
              expect(await pgStorage.search(orders, where, {}), JSON.stringify(query)).toEqual(
                await memory.search(orders, where, {}),
              );
            }
          });
        },
      ),
      { numRuns: RUNS },
    );
  }, 300_000);

  it('reads back exactly what was written, through updates and deletions', async () => {
    const db = await databases.create();
    await applySchema(db, registry);
    const partners = registry.get('par.partner');
    const fields = [...partners.fields.keys()].filter(
      (name) => name !== 'orderIds' && name !== 'id',
    );

    await fc.assert(
      fc.asyncProperty(
        dataset,
        fc.array(
          fc.record({
            target: fc.nat(PARTNERS.length - 1),
            name: fc.constantFrom(...TEXTS),
            score: fc.constantFrom(...DECIMALS),
            tagIds: fc.subarray(TAGS),
            data: fc.constantFrom(...JSONS),
          }),
          { maxLength: 4 },
        ),
        fc.subarray(PARTNERS),
        async (data, updates, deleted) => {
          const memory = createMemoryStorage(registry);
          await load(memory, data);
          await inRollback(db, async (pgStorage) => {
            await load(pgStorage, data);
            const orders = registry.get('par.order');
            for (const storage of [memory, pgStorage]) {
              for (const { target, ...values } of updates) {
                await storage.update(partners, PARTNERS[target] as string, values);
              }
              // The ORM clears references before deleting (ondelete is handled above the storage).
              for (const row of data.partners) {
                if (deleted.includes(row.values.parentId as string)) {
                  await storage.update(partners, row.id, { parentId: null });
                }
              }
              for (const row of data.orders) {
                if (deleted.includes(row.values.partnerId as string)) {
                  await storage.update(orders, row.id, { partnerId: null });
                }
              }
              await storage.delete(partners, deleted);
            }
            expect(await pgStorage.read(partners, PARTNERS, fields)).toEqual(
              await memory.read(partners, PARTNERS, fields),
            );
            const orderFields = ['partnerId', 'total', 'ref'];
            expect(await pgStorage.read(orders, ORDERS, orderFields)).toEqual(
              await memory.read(orders, ORDERS, orderFields),
            );
            expect([...(await pgStorage.read(partners, PARTNERS, ['name'])).keys()].sort()).toEqual(
              PARTNERS.filter((id) => !deleted.includes(id)).sort(),
            );
          });
        },
      ),
      { numRuns: Math.ceil(RUNS / 2) },
    );
  }, 300_000);
});
