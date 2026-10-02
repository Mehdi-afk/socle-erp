// SPDX-License-Identifier: LGPL-3.0-only
//
// The ORM end to end on a real PostgreSQL, and the automatic schema changes.
import {
  buildModelRegistry,
  createEnvironment,
  defineModel,
  extendModel,
  f,
  ValidationError,
  type Environment,
  type FieldsOf,
  type ModelDefinition,
  type ModelExtension,
  type ModelRegistry,
  type WriteChange,
} from '@socle/framework';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { applySchema } from './apply.js';
import type { Executor } from './database.js';
import { SchemaError } from './errors.js';
import { createPgStorage, translateCommitError } from './storage.js';
import { useTestDatabases } from './test-support.js';

const partner = defineModel({
  name: 'e2e.partner',
  fields: {
    name: f.char({ required: true }),
    email: f.char(),
    tagIds: f.many2many('e2e.tag'),
  },
  unique: [{ name: 'email_uniq', fields: ['email'] }],
});
const tag = defineModel({ name: 'e2e.tag', fields: { name: f.char() } });
const order = defineModel({
  name: 'e2e.order',
  fields: {
    name: f.char({ required: true }),
    partnerId: f.many2one('e2e.partner', { ondelete: 'restrict' }),
    lines: f.one2many('e2e.line', 'orderId'),
    total: f.monetary({ compute: 'computeTotal', store: true, depends: ['lines.amount'] }),
  },
  order: 'name',
  methods: (Base) =>
    class extends Base {
      computeTotal(): void {
        for (const o of this) o.total = [...o.lines].reduce((sum, line) => sum + line.amount, 0);
      }
    },
});
const line = defineModel({
  name: 'e2e.line',
  fields: {
    orderId: f.many2one('e2e.order', { required: true, ondelete: 'cascade' }),
    amount: f.monetary(),
  },
});

declare module '@socle/framework' {
  interface ModelFields {
    'e2e.order': FieldsOf<typeof order>;
    'e2e.line': FieldsOf<typeof line>;
    'e2e.partner': FieldsOf<typeof partner>;
  }
}

const registryOf = (...models: (ModelDefinition | ModelExtension)[]): ModelRegistry =>
  buildModelRegistry([{ module: 'e2e', models }], { side: 'server' });

const registry = registryOf(partner, tag, order, line);

/** Runs `work` in one committed transaction, as a request of the server will. */
async function request<T>(
  db: Executor,
  work: (env: Environment) => Promise<T>,
  modelRegistry: ModelRegistry = registry,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    const env = createEnvironment({
      registry: modelRegistry,
      storage: createPgStorage(trx, modelRegistry),
      user: { id: 'u1', groupIds: [], companyIds: [], companyId: null, lang: 'fr', tz: 'UTC' },
      access: { checkModel: () => undefined, ruleDomain: () => ({ kind: 'true' }) },
      audit: { record: () => undefined },
    });
    const result = await work(env);
    await env.flush();
    return result;
  });
}

const databases = useTestDatabases();

