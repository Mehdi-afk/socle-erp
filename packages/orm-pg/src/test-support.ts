// SPDX-License-Identifier: LGPL-3.0-only
//
// Test helper (not exported): one throw-away PostgreSQL server per test file, one fresh
// database per test.
import { randomUUID } from 'node:crypto';

import { startPostgres, type EphemeralPostgres } from '@socle/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll } from 'vitest';

import { createPgDatabase, type Executor } from './database.js';

export interface TestDatabases {
  /** Creates an empty database and returns a pool on it (closed at the end of the file). */
  create(): Promise<Executor>;
  /** Same, with the database name and a pool on the `postgres` maintenance database. */
  createNamed(): Promise<{ db: Executor; name: string; admin: Executor }>;
}

export function useTestDatabases(): TestDatabases {
  let server: EphemeralPostgres | undefined;
  const pools: Executor[] = [];

  beforeAll(async () => {
    server = await startPostgres();
  }, 180_000);

  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.destroy()));
    await server?.stop();
  }, 60_000);

  const createNamed = async (): Promise<{ db: Executor; name: string; admin: Executor }> => {
    if (!server) throw new Error('PostgreSQL is not started');
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

  return {
    createNamed,
    async create(): Promise<Executor> {
      return (await createNamed()).db;
    },
  };
}
