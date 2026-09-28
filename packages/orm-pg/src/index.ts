// SPDX-License-Identifier: LGPL-3.0-only
export { applySchema } from './apply.js';
export { DomainCompiler } from './compile.js';
export { createPgDatabase } from './database.js';
export type { Executor, PgDatabaseOptions, Tables } from './database.js';
export { SchemaError } from './errors.js';
export { installedModules, LifecycleError, uninstallModules, upgradeModules } from './lifecycle.js';
export type {
  ModuleExport,
  ModuleTarget,
  UninstallOptions,
  UpgradeOptions,
  UpgradeResult,
} from './lifecycle.js';
export { migrationsBetween } from './migrations.js';
export type { MigrationContext, ModuleMigration } from './migrations.js';
export { columnName, identifier, MAX_IDENTIFIER_LENGTH } from './naming.js';
export { buildSchema, diffSchema, MODULE_TABLE, relationTable, SCHEMA_TABLE } from './schema.js';
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
export { createTemplateSnapshots } from './snapshot.js';
export type { SnapshotLabel, SnapshotRef, SnapshotStore } from './snapshot.js';
export { createPgStorage } from './storage.js';
