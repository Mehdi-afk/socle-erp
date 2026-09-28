// SPDX-License-Identifier: LGPL-3.0-only
//
// Row-level security: the database enforces the record rules even when the ORM is bypassed,
// and is never stricter than the ORM. The application connects as a role that is not a
// superuser and owns the tables (FORCE ROW LEVEL SECURITY).
import {
  buildModelRegistry,
  buildSecurityPolicy,
  createAccessControl,
  createEnvironment,
  createMemoryStorage,
  defineModel,
  f,
  type ModuleSecurity,
  type Storage,
  type StorageActor,
  type UserContext,
} from '@socle/framework';
import fc from 'fast-check';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { applySchema } from './apply.js';
import type { Executor } from './database.js';
import { buildRowSecurity } from './rls.js';
import { createPgStorage } from './storage.js';
import { useTestDatabases } from './test-support.js';

const company = defineModel({ name: 'sec.company', fields: { name: f.char() } });
const invoice = defineModel({
  name: 'sec.invoice',
  fields: { name: f.char(), companyId: f.many2one('sec.company'), note: f.char() },
});
const registry = buildModelRegistry([{ module: 'sec', models: [company, invoice] }], {
  side: 'server',
});

const C1 = '0190a000-0000-7000-8000-0000000000c1';
const C2 = '0190a000-0000-7000-8000-0000000000c2';

const security: ModuleSecurity = {
  module: 'sec',
  groups: [
    { id: 'sec.group_user', name: { fr: 'Utilisateur' } },
    { id: 'sec.group_manager', name: { fr: 'Responsable' }, implies: ['sec.group_user'] },
  ],
  access: [
    { model: 'sec.company', group: null, read: true },
    { model: 'sec.invoice', group: 'sec.group_user', read: true, create: true, write: true },
    { model: 'sec.invoice', group: 'sec.group_manager', unlink: true },
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
  ],
};
const policy = buildSecurityPolicy([security], (model) => registry.has(model));
const access = createAccessControl(policy, registry);

const user = (id: string, groupIds: string[], companyIds: string[]): UserContext => ({
  id,
  groupIds,
  companyIds,
  companyId: companyIds[0] ?? null,
  lang: 'fr',
  tz: 'UTC',
});
const actor = (u: UserContext, su = false): StorageActor => ({
  userId: u.id,
  su,
  companyId: u.companyId,
  companyIds: u.companyIds,
  groupIds: u.groupIds,
});
const ROOT = user('root', [], []);

const databases = useTestDatabases();

async function prepared(): Promise<Executor> {
  const db = await databases.createOwned();
  await applySchema(db, registry, { security: policy });
  await db.transaction().execute(async (trx) => {
    const su = createPgStorage(trx, registry).as?.(actor(ROOT, true)) as Storage;
    await su.insert(registry.get('sec.company'), [
      { id: C1, values: { name: 'C1' } },
      { id: C2, values: { name: 'C2' } },
    ]);
  });
  return db;
}

/** Runs `work` in a transaction with the storage acting for `u`. */
function as<T>(
  db: Executor,
  u: UserContext,
  work: (storage: Storage, trx: Executor) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    const storage = createPgStorage(trx, registry).as?.(actor(u)) as Storage;
    // One harmless call so that the settings of `u` are written before raw SQL runs.
    await storage.count(registry.get('sec.company'), { kind: 'true' });
    return work(storage, trx);
  });
}

const names = async (trx: Executor): Promise<string[]> =>
  (await sql<{ name: string }>`select name from sec_invoice order by name`.execute(trx)).rows.map(
    (r) => r.name,
  );

