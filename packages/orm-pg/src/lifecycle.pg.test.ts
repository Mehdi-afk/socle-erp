// SPDX-License-Identifier: LGPL-3.0-only
//
// Module installation, upgrade with hand-written migrations, uninstallation and snapshots on
// a real PostgreSQL (ARCHITECTURE.md §4.7).
import {
  buildModelRegistry,
  defineModel,
  extendModel,
  f,
  type ModelDefinition,
  type ModelExtension,
  type ModuleModels,
} from '@socle/framework';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import type { Executor } from './database.js';
import {
  installedModules,
  LifecycleError,
  uninstallModules,
  upgradeModules,
  type ModuleExport,
} from './lifecycle.js';
import type { ModuleMigration } from './migrations.js';
import { createTemplateSnapshots, type SnapshotStore } from './snapshot.js';
import { useTestDatabases } from './test-support.js';

// ─── module "lc_base" v1 and v2, module "lc_extra" extending it ─────────────────────────────

const tagV1 = defineModel({ name: 'lc.tag', fields: { name: f.char() } });
const partnerV1 = defineModel({
  name: 'lc.partner',
  fields: { name: f.char(), ref: f.char(), rank: f.char(), tagIds: f.many2many('lc.tag') },
});
// v2: `ref` renamed to `code`, `rank` becomes an integer, new field `city`.
const partnerV2 = defineModel({
  name: 'lc.partner',
  fields: {
    name: f.char(),
    code: f.char(),
    rank: f.integer(),
    city: f.char(),
    tagIds: f.many2many('lc.tag'),
  },
});
const extra = extendModel('lc.partner', {
  fields: { vip: f.boolean(), segmentIds: f.many2many('lc.tag') },
});
const note = defineModel({
  name: 'lc.note',
  fields: { partnerId: f.many2one('lc.partner'), body: f.text() },
});

const base = (models: (ModelDefinition | ModelExtension)[]): ModuleModels => ({
  module: 'lc_base',
  models,
});
const extraModule: ModuleModels = { module: 'lc_extra', models: [extra, note] };
const registryOf = (...modules: ModuleModels[]) => buildModelRegistry(modules, { side: 'server' });

const v1 = registryOf(base([tagV1, partnerV1]));
const v2 = registryOf(base([tagV1, partnerV2]));

const renameAndRetype: ModuleMigration = {
  version: '2.0.0',
  async pre(context) {
    await context.renameColumn('lc.partner', 'ref', 'code');
    await context.changeColumnType(
      'lc.partner',
      'rank',
      'bigint',
      sql`coalesce(nullif(regexp_replace(rank, '[^0-9]', '', 'g'), '')::bigint, 0)`,
    );
    await context.setNotNull('lc.partner', 'rank', true);
  },
  async post(context) {
    await sql`update lc_partner set city = 'Alger' where city is null`.execute(context.db);
  },
};

const databases = useTestDatabases();

async function tenant(): Promise<{ db: Executor; snapshots: SnapshotStore }> {
  const { db, name, admin } = await databases.createNamed();
  return { db, snapshots: createTemplateSnapshots(admin, name) };
}

const rows = async (db: Executor, query: ReturnType<typeof sql>) =>
  (await query.execute(db)).rows as Record<string, unknown>[];