describe('ORM on PostgreSQL', () => {
  it('runs write hooks after validation and rolls both parent and hook data back on failure', async () => {
    const extension = extendModel('e2e.partner', {
      constraints: [{ fields: ['name'], check: 'checkName' }],
      methods: (Base) =>
        class extends Base {
          checkName(): void {
            for (const record of this)
              if (record.name === 'Invalid') throw new ValidationError('Invalid name.');
          }
          override async afterWrite(changes: readonly WriteChange[]): Promise<void> {
            await super.afterWrite(changes);
            await this.env.model('e2e.tag').create({ name: 'Written by hook' });
            if (changes.some((change) => change.values.name?.after === 'Hook failure'))
              throw new ValidationError('Hook failure.');
          }
        },
    });
    const extended = registryOf(partner, tag, order, line, extension);
    const db = await databases.create();
    await applySchema(db, extended);
    const id = await request(
      db,
      async (env) => (await env.model('e2e.partner').create({ name: 'Original' })).id,
      extended,
    );
    const write = (name: string) =>
      request(db, (env) => env.model('e2e.partner').browse([id]).write({ name }), extended);
    const state = () =>
      request(
        db,
        async (env) => ({
          name: (await env.model('e2e.partner').browse([id]).read(['name']))[0]?.name,
          hooks: await env.model('e2e.tag').searchCount([]),
        }),
        extended,
      );
    expect(await state()).toEqual({ name: 'Original', hooks: 0 });
    await expect(write('Invalid')).rejects.toThrow('Invalid name.');
    expect(await state()).toEqual({ name: 'Original', hooks: 0 });
    await expect(write('Hook failure')).rejects.toThrow('Hook failure.');
    expect(await state()).toEqual({ name: 'Original', hooks: 0 });
    await write('Accepted');
    await write('Accepted');
    expect(await state()).toEqual({ name: 'Accepted', hooks: 1 });
  });

  it('creates, computes, searches, writes and deletes', async () => {
    const db = await databases.create();
    await applySchema(db, registry);

    const orderId = await request(db, async (env) => {
      const [red, blue] = [
        ...(await env.model('e2e.tag').create([{ name: 'red' }, { name: 'blue' }])),
      ];
      const acme = await env
        .model('e2e.partner')
        .create({ name: 'Acme', email: 'a@acme.fr', tagIds: [red?.id, blue?.id] });
      const created = await env.model('e2e.order').create({
        name: 'SO1',
        partnerId: acme.id,
        lines: [{ amount: 1000 }, { amount: 250 }],
      });
      return created.id;
    });

    await request(db, async (env) => {
      const so = env.model('e2e.order').browse([orderId]);
      await so.prefetch(['total', 'lines.amount', 'partnerId.name']);
      expect(so.total).toBe(1250);
      expect(so.partnerId.name).toBe('Acme');
      expect(
        await env.model('e2e.order').searchCount([['partnerId.tagIds.name', '=', 'blue']]),
      ).toBe(1);
      expect(await env.model('e2e.order').searchCount([['lines.amount', '>', 999]])).toBe(1);
      // Recomputation after a write on a line is stored in PostgreSQL.
      const [first] = [...so.lines];
      await first?.write({ amount: 10 });
    });

    await request(db, async (env) => {
      const so = env.model('e2e.order').browse([orderId]);
      await so.prefetch(['total']);
      expect(so.total).toBe(260);
      // ondelete restrict: the ORM refuses before the database has to.
      const acme = await env.model('e2e.partner').search([['name', '=', 'Acme']]);
      await expect(acme.unlink()).rejects.toThrow(ValidationError);
    });

    await request(db, async (env) => {
      // ondelete cascade: deleting the order deletes its lines.
      await env.model('e2e.order').browse([orderId]).unlink();
      expect(await env.model('e2e.line').searchCount([])).toBe(0);
      const acme = await env.model('e2e.partner').search([['name', '=', 'Acme']]);
      await acme.unlink();
    });
    const relations = await sql<{
      n: number;
    }>`select count(*)::integer as n from e2e_partner_tag_ids_rel`.execute(db);
    expect(relations.rows[0]?.n).toBe(0);
  });

  it('turns a unique violation into a validation error and rolls the request back', async () => {
    const db = await databases.create();
    await applySchema(db, registry);
    await request(db, (env) => env.model('e2e.partner').create({ name: 'A', email: 'same@x.fr' }));
    await expect(
      request(db, async (env) => {
        await env.model('e2e.partner').create({ name: 'Kept?', email: 'other@x.fr' });
        await env.model('e2e.partner').create({ name: 'B', email: 'same@x.fr' });
      }),
    ).rejects.toThrow(/Uniqueness "email_uniq" violated/);
    const names = await sql<{ name: string }>`select name from e2e_partner order by name`.execute(
      db,
    );
    expect(names.rows.map((row) => row.name)).toEqual(['A']);
  });

  it('checks references at commit (deferred foreign keys)', async () => {
    const db = await databases.create();
    await applySchema(db, registry);
    await expect(
      db.transaction().execute(async (trx) => {
        const storage = createPgStorage(trx, registry);
        // A line pointing to an order that never gets created: accepted until commit.
        await storage.insert(registry.get('e2e.line'), [
          {
            id: '0190a000-0000-7000-8000-000000000001',
            values: { orderId: '0190a000-0000-7000-8000-000000000002', amount: 1 },
          },
        ]);
      }),
    ).rejects.toThrow(/foreign key/);
  });

  // Regression: a reference to a record deleted meanwhile (a device offline) was reported as a
  // temporary failure, so the device retried it forever and never converged.
  it('turns a foreign key violation at commit into a validation error', async () => {
    const db = await databases.create();
    await applySchema(db, registry);
    const failure: unknown = await db
      .transaction()
      .execute(async (trx) => {
        await createPgStorage(trx, registry).insert(registry.get('e2e.line'), [
          {
            id: '0190a000-0000-7000-8000-000000000003',
            values: { orderId: '0190a000-0000-7000-8000-000000000004', amount: 1 },
          },
        ]);
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(translateCommitError(failure)).toBeInstanceOf(ValidationError);
    const other = new Error('connection lost');
    expect(translateCommitError(other)).toBe(other);
  });
});

describe('applySchema', () => {
  it('is idempotent and records the applied schema', async () => {
    const db = await databases.create();
    const first = await applySchema(db, registry);
    expect(first.operations.length).toBeGreaterThan(0);
    const second = await applySchema(db, registry);
    expect(second.operations).toEqual([]);
  });

  it('adds the columns of a newly installed extension, keeping existing rows', async () => {
    const db = await databases.create();
    await applySchema(db, registry);
    await request(db, (env) => env.model('e2e.partner').create({ name: 'Old' }));
    const extension = extendModel('e2e.partner', {
      fields: { vip: f.boolean(), score: f.integer(), phone: f.char() },
    });
    const plan = await applySchema(db, registryOf(partner, tag, order, line, extension));
    expect(plan.operations.map((op) => op.kind)).toEqual(['addColumn', 'addColumn', 'addColumn']);
    const rows = await sql<{
      vip: boolean;
      score: number;
      phone: string | null;
    }>`select vip, score, phone from e2e_partner`.execute(db);
    expect(rows.rows).toEqual([{ vip: false, score: 0, phone: null }]);
  });

  it('refuses a destructive change and leaves the database untouched', async () => {
    const db = await databases.create();
    await applySchema(db, registry);
    const retyped = defineModel({ ...tag, fields: { name: f.integer() } });
    const extension = extendModel('e2e.partner', { fields: { phone: f.char() } });
    await expect(
      applySchema(db, registryOf(partner, retyped, order, line, extension)),
    ).rejects.toThrow(SchemaError);
    const columns = await sql<{
      column_name: string;
    }>`select column_name from information_schema.columns where table_name = 'e2e_partner' and column_name = 'phone'`.execute(
      db,
    );
    expect(columns.rows).toEqual([]);
  });
});
