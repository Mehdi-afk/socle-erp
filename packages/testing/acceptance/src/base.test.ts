// SPDX-License-Identifier: LGPL-3.0-only
//
// Lot 2.1: the real `base` module of the repository, installed by the CLI on PostgreSQL —
// reference data from official sources, security mirrored as records, and the authorised-
// company rule declared once on the `company.scoped` mixin.
import { join } from 'node:path';

import { main } from '@socle/cli';
import {
  compose,
  createTenantSource,
  databaseUrl,
  listTenants,
  loadModules,
  tenantDatabase,
} from '@socle/runtime';
import { randomBytes } from 'node:crypto';
import {
  createAccessControl,
  createEnvironment,
  createRegistrySnapshot,
  hydrateRegistrySnapshot,
  type Environment,
  type ModelRegistry,
  type SecurityPolicy,
  type UserContext,
} from '@socle/framework';
import { createPgDatabase, createPgStorage, type Executor } from '@socle/orm-pg';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

const REPOSITORY_MODULES = join(import.meta.dirname, '..', '..', '..', '..', 'modules');

let db: Executor;
let registry: ModelRegistry;
let security: SecurityPolicy;
let installOutput = '';
let tenantName = '';
let adminUrl = '';

beforeAll(async () => {
  const pgUrl = inject('pgUrl');
  const tenant = `base${randomBytes(4).toString('hex')}`;
  tenantName = tenant;
  adminUrl = pgUrl;
  const lines: string[] = [];
  const io = {
    env: { SOCLE_DATABASE_URL: pgUrl, SOCLE_MODULE_PATHS: REPOSITORY_MODULES },
    cwd: REPOSITORY_MODULES,
    out: { line: (text: string) => lines.push(text) },
    err: { line: (text: string) => lines.push(text) },
  };
  expect(await main(['db', 'create', tenant], io), lines.join('\n')).toBe(0);
  expect(await main(['module', 'install', tenant, 'base'], io), lines.join('\n')).toBe(0);
  installOutput = lines.join('\n');
  db = createPgDatabase({ connectionString: databaseUrl(pgUrl, tenantDatabase(tenant)), max: 2 });
  ({ registry, security } = compose(await loadModules([REPOSITORY_MODULES]), ['base']));
});
afterAll(async () => {
  await db.destroy();
});