describe('module lifecycle', () => {
  it('installs, then upgrades through hand-written migrations', async () => {
    const { db, snapshots } = await tenant();
    const install = await upgradeModules({
      db,
      registry: v1,
      modules: [{ name: 'lc_base', version: '1.0.0' }],
      snapshots,
    });
    expect(install.installed).toEqual(['lc_base']);
    expect(install.snapshot.label).toBe('avant_installation');
    expect(await installedModules(db)).toEqual(new Map([['lc_base', '1.0.0']]));
    await sql`insert into lc_partner (id, name, ref, rank) values ('0190a000-0000-7000-8000-000000000001', 'Acme', 'A-1', 'n°12')`.execute(
      db,
    );

    const upgrade = await upgradeModules({
      db,
      registry: v2,
      modules: [{ name: 'lc_base', version: '2.0.0', migrations: [renameAndRetype] }],
      snapshots,
    });
    expect(upgrade.snapshot.label).toBe('avant_mise_a_jour');
    expect(upgrade.upgraded).toEqual([{ name: 'lc_base', from: '1.0.0', to: '2.0.0' }]);
    expect(await rows(db, sql`select name, code, rank, city from lc_partner`)).toEqual([
      { name: 'Acme', code: 'A-1', rank: 12, city: 'Alger' },
    ]);
    expect(await installedModules(db)).toEqual(new Map([['lc_base', '2.0.0']]));
  });

  it('rolls everything back when a change needs a migration that is missing', async () => {
    const { db, snapshots } = await tenant();
    await upgradeModules({
      db,
      registry: v1,
      modules: [{ name: 'lc_base', version: '1.0.0' }],
      snapshots,
    });
    const failure = upgradeModules({
      db,
      registry: v2,
      modules: [{ name: 'lc_base', version: '2.0.0' }],
      snapshots,
    });
    await expect(failure).rejects.toThrow(LifecycleError);
    await expect(failure).rejects.toThrow(/rank: type text → bigint/);
    // Nothing applied: no `city` column, version unchanged; a snapshot was taken anyway.
    expect(
      await rows(
        db,
        sql`select column_name from information_schema.columns where table_name = 'lc_partner' and column_name = 'city'`,
      ),
    ).toEqual([]);
    expect(await installedModules(db)).toEqual(new Map([['lc_base', '1.0.0']]));
    expect((await snapshots.list()).map((s) => s.label)).toEqual([
      'avant_mise_a_jour',
      'avant_installation',
    ]);
  });

  it('refuses a downgrade', async () => {
    const { db, snapshots } = await tenant();
    await upgradeModules({
      db,
      registry: v1,
      modules: [{ name: 'lc_base', version: '1.2.0' }],
      snapshots,
    });
    await expect(
      upgradeModules({
        db,
        registry: v1,
        modules: [{ name: 'lc_base', version: '1.1.0' }],
        snapshots,
      }),
    ).rejects.toThrow(/Downgrade/);
  });

  it('uninstalls a module: exports its data, then removes its tables and columns', async () => {
    const { db, snapshots } = await tenant();
    await upgradeModules({
      db,
      registry: registryOf(base([tagV1, partnerV1]), extraModule),
      modules: [
        { name: 'lc_base', version: '1.0.0' },
        { name: 'lc_extra', version: '1.0.0' },
      ],
      snapshots,
    });
    const p = '0190a000-0000-7000-8000-000000000001';
    const t = '0190a000-0000-7000-8000-000000000002';
    await sql`insert into lc_tag (id, name) values (${t}::uuid, 'gold')`.execute(db);
    await sql`insert into lc_partner (id, name, vip) values (${p}::uuid, 'Acme', true)`.execute(db);
    await sql`insert into lc_partner_segment_ids_rel (source_id, target_id) values (${p}::uuid, ${t}::uuid)`.execute(
      db,
    );
    await sql`insert into lc_note (id, partner_id, body) values ('0190a000-0000-7000-8000-000000000003', ${p}::uuid, 'hello')`.execute(
      db,
    );

    // The base module cannot go while lc_extra (which references it) is installed.
    await expect(
      uninstallModules({
        db,
        registry: registryOf(),
        modules: [base([tagV1, partnerV1])],
        snapshots,
        exportData: async () => {},
      }),
    ).rejects.toThrow(/still referenced/);

    const exports: ModuleExport[] = [];
    const snapshot = await uninstallModules({
      db,
      registry: v1,
      modules: [extraModule],
      snapshots,
      exportData: (data) => {
        exports.push(data);
        return Promise.resolve();
      },
    });
    expect(snapshot.label).toBe('avant_desinstallation');
    const [exported] = exports;
    expect(exported?.module).toBe('lc_extra');
    expect(exported?.columns).toEqual({ lc_partner: { vip: [{ id: p, value: true }] } });
    expect(Object.keys(exported?.tables ?? {}).sort()).toEqual([
      'lc_note',
      'lc_partner_segment_ids_rel',
    ]);
    expect(exported?.tables.lc_note?.[0]).toMatchObject({ body: 'hello', partner_id: p });

    const columns = await rows(
      db,
      sql`select column_name from information_schema.columns where table_name = 'lc_partner' order by column_name`,
    );
    expect(columns.map((c) => c.column_name)).not.toContain('vip');
    expect(await rows(db, sql`select to_regclass('lc_note')::text as t`)).toEqual([{ t: null }]);
    expect(await installedModules(db)).toEqual(new Map([['lc_base', '1.0.0']]));
    // Data of the remaining module is untouched.
    expect(await rows(db, sql`select name from lc_partner`)).toEqual([{ name: 'Acme' }]);
  });
});

describe('snapshots', () => {
  it('restores the database as it was when the snapshot was taken', async () => {
    const { db, snapshots } = await tenant();
    await upgradeModules({
      db,
      registry: v1,
      modules: [{ name: 'lc_base', version: '1.0.0' }],
      snapshots,
    });
    await sql`insert into lc_tag (id, name) values ('0190a000-0000-7000-8000-000000000001', 'before')`.execute(
      db,
    );
    const snapshot = await snapshots.create('manuel');
    await sql`update lc_tag set name = 'after'`.execute(db);

    await snapshots.restore(snapshot);
    // The pool reconnects to the restored database.
    expect(await rows(db, sql`select name from lc_tag`)).toEqual([{ name: 'before' }]);

    await snapshots.drop(snapshot);
    expect((await snapshots.list()).some((s) => s.name === snapshot.name)).toBe(false);
    await expect(snapshots.restore(snapshot)).rejects.toThrow(/Unknown snapshot/);
  });
});
