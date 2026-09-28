// SPDX-License-Identifier: LGPL-3.0-only
export { applySchema } from './apply.js';
export type { ApplySchemaOptions } from './apply.js';
export { DomainCompiler, NotMirrorable, SessionValue } from './compile.js';
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
export {
  buildSchema,
  diffSchema,
  FIELD_VERSIONS_COLUMN,
  MODULE_TABLE,
  relationTable,
  SCHEMA_TABLE,
  SYNC_TABLES,
  AUTH_TABLES,
} from './schema.js';
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
export { applyRowSecurity, buildRowSecurity } from './rls.js';
export type { RowPolicy, RowSecurityPlan } from './rls.js';
export { createPgSession, SYSTEM_ACTOR } from './session.js';
export type { PgSession } from './session.js';
export { createPgStorage } from './storage.js';
export { createPgSyncBackend, deviceStatus, registerDevice, revokeDevice } from './sync-backend.js';
