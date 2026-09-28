// SPDX-License-Identifier: LGPL-3.0-only
export { applySchema } from './apply.js';
export { DomainCompiler } from './compile.js';
export { createPgDatabase } from './database.js';
export type { Executor, PgDatabaseOptions, Tables } from './database.js';
export { SchemaError } from './errors.js';
export { columnName, identifier, MAX_IDENTIFIER_LENGTH } from './naming.js';
export { buildSchema, diffSchema, relationTable, SCHEMA_TABLE } from './schema.js';
export type {
  ColumnSchema,
  ColumnType,
  DatabaseSchema,
  ForeignKeySchema,
  IndexSchema,
  ReferentialAction,
  RelationTable,
  SchemaOperation,
  SchemaPlan,
  TableSchema,
} from './schema.js';
export { createPgStorage } from './storage.js';
