// SPDX-License-Identifier: LGPL-3.0-only
//
// The acting user of a transaction, shared by everything that queries the database in it (the
// ORM storage, the synchronisation backend). Row-level security reads these settings; keeping
// the current actor in ONE place guarantees that a query never runs with the settings another
// component left behind (e.g. a user query running as superuser).
import { AccessError, type StorageActor } from '@socle/framework';
import { sql } from 'kysely';

import type { Executor } from './database.js';
import { SchemaError } from './errors.js';

export interface PgSession {
  readonly executor: Executor;
  /** Writes the settings of `actor` (SET LOCAL) unless they are already current. */
  actAs(actor: StorageActor): Promise<void>;
}

/** The actor of maintenance work (synchronisation bookkeeping, integrity checks). */
export const SYSTEM_ACTOR: StorageActor = Object.freeze({
  userId: 'system',
  su: true,
  companyId: null,
  companyIds: [],
  groupIds: [],
});

/** One session per transaction. */
export function createPgSession(executor: Executor): PgSession {
  let current: string | undefined;
  return {
    executor,
    async actAs(actor) {
      const key = JSON.stringify(actor);
      if (key === current) return;
      if (!executor.isTransaction) {
        throw new SchemaError(
          'The ORM must run in a transaction on PostgreSQL (row-level security).',
        );
      }
      const ids = [actor.userId, actor.companyId ?? '', ...actor.companyIds, ...actor.groupIds];
      if (ids.some((id) => id.includes(',')))
        throw new AccessError('Invalid identifier in the user context.');
      await sql`select set_config('app.su', ${actor.su ? 'on' : 'off'}, true), set_config('app.user_id', ${actor.userId}, true), set_config('app.company_id', ${actor.companyId ?? ''}, true), set_config('app.company_ids', ${actor.companyIds.join(',')}, true), set_config('app.group_ids', ${actor.groupIds.join(',')}, true)`.execute(
        executor,
      );
      current = key;
    },
  };
}