describe('row-level security', () => {
  const alice = user('alice', ['sec.group_user'], [C1]);
  const bob = user('bob', ['sec.group_user'], [C1]);
  const carol = user('carol', ['sec.group_manager'], [C1]);

  it('enforces the record rules on raw SQL, whatever the ORM does', async () => {
    const db = await prepared();
    await db.transaction().execute(async (trx) => {
      const su = createPgStorage(trx, registry).as?.(actor(ROOT, true)) as Storage;
      const meta = registry.get('sec.invoice');
      await su.insert(meta, [
        {
          id: '0190a000-0000-7000-8000-000000000001',
          values: { name: 'A1', companyId: C1, createdBy: 'alice' },
        },
        {
          id: '0190a000-0000-7000-8000-000000000002',
          values: { name: 'B1', companyId: C1, createdBy: 'bob' },
        },
        {
          id: '0190a000-0000-7000-8000-000000000003',
          values: { name: 'X2', companyId: C2, createdBy: 'alice' },
        },
      ]);
    });

    await as(db, alice, async (_, trx) => {
      expect(await names(trx)).toEqual(['A1']);
      // Updating a row outside the rules touches nothing.
      const updated = await sql`update sec_invoice set note = 'hacked' where name = 'B1'`.execute(
        trx,
      );
      expect(updated.numAffectedRows).toBe(0n);
    });
    await as(db, carol, async (_, trx) => {
      // A manager (group implied: user) sees the whole company, not the other one.
      expect(await names(trx)).toEqual(['A1', 'B1']);
    });
    await expect(
      as(db, alice, async (_, trx) => {
        await sql`insert into sec_invoice (id, name, company_id, created_by) values ('0190a000-0000-7000-8000-000000000009', 'Z', ${C2}::uuid, 'alice')`.execute(
          trx,
        );
      }),
    ).rejects.toThrow(/row-level security/);
    await expect(
      as(db, alice, async (_, trx) => {
        // Moving one's own invoice to another company is refused (WITH CHECK).
        await sql`update sec_invoice set company_id = ${C2}::uuid where name = 'A1'`.execute(trx);
      }),
    ).rejects.toThrow(/row-level security/);

    // No user in the transaction: nothing is visible (fail closed).
    const anonymous = await db.transaction().execute((trx) => names(trx));
    expect(anonymous).toEqual([]);
    // Superuser (sudo, schema changes): everything.
    const all = await db.transaction().execute(async (trx) => {
      await (createPgStorage(trx, registry).as?.(actor(ROOT, true)) as Storage).count(
        registry.get('sec.company'),
        { kind: 'true' },
      );
      return names(trx);
    });
    expect(all).toEqual(['A1', 'B1', 'X2']);
  });

  it('lets the ORM work normally, and maps a policy refusal to an access error', async () => {
    const db = await prepared();
    const request = <T>(
      u: UserContext,
      work: (env: ReturnType<typeof createEnvironment>) => Promise<T>,
    ) =>
      db.transaction().execute(async (trx) => {
        const env = createEnvironment({
          registry,
          storage: createPgStorage(trx, registry),
          user: u,
          access,
          audit: { record: () => undefined },
        });
        const result = await work(env);
        await env.flush();
        return result;
      });
    await request(alice, (env) => env.model('sec.invoice').create({ name: 'A1', companyId: C1 }));
    await request(bob, (env) => env.model('sec.invoice').create({ name: 'B1', companyId: C1 }));
    const seen = (u: UserContext) =>
      request(u, async (env) =>
        [...(await env.model('sec.invoice').search([], { order: 'name' }))].map(
          (r) => (r as unknown as { name: string }).name,
        ),
      );
    expect(await seen(alice)).toEqual(['A1']);
    expect(await seen(carol)).toEqual(['A1', 'B1']);
    // The ORM itself refuses first (post-write check), before PostgreSQL would.
    await expect(
      request(alice, async (env) => {
        const mine = await env.model('sec.invoice').search([['name', '=', 'A1']]);
        await mine.write({ companyId: C2 });
      }),
    ).rejects.toThrow(/refused/);
    // Manager deletes through the ORM: allowed by ACL, rules and policies.
    await request(carol, async (env) => {
      const b1 = await env.model('sec.invoice').search([['name', '=', 'B1']]);
      await b1.unlink();
    });
    expect(await seen(carol)).toEqual(['A1']);
  });

  it('is never stricter than the ORM (random users and data)', async () => {
    const db = await prepared();
    const users = ['alice', 'bob', 'carol'];
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            company: fc.constantFrom(C1, C2, null),
            createdBy: fc.constantFrom(...users),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        fc.constantFrom(...users),
        fc.subarray(['sec.group_user', 'sec.group_manager']),
        fc.subarray([C1, C2]),
        async (rows, who, groups, companies) => {
          const u = user(who, groups, companies);
          const meta = registry.get('sec.invoice');
          const data = rows.map((row, i) => ({
            id: `0190a000-0000-7000-8000-${String(i + 100).padStart(12, '0')}`,
            values: { name: `I${String(i)}`, companyId: row.company, createdBy: row.createdBy },
          }));
          // Expected: what the ORM lets the user see, on the reference storage.
          const memory = createMemoryStorage(registry);
          await memory.insert(registry.get('sec.company'), [
            { id: C1, values: { name: 'C1' } },
            { id: C2, values: { name: 'C2' } },
          ]);
          await memory.insert(meta, data);
          const env = createEnvironment({
            registry,
            storage: memory,
            user: u,
            access,
            audit: { record: () => undefined },
          });
          let expected: string[];
          try {
            expected = (await env.model('sec.invoice').search([])).ids.slice().sort();
          } catch {
            return; // No read access at all (ACL): nothing to compare.
          }
          // Actual: raw SQL, only row-level security applies.
          const actual = await db
            .transaction()
            .execute(async (trx) => {
              const su = createPgStorage(trx, registry).as?.(actor(ROOT, true)) as Storage;
              await su.insert(meta, data);
              await su.count(meta, { kind: 'true' });
              const storage = createPgStorage(trx, registry).as?.(actor(u)) as Storage;
              await storage.count(registry.get('sec.company'), { kind: 'true' });
              const ids = (
                await sql<{ id: string }>`select id from sec_invoice order by id`.execute(trx)
              ).rows.map((r) => r.id);
              throw Object.assign(new Error('rollback'), { ids });
            })
            .catch((error: unknown) => (error as { ids?: string[] }).ids);
          expect(actual).toEqual(expected);
        },
      ),
      { numRuns: 40 },
    );
  }, 120_000);
});

