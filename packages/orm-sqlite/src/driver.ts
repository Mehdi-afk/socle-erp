// SPDX-License-Identifier: LGPL-3.0-only
//
// The SQLite engine behind the storage: the WASM build in the browser (SQLite3 Multiple
// Ciphers, ADR 007) or `node:sqlite` in tests and tools. Both expose synchronous prepared
// statements; this interface is what the storage needs from them.
import { Kysely, SqliteDialect, type SqliteDatabase } from 'kysely';

/** A value SQLite exchanges with JavaScript. */
export type SqliteValue = string | number | bigint | null | Uint8Array;

export interface SqliteStatement {
  /** True when the statement returns rows. */
  readonly reader: boolean;
  all(parameters: readonly SqliteValue[]): Record<string, SqliteValue>[];
  run(parameters: readonly SqliteValue[]): { changes: number | bigint };
}

export interface SqliteConnection {
  prepare(sql: string): SqliteStatement;
  /** Registers a deterministic SQL function implemented in JavaScript. */
  defineFunction(name: string, fn: (...args: SqliteValue[]) => SqliteValue): void;
  close(): void;
}

/** Tables are only known at run time (see orm-pg). */
export type Tables = Record<string, Record<string, unknown>>;

export type SqliteExecutor = Kysely<Tables>;

/** A Kysely instance over a SQLite connection. */
export function createSqliteDatabase(connection: SqliteConnection): SqliteExecutor {
  const database: SqliteDatabase = {
    close: () => {
      connection.close();
    },
    prepare: (sql) => {
      const statement = connection.prepare(sql);
      return {
        reader: statement.reader,
        all: (parameters) => statement.all(parameters as SqliteValue[]),
        run: (parameters) => ({
          ...statement.run(parameters as SqliteValue[]),
          lastInsertRowid: 0,
        }),
        iterate: (parameters) => statement.all(parameters as SqliteValue[])[Symbol.iterator](),
      };
    },
  };
  return new Kysely<Tables>({ dialect: new SqliteDialect({ database }) });
}
