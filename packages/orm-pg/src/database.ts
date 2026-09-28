// SPDX-License-Identifier: LGPL-3.0-only
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

/**
 * Tables are only known at run time (modules add models at installation), so queries are
 * built on this loose shape; identifiers still come from the registry only (see naming.ts).
 */
export type Tables = Record<string, Record<string, unknown>>;

/** A connection pool or an open transaction. */
export type Executor = Kysely<Tables>;

export interface PgDatabaseOptions {
  /** `postgres://user:password@host:port/database` — read from the environment, never logged. */
  readonly connectionString: string;
  /** Maximum connections of the pool (default 10). */
  readonly max?: number | undefined;
  readonly applicationName?: string | undefined;
}

const INT8 = 20;
const DATE = 1082;
const TIMESTAMPTZ = 1184;

function parseInt8(text: string): number {
  const value = Number(text);
  // Integers and money are safe integers on the ORM side: anything else is a corruption.
  if (!Number.isSafeInteger(value)) throw new RangeError(`bigint ${text} is not a safe integer`);
  return value;
}

function parseInstant(text: string): string {
  // The session time zone is UTC (see `options` below): PostgreSQL prints `… +00`.
  if (!text.endsWith('+00'))
    throw new RangeError(`Unexpected timestamptz ${text} (session not in UTC)`);
  return new Date(`${text.slice(0, -3).replace(' ', 'T')}Z`).toISOString();
}

/**
 * Values as the ORM represents them: bigint → number, date → `YYYY-MM-DD`, timestamptz →
 * ISO 8601 UTC string (the driver would otherwise build local-time `Date` objects).
 */
const types = {
  getTypeParser(oid: number, format?: 'text' | 'binary'): (value: string) => unknown {
    if (oid === INT8) return parseInt8;
    if (oid === DATE) return (text: string) => text;
    if (oid === TIMESTAMPTZ) return parseInstant;
    return pg.types.getTypeParser(oid, format ?? 'text') as (value: string) => unknown;
  },
};

/** Opens a connection pool to one tenant database. */
export function createPgDatabase(options: PgDatabaseOptions): Executor {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'socle',
    // Dates are stored and exchanged in UTC; date output in ISO format.
    options: '-c TimeZone=UTC -c DateStyle=ISO,YMD',
    types,
  });
  return new Kysely<Tables>({ dialect: new PostgresDialect({ pool }) });
}
