// SPDX-License-Identifier: LGPL-3.0-only
export { LocalDomainCompiler } from './compile.js';
export { createSqliteDatabase } from './driver.js';
export type {
  SqliteConnection,
  SqliteExecutor,
  SqliteStatement,
  SqliteValue,
  Tables,
} from './driver.js';
export { decodeValue, MATCH_FUNCTION, registerFunctions } from './functions.js';
export type { ValueKind } from './functions.js';
export {
  applyLocalSchema,
  buildLocalSchema,
  columnName,
  identifier,
  LOCAL_SCHEMA_TABLE,
  LocalSchemaError,
  relationTable,
  valueKind,
} from './schema.js';
export type { LocalColumn, LocalSchemaResult, LocalTable, SqliteType } from './schema.js';
export { createSqliteStorage } from './storage.js';
