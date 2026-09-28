// SPDX-License-Identifier: LGPL-3.0-only
//
// Test helper (not exported): a fresh in-memory SQLite database with the reference functions
// and the local schema of a registry.
import type { ModelRegistry } from '@socle/framework';

import { createSqliteDatabase, type SqliteExecutor } from './driver.js';
import { registerFunctions } from './functions.js';
import { openNodeSqlite } from './node.js';
import { applyLocalSchema } from './schema.js';

export async function localDatabase(registry: ModelRegistry): Promise<SqliteExecutor> {
  const connection = openNodeSqlite();
  registerFunctions(connection);
  const db = createSqliteDatabase(connection);
  await applyLocalSchema(db, registry);
  return db;
}
