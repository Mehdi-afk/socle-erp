// SPDX-License-Identifier: LGPL-3.0-only
//
// Test helper (not exported): one fresh database per test, on the PostgreSQL server started
// once for the whole run (global-setup.ts).
import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, inject } from 'vitest';

import { createPgDatabase, type Executor } from './database.js';

export interface TestDatabases {
  /** Creates an empty database and returns a pool on it (closed at the end of the file). */
  create(): Promise<Executor>;
  /** Same, with the database name and a pool on the `postgres` maintenance database. */
  createNamed(): Promise<{ db: Executor; name: string; admin: Executor }>;
  /**
   * An empty database owned by a new role that is NOT a superuser (superusers bypass
   * row-level security), and a pool connected as that role.
   */
  createOwned(): Promise<Executor>;
}

export function useTestDatabases(): TestDatabases {
  const server = { url: inject('pgUrl') };
  const pools: Executor[] = [];

  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.destroy()));
  }, 60_000);

  const createNamed = async (): Promise<{ db: Executor; name: string; admin: Executor }> => {
    const name = `test_${randomUUID().replaceAll('-', '')}`;
    const admin = createPgDatabase({ connectionString: server.url, max: 2 });
    pools.push(admin);
    await sql`create database ${sql.id(name)}`.execute(admin);
    const url = new URL(server.url);
    url.pathname = `/${name}`;
    const db = createPgDatabase({ connectionString: url.toString(), max: 4 });
    pools.push(db);
    return { db, name, admin };
  };

  const createOwned = async (): Promise<Executor> => {
    const suffix = randomUUID().replaceAll('-', '');
    const [role, name, password] = [`app_${suffix}`, `test_${suffix}`, randomUUID()];
    const admin = createPgDatabase({ connectionString: server.url, max: 1 });
    pools.push(admin);
    await sql`create role ${sql.id(role)} login nosuperuser nobypassrls password ${sql.lit(password)}`.execute(
      admin,
    );
    await sql`create database ${sql.id(name)} owner ${sql.id(role)}`.execute(admin);
    const url = new URL(server.url);
    url.username = role;
    url.password = password;
    url.pathname = `/${name}`;
    const db = createPgDatabase({ connectionString: url.toString(), max: 4 });
    pools.push(db);
    return db;
  };

  return {
    createNamed,
    createOwned,
    async create(): Promise<Executor> {
      return (await createNamed()).db;
    },
  };
}