const count = async (table: string): Promise<number> =>
  (await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)}`.execute(db)).rows[0]
    ?.n ?? -1;

function inTransaction<T>(user: UserContext, work: (env: Environment) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    const env = createEnvironment({
      registry,
      storage: createPgStorage(trx, registry),
      user,
      access: createAccessControl(security, registry),
      audit: { record: () => undefined },
    });
    const result = await work(env);
    await env.flush();
    return result;
  });
}

describe('module base', () => {
  it('loads the reference data of the official sources', async () => {
    expect(installOutput).toMatch(/Installed base/);
    expect(await count('res_currency')).toBe(165);
    expect(await count('res_country')).toBe(249);
    expect(await count('res_country_state')).toBe(101 + 58);
    const dzd = await sql<{
      decimals: number;
      active: boolean;
    }>`select decimals, active from res_currency where code = 'DZD'`.execute(db);
    expect(dzd.rows).toEqual([{ decimals: 2, active: true }]);
    const wilaya = await sql<{
      name: string;
    }>`select s.name from res_country_state s join res_country c on c.id = s.country_id where c.code = 'DZ' and s.code = '16'`.execute(
      db,
    );
    expect(wilaya.rows).toEqual([{ name: 'Alger' }]);
  });

  it('mirrors its groups, access rights and rules as records', async () => {
    const groups = await sql<{
      code: string;
      implied: string[] | null;
    }>`select g.code, array_agg(i.code order by i.code) filter (where i.code is not null) as implied from res_groups g left join res_groups_implied_rel r on r.source_id = g.id left join res_groups i on i.id = r.target_id group by g.code order by g.code`.execute(
      db,
    );
    expect(groups.rows).toEqual([
      { code: 'base.group_erp_manager', implied: ['base.group_user'] },
      { code: 'base.group_system', implied: ['base.group_erp_manager'] },
      { code: 'base.group_user', implied: null },
    ]);
    expect(await count('ir_model_access')).toBeGreaterThan(10);
    expect(
      (await sql<{ code: string }>`select code from ir_rule order by code`.execute(db)).rows,
    ).toEqual([{ code: 'base.company_allowed' }, { code: 'base.company_scoped' }]);
  });

  it('restricts every company-scoped model to the authorised companies', async () => {
    const root: UserContext = {
      id: 'root',
      groupIds: ['base.group_system'],
      companyIds: [],
      companyId: null,
      lang: 'fr',
      tz: 'UTC',
    };
    const [c1, c2] = await inTransaction(root, async (env) => {
      const sudo = env.sudo('test fixtures');
      const eur = await sudo.model('res.currency').search([['code', '=', 'EUR']]);
      const companies = await sudo.model('res.company').create([
        { name: 'Acme France', currencyId: eur.ids[0] as string },
        { name: 'Acme Algérie', currencyId: eur.ids[0] as string },
      ]);
      const [first, second] = companies.ids as [string, string];
      await sudo.model('res.partner').create([
        { name: 'Client A', companyId: first },
        { name: 'Client B', companyId: second },
        { name: 'Shared supplier', companyId: null },
      ]);
      await sudo.model('ir.config_parameter').create([
        { key: 'invoice.footer', value: 'A', companyId: first },
        { key: 'invoice.footer', value: 'B', companyId: second },
      ]);
      return [first, second];
    });

    const alice: UserContext = {
      id: 'alice',
      groupIds: ['base.group_system'],
      companyIds: [c1],
      companyId: c1,
      lang: 'fr',
      tz: 'UTC',
    };
    await inTransaction(alice, async (env) => {
      const partners = await env.model('res.partner').search([], { order: 'name' });
      await partners.prefetch(['name']);
      expect([...partners].map((p) => (p as unknown as { name: string }).name)).toEqual([
        'Client A',
        'Shared supplier',
      ]);
      const parameters = await env.model('ir.config_parameter').search([]);
      await parameters.prefetch(['value']);
      expect([...parameters].map((p) => (p as unknown as { value: string }).value)).toEqual(['A']);
      const companies = await env.model('res.company').search([]);
      expect(companies.ids).toEqual([c1]);
      // A new company-scoped record defaults to the user's current company.
      const created = await env.model('res.partner').create({ name: 'New' });
      await created.prefetch(['companyId']);
      expect((created as unknown as { companyId: { id: string } }).companyId.id).toBe(c1);
    });
    expect(c2).not.toBe(c1);
  });

  it('numbers without gaps under concurrency, and with gaps in standard mode', async () => {
    const root: UserContext = {
      id: 'root',
      groupIds: ['base.group_system'],
      companyIds: [],
      companyId: null,
      lang: 'fr',
      tz: 'Africa/Algiers',
    };
    type Sequences = { nextByCode(code: string): Promise<string> };
    const next = (code: string) =>
      inTransaction(root, (env) =>
        (env.model('ir.sequence') as unknown as Sequences).nextByCode(code),
      );
    await inTransaction(root, (env) =>
      env.model('ir.sequence').create([
        { code: 'test.gapless', prefix: 'F{YYYY}-', padding: 4, implementation: 'no_gap' },
        { code: 'test.standard', prefix: 'S', padding: 3 },
      ]),
    );
    const year = new Date().getUTCFullYear();

    // A takes a number and keeps its transaction open; B asks meanwhile. With the row lock, B
    // waits for A's commit and gets the next number; without it, B would read the old counter.
    let taken!: () => void;
    const aHasTaken = new Promise<void>((resolve) => {
      taken = resolve;
    });
    const a = inTransaction(root, async (env) => {
      const number = await (env.model('ir.sequence') as unknown as Sequences).nextByCode(
        'test.gapless',
      );
      taken();
      await new Promise((resolve) => setTimeout(resolve, 500));
      return number;
    });
    await aHasTaken;
    const b = next('test.gapless');
    expect([await a, await b]).toEqual([`F${String(year)}-0001`, `F${String(year)}-0002`]);

    // A transaction that fails gives its number back (no gap)…
    await expect(
      inTransaction(root, async (env) => {
        await (env.model('ir.sequence') as unknown as Sequences).nextByCode('test.gapless');
        throw new Error('the invoice could not be posted');
      }),
    ).rejects.toThrow('could not be posted');
    expect(await next('test.gapless')).toMatch(/-0003$/);

    // …while the standard mode never blocks and loses it (a gap).
    expect(await next('test.standard')).toBe('S001');
    await expect(
      inTransaction(root, async (env) => {
        await (env.model('ir.sequence') as unknown as Sequences).nextByCode('test.standard');
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(await next('test.standard')).toBe('S003');
    await expect(next('test.missing')).rejects.toThrow(/No active sequence/);
  });

  it('is found at run time with its installed modules', async () => {
    const source = createTenantSource({ adminUrl, moduleRoots: [REPOSITORY_MODULES] });
    try {
      const resolved = await source.resolve(tenantName);
      expect(resolved?.modules).toEqual(['base']);
      expect(resolved?.registry.has('res.partner')).toBe(true);
      expect(resolved?.views.default('res.partner', 'form')?.model).toBe('res.partner');
      expect(resolved?.connectionString).toContain(tenantDatabase(tenantName));
      if (!resolved) throw new Error('The installed base tenant was not found.');
      const administrator: UserContext = {
        id: 'metadata-admin',
        groupIds: ['base.group_system'],
        companyIds: [],
        companyId: null,
        lang: 'fr',
        tz: 'UTC',
      };
      const metadata = hydrateRegistrySnapshot(
        createRegistrySnapshot({ ...resolved, user: administrator }),
      );
      expect(metadata.views.ids()).toEqual([
        'base.company_form',
        'base.company_list',
        'base.config_parameter_list',
        'base.country_list',
        'base.currency_list',
        'base.partner_form',
        'base.partner_list',
        'base.users_form',
        'base.users_list',
      ]);
      expect(metadata.registry.has('res.partner')).toBe(true);
      expect(metadata.registry.field('res.users', 'name')).toMatchObject({ type: 'char' });
      expect(metadata.registry.field('res.users', 'companyId')).toMatchObject({
        type: 'many2one',
        comodel: 'res.company',
        required: true,
      });
      expect(metadata.permissions.get('res.users')).toEqual({
        create: true,
        write: true,
        unlink: true,
      });
      expect(metadata.permissions.get('ir.rule')).toEqual({
        create: false,
        write: false,
        unlink: false,
      });
      const employee = hydrateRegistrySnapshot(
        createRegistrySnapshot({
          ...resolved,
          user: { ...administrator, id: 'metadata-employee', groupIds: ['base.group_user'] },
        }),
      );
      expect(employee.views.ids()).toEqual(
        metadata.views.ids().filter((id) => id !== 'base.config_parameter_list'),
      );
      expect(employee.registry.has('ir.config_parameter')).toBe(false);
      expect(employee.registry.has('ir.rule')).toBe(false);
      expect(employee.permissions.get('res.users')).toEqual({
        create: false,
        write: false,
        unlink: false,
      });
      expect(employee.registry.field('res.users', 'login')?.readonly).toBe(true);
      expect(employee.registry.field('res.partner', 'name')?.readonly).toBe(false);
      // The composition of a set of modules is computed once.
      expect((await source.resolve(tenantName))?.registry).toBe(resolved.registry);
      expect((await source.resolve(tenantName))?.views).toBe(resolved.views);
      expect(await source.resolve('nobody-here')).toBeUndefined();
      expect(await source.resolve('Not A Tenant')).toBeUndefined();
    } finally {
      await source.close();
    }
    const admin = createPgDatabase({ connectionString: adminUrl, max: 1 });
    try {
      expect(await listTenants(admin)).toContain(tenantName);
    } finally {
      await admin.destroy();
    }
  });
});
