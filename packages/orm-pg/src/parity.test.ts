// SPDX-License-Identifier: LGPL-3.0-only
//
// Parity of the PostgreSQL storage with the in-memory reference storage (properties shared by
// every adapter, in @socle/testing).
import type { Storage } from '@socle/framework';
import { parity } from '@socle/testing';
import fc from 'fast-check';
import { describe, it } from 'vitest';

import { applySchema } from './apply.js';
import type { Executor } from './database.js';
import { createPgStorage } from './storage.js';
import { useTestDatabases } from './test-support.js';

class Rollback extends Error {}

/** A PostgreSQL storage inside a transaction that is always rolled back. */
const inRollback =
  (db: Executor) =>
  async (work: (storage: Storage) => Promise<void>): Promise<void> => {
    try {
      await db.transaction().execute(async (trx) => {
        await work(createPgStorage(trx, parity.registry));
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  };

const databases = useTestDatabases();

/** More cases on demand: `PARITY_RUNS=2000 pnpm test`. */
const RUNS = Number(process.env.PARITY_RUNS ?? '60');

describe('PostgreSQL storage parity with the reference storage', () => {
  it('finds the same records, in the same order, for random domains', async () => {
    const db = await databases.create();
    await applySchema(db, parity.registry);
    await fc.assert(parity.queryParity(inRollback(db)), { numRuns: RUNS });
  }, 300_000);

  it('reads back exactly what was written, through updates and deletions', async () => {
    const db = await databases.create();
    await applySchema(db, parity.registry);
    await fc.assert(parity.writeParity(inRollback(db)), { numRuns: Math.ceil(RUNS / 2) });
  }, 300_000);
});
