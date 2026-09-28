// SPDX-License-Identifier: LGPL-3.0-only
//
// The `socle` commands against a real PostgreSQL: in process through main(), then through the
// real binary on Node (TypeScript run natively, ADR 011).
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

import { createPgDatabase, type Executor } from '@socle/orm-pg';
import { sql } from 'kysely';
import { afterAll, describe, expect, inject, it } from 'vitest';

import { databaseUrl, tenantDatabase } from './config.js';
import { main } from './main.js';
import { useTempDirs, writeShopModules } from './test-support.js';

const tempDir = useTempDirs();
const pgUrl = inject('pgUrl');
const pools: Executor[] = [];
afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.destroy()));
});

const newTenant = () => `cli${randomBytes(4).toString('hex')}`;

function cli(roots: readonly string[], cwd: string) {
  return async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, {
      env: { SOCLE_DATABASE_URL: pgUrl, SOCLE_MODULE_PATHS: roots.join(delimiter) },
      cwd,
      out: { line: (text) => out.push(text) },
      err: { line: (text) => err.push(text) },
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
}

function tenantDb(tenant: string): Executor {
  const db = createPgDatabase({ connectionString: databaseUrl(pgUrl, tenantDatabase(tenant)) });
  pools.push(db);
  return db;
}

async function columns(db: Executor, table: string): Promise<string[]> {
  const result = await sql<{
    column_name: string;
  }>`select column_name from information_schema.columns where table_name = ${table} order by column_name`.execute(
    db,
  );
  return result.rows.map((row) => row.column_name);
}

describe('socle db and module commands', () => {
  it('creates, installs, upgrades, backs up, uninstalls, restores and drops a tenant', async () => {
    const [v1, v2, cwd] = [await tempDir(), await tempDir(), await tempDir()];
    await writeShopModules(v1, '0.1.0');
    await writeShopModules(v2, '0.2.0');
    const tenant = newTenant();
    const socle = cli([v1], cwd);
    const socleV2 = cli([v2], cwd);

    expect(await socle('db', 'create', tenant)).toMatchObject({ code: 0 });
    expect(await socle('db', 'create', tenant)).toMatchObject({ code: 1, err: /already exists/ });
    expect((await socle('module', 'list', tenant)).out).toMatch(
      /shop_vip\s+0\.1\.0\s+not installed/,
    );

    // install: the dependency comes first
    const installed = await socle('module', 'install', tenant, 'shop_vip');
    expect(installed).toMatchObject({ code: 0, out: /Installed shop, shop_vip \(snapshot snap_/ });
    expect((await socle('module', 'install', tenant, 'shop')).out).toMatch(/Nothing to install/);
    const db = tenantDb(tenant);
    expect(await columns(db, 'shop_item')).toEqual(
      expect.arrayContaining(['name', 'notes', 'vip']),
    );
    expect(await columns(db, 'shop_vip_level')).toContain('name');
    await sql`insert into shop_item (id, name, notes, vip) values (gen_random_uuid(), 'Pen', 'blue', true)`.execute(
      db,
    );

    // upgrade: the hand-written migration renames the column, data kept
    expect((await socleV2('module', 'list', tenant)).out).toMatch(
      /shop\s+0\.2\.0\s+installed 0\.1\.0, 0\.2\.0 available/,
    );
    expect(await socleV2('module', 'upgrade', tenant)).toMatchObject({
      code: 0,
      out: /Upgraded shop 0\.1\.0 → 0\.2\.0/,
    });
    expect((await socleV2('module', 'upgrade', tenant)).out).toMatch(/up to date/);
    const pen = await sql<{ remarks: string }>`select remarks from shop_item`.execute(db);
    expect(pen.rows).toEqual([{ remarks: 'blue' }]);

    // backup, then listed by restore
    const backup = await socleV2('db', 'backup', tenant);
    const snapshot = /Snapshot (snap_\w+)/.exec(backup.out)?.[1] ?? '';
    expect(snapshot).not.toBe('');
    expect((await socleV2('db', 'restore', tenant)).out).toContain(snapshot);

    // uninstall: dependents too, confirmation required, data exported first
    const unconfirmed = await socleV2('module', 'uninstall', tenant, 'shop');
    expect(unconfirmed).toMatchObject({ code: 1, out: /uninstalls shop_vip, shop/ });
    expect(await columns(db, 'shop_item')).not.toEqual([]);
    const removed = await socleV2(
      'module',
      'uninstall',
      tenant,
      'shop',
      '--yes',
      '--export-dir',
      'out',
    );
    expect(removed).toMatchObject({ code: 0, out: /Uninstalled shop_vip, shop/ });
    expect(await columns(db, 'shop_item')).toEqual([]);
    const exports = (await readdir(join(cwd, 'out'))).sort();
    expect(exports).toHaveLength(2);
    const shopExport = JSON.parse(
      await readFile(join(cwd, 'out', exports.find((f) => f.includes('_shop_2')) ?? ''), 'utf8'),
    ) as { tables: Record<string, { remarks?: string }[]> };
    expect(shopExport.tables.shop_item?.[0]?.remarks).toBe('blue');

    // restore brings everything back
    expect(await socleV2('db', 'restore', tenant, snapshot)).toMatchObject({ code: 1 });
    expect(await socleV2('db', 'restore', tenant, 'snap_nope', '--yes')).toMatchObject({
      code: 1,
      err: /no snapshot/,
    });
    expect(await socleV2('db', 'restore', tenant, snapshot, '--yes')).toMatchObject({ code: 0 });
    const back = await sql<{ remarks: string }>`select remarks from shop_item`.execute(db);
    expect(back.rows).toEqual([{ remarks: 'blue' }]);

    // drop: confirmation required; the snapshots survive and can bring the tenant back
    expect(await socleV2('db', 'drop', tenant)).toMatchObject({ code: 1, out: /--yes/ });
    expect(await socleV2('db', 'drop', tenant, '--yes')).toMatchObject({ code: 0 });
    expect(await socleV2('module', 'list', tenant)).toMatchObject({
      code: 1,
      err: /has no database/,
    });
    expect(await socleV2('db', 'drop', tenant, '--yes')).toMatchObject({ code: 1 });
    expect(await socleV2('db', 'restore', tenant, snapshot, '--yes')).toMatchObject({ code: 0 });
    expect((await socleV2('module', 'list', tenant)).out).toMatch(
      /shop\s+0\.2\.0\s+installed 0\.2\.0/,
    );
  });

  it('never prints the database password, even on a connection error', async () => {
    const cwd = await tempDir();
    const url = new URL(pgUrl);
    url.password = 'Sup3r-Secret-Pw';
    const out: string[] = [];
    const code = await main(['db', 'create', newTenant()], {
      env: { SOCLE_DATABASE_URL: url.toString() },
      cwd,
      out: { line: (text) => out.push(text) },
      err: { line: (text) => out.push(text) },
    });
    expect(code).toBe(1);
    expect(out.join('\n')).not.toContain('Sup3r-Secret-Pw');
  });
});

describe('socle binary', () => {
  const run = promisify(execFile);
  const bin = join(import.meta.dirname, '..', 'bin', 'socle.mjs');

  it('runs the TypeScript sources and the modules natively on Node', async () => {
    const [modules, cwd] = [await tempDir(), await tempDir()];
    const env = { ...process.env, SOCLE_DATABASE_URL: pgUrl, SOCLE_MODULE_PATHS: modules };
    const socle = (...args: string[]) =>
      run(process.execPath, [bin, ...args], { env, cwd, timeout: 60_000 });

    expect((await socle('help')).stdout).toContain('Usage: socle');
    expect((await socle('scaffold', 'module', 'fleet', '--dir', modules)).stdout).toContain(
      'manifest.ts',
    );
    const tenant = newTenant();
    await socle('db', 'create', tenant);
    expect((await socle('module', 'install', tenant, 'fleet')).stdout).toMatch(/Installed fleet/);
    expect(await columns(tenantDb(tenant), 'fleet_item')).toEqual(
      expect.arrayContaining(['id', 'name', 'notes']),
    );
    await expect(socle('db', 'create', 'Bad_Name')).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/Invalid tenant/) as unknown,
    });
  });
});
