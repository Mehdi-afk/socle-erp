// SPDX-License-Identifier: LGPL-3.0-only
//
// `node:sqlite` as a SQLite connection (tests, tools). Separate entry point
// (`@socle/orm-sqlite/node`): the browser bundle never loads it.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type { SqliteConnection, SqliteValue } from './driver.js';

/** Opens a `node:sqlite` database (`:memory:` by default). */
export function openNodeSqlite(path = ':memory:'): SqliteConnection {
  const db = new DatabaseSync(path);
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        reader: statement.columns().length > 0,
        all: (parameters) => statement.all(...(parameters as SQLInputValue[])),
        run: (parameters) => {
          const { changes } = statement.run(...(parameters as SQLInputValue[]));
          return { changes };
        },
      };
    },
    defineFunction(name, fn) {
      db.function(name, { deterministic: true, varargs: true }, (...args) =>
        fn(...(args as SqliteValue[])),
      );
    },
    close() {
      db.close();
    },
  };
}
