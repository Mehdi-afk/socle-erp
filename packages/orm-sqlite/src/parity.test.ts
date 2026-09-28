// SPDX-License-Identifier: LGPL-3.0-only
//
// Parity of the SQLite storage (offline client) with the in-memory reference storage
// (properties shared by every adapter, in @socle/testing).
import type { Storage } from '@socle/framework';
import { parity } from '@socle/testing';
import fc from 'fast-check';
import { describe, it } from 'vitest';

import { createSqliteStorage } from './storage.js';
import { localDatabase } from './test-support.js';

const withStorage = async (work: (storage: Storage) => Promise<void>): Promise<void> => {
  const db = await localDatabase(parity.registry);
  try {
    await work(createSqliteStorage(db, parity.registry));
  } finally {
    await db.destroy();
  }
};

/** More cases on demand: `PARITY_RUNS=2000 pnpm test`. */
const RUNS = Number(process.env.PARITY_RUNS ?? '100');

describe('SQLite storage parity with the reference storage', () => {
  it('finds the same records, in the same order, for random domains', async () => {
    await fc.assert(parity.queryParity(withStorage), { numRuns: RUNS });
  }, 300_000);

  it('reads back exactly what was written, through updates and deletions', async () => {
    await fc.assert(parity.writeParity(withStorage), { numRuns: Math.ceil(RUNS / 2) });
  }, 300_000);
});