describe('buildRowSecurity', () => {
  it('replaces rules crossing relations with TRUE and reports them', () => {
    const withPath = buildSecurityPolicy(
      [
        {
          ...security,
          rules: [
            ...(security.rules ?? []),
            {
              id: 'sec.invoice_company_name',
              model: 'sec.invoice',
              domain: [['companyId.name', '!=', 'Closed']],
            },
          ],
        },
      ],
      (model) => registry.has(model),
    );
    const plan = buildRowSecurity(registry, withPath);
    expect(plan.tables).toEqual(['sec_invoice']);
    expect(plan.policies.map((p) => p.command)).toEqual(['select', 'insert', 'update', 'delete']);
    expect(plan.approximated).toEqual([
      'sec.invoice_company_name: path "companyId.name" crosses a relation',
    ]);
  });
});

describe('row-level security of mixin rules', () => {
  it('mirrors a rule declared on a mixin on every table that mixes it in', () => {
    const scoped = defineModel({
      name: 'mix.scoped',
      abstract: true,
      fields: { companyId: f.char() },
    });
    const order = defineModel({
      name: 'mix.order',
      mixins: ['mix.scoped'],
      fields: { name: f.char() },
    });
    const note = defineModel({ name: 'mix.note', fields: { name: f.char() } });
    const models = buildModelRegistry([{ module: 'mix', models: [scoped, order, note] }], {
      side: 'server',
    });
    const mixPolicy = buildSecurityPolicy(
      [
        {
          module: 'mix',
          rules: [
            {
              id: 'mix.company',
              model: 'mix.scoped',
              domain: [['companyId', 'in', { $user: 'companyIds' }]],
            },
          ],
        },
      ],
      (model) => models.has(model),
    );
    const plan = buildRowSecurity(models, mixPolicy);
    expect(plan.tables).toEqual(['mix_order']);
    expect(plan.policies.map((p) => p.table)).toEqual(Array(4).fill('mix_order'));
  });
});
