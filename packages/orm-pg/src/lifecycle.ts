// SPDX-License-Identifier: LGPL-3.0-only
//
// Installation, upgrade and uninstallation of modules on a tenant database (ARCHITECTURE.md
// §4.4, §4.7): a snapshot first, then everything in ONE transaction — hand-written
// migrations, automatic schema changes, module versions. On failure the transaction is
// rolled back and the error carries the snapshot to restore if needed.
import {
  buildSecurityPolicy,
  createAccessControl,
  createEnvironment,
  isStoredColumn,
  SocleError,
  type AuditSink,
  type Environment,
  type ModelRegistry,
  type ModuleData,
  type ModuleModels,
  type SecurityPolicy,
} from '@socle/framework';
import { sql, type Transaction } from 'kysely';

import { applySchemaIn, prepareSchemaTransaction, recordedSchema } from './apply.js';
import { appendAudit } from './audit.js';
import { loadModuleData, unloadModuleData, type DataLoadResult } from './data.js';
import type { Executor, Tables } from './database.js';
import { SchemaError } from './errors.js';
import { migrationHelpers, migrationsBetween, type ModuleMigration } from './migrations.js';
import { columnName, identifier } from './naming.js';
import { MODULE_TABLE, type SchemaPlan } from './schema.js';
import type { SnapshotLabel, SnapshotRef, SnapshotStore } from './snapshot.js';
import { createPgStorage } from './storage.js';

/**
 * A module operation failed; the database is unchanged (rolled back) and `snapshot` is the
 * copy taken just before, to restore if anything outside the transaction went wrong.
 */
export class LifecycleError extends SocleError {
  readonly snapshot: SnapshotRef;

  constructor(message: string, snapshot: SnapshotRef, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      'orm_pg.lifecycle',
      `${message}: ${reason}\n(snapshot taken before the operation: ${snapshot.name})`,
      { cause },
    );
    this.snapshot = snapshot;
  }
}

/** A module to install (not installed yet) or upgrade, at `version`. */
export interface ModuleTarget {
  readonly name: string;
  readonly version: string;
  /** Its `migrations/<version>/` steps (only run on upgrades). */
  readonly migrations?: readonly ModuleMigration[] | undefined;
  /** Its `data/` records, loaded (or updated) after the schema changes. */
  readonly data?: readonly ModuleData[] | undefined;
}

/**
 * A superuser ORM environment of the lifecycle transaction, to load or remove module data.
 * Every sudo is recorded in `audit` (default: nowhere).
 */
function systemEnvironment(
  trx: Transaction<Tables>,
  registry: ModelRegistry,
  security: SecurityPolicy | undefined,
  audit: AuditSink | undefined,
  reason: string,
): Environment {
  return createEnvironment({
    registry,
    storage: createPgStorage(trx, registry),
    user: { id: 'system', groupIds: [], companyIds: [], companyId: null, lang: 'fr', tz: 'UTC' },
    access: createAccessControl(security ?? buildSecurityPolicy([], () => false), registry),
    audit: audit ?? { record: () => undefined },
  }).sudo(reason);
}

export interface UpgradeOptions {
  readonly db: Executor;
  /** The registry of every module once the operation is done. */
  readonly registry: ModelRegistry;
  /** Modules to install or upgrade, in dependency order. */
  readonly modules: readonly ModuleTarget[];
  /** Where the mandatory snapshot is taken. */
  readonly snapshots: SnapshotStore;
  /** Security policy once the operation is done: row-level security is rebuilt from it. */
  readonly security?: SecurityPolicy | undefined;
  /** Where the superuser work of the data loading is recorded. */
  readonly audit?: AuditSink | undefined;
  /** Who runs the operation, for the audit journal (e.g. `cli`, a user id). */
  readonly actor?: string | undefined;
}

export interface UpgradeResult {
  readonly snapshot: SnapshotRef;
  readonly plan: SchemaPlan;
  readonly installed: readonly string[];
  readonly upgraded: readonly {
    readonly name: string;
    readonly from: string;
    readonly to: string;
  }[];
  /** Module data loaded, per module. */
  readonly data: Readonly<Record<string, DataLoadResult>>;
}

async function ensureModuleTable(trx: Transaction<Tables>): Promise<void> {
  await sql`create table if not exists ${sql.table(MODULE_TABLE)} (name text primary key, version text not null, installed_at timestamptz not null default now(), updated_at timestamptz not null default now())`.execute(
    trx,
  );
}

async function versionsIn(trx: Transaction<Tables>): Promise<Map<string, string>> {
  const result = await sql<{
    name: string;
    version: string;
  }>`select name, version from ${sql.table(MODULE_TABLE)} for update`.execute(trx);
  return new Map(result.rows.map((row) => [row.name, row.version]));
}

/**
 * Installed modules and their versions. An empty map only for a database where no module was
 * ever installed; any read error propagates (it is never taken for "nothing installed").
 */
export async function installedModules(db: Executor): Promise<ReadonlyMap<string, string>> {
  const exists = await sql<{
    found: string | null;
  }>`select to_regclass(${MODULE_TABLE})::text as found`.execute(db);
  if (exists.rows[0]?.found == null) return new Map();
  const result = await sql<{
    name: string;
    version: string;
  }>`select name, version from ${sql.table(MODULE_TABLE)} order by name`.execute(db);
  return new Map(result.rows.map((row) => [row.name, row.version]));
}

/**
 * Installs or upgrades modules: snapshot, then in one transaction the `pre` migrations, the
 * automatic schema changes, the `post` migrations and the new versions.
 * @throws {@link LifecycleError}
 */
export async function upgradeModules(options: UpgradeOptions): Promise<UpgradeResult> {
  for (const target of options.modules) identifier(target.name);
  const before = await installedModules(options.db);
  const label: SnapshotLabel = options.modules.some((m) => before.has(m.name))
    ? 'avant_mise_a_jour'
    : 'avant_installation';
  const snapshot = await options.snapshots.create(label);

  try {
    return await options.db.transaction().execute(async (trx) => {
      await prepareSchemaTransaction(trx);
      await ensureModuleTable(trx);
      const versions = await versionsIn(trx);
      const helpers = migrationHelpers(trx, await recordedSchema(trx));
      const steps = options.modules.map((target) => {
        const from = versions.get(target.name) ?? null;
        return {
          target,
          from,
          migrations: migrationsBetween(target.migrations ?? [], from, target.version),
        };
      });

      for (const { target, from, migrations } of steps) {
        for (const migration of migrations) {
          await migration.pre?.(helpers.context(target.name, from ?? '', target.version));
        }
      }
      const plan = await applySchemaIn(trx, options.registry, helpers.schema(), {
        security: options.security,
      });
      for (const { target, from, migrations } of steps) {
        for (const migration of migrations) {
          await migration.post?.(helpers.context(target.name, from ?? '', target.version));
        }
      }
      const data: Record<string, DataLoadResult> = {};
      if (steps.some(({ target }) => (target.data ?? []).length > 0)) {
        const env = systemEnvironment(
          trx,
          options.registry,
          options.security,
          options.audit,
          'module data loading',
        );
        for (const { target } of steps) {
          if ((target.data ?? []).length === 0) continue;
          data[target.name] = await loadModuleData(trx, env, target.name, target.data ?? []);
        }
      }
      for (const { target } of steps) {
        await sql`insert into ${sql.table(MODULE_TABLE)} (name, version) values (${target.name}, ${target.version}) on conflict (name) do update set version = excluded.version, updated_at = now()`.execute(
          trx,
        );
      }
      const installed = steps.filter((s) => s.from === null).map((s) => s.target.name);
      const upgraded = steps.flatMap((s) =>
        s.from === null ? [] : [{ name: s.target.name, from: s.from, to: s.target.version }],
      );
      await appendAudit(trx, [
        {
          at: new Date().toISOString(),
          userId: options.actor ?? null,
          kind: installed.length > 0 ? 'module.install' : 'module.upgrade',
          model: null,
          recordIds: [],
          details: { installed, upgraded, snapshot: snapshot.name },
        },
      ]);
      return {
        snapshot,
        plan,
        installed: steps.filter((s) => s.from === null).map((s) => s.target.name),
        upgraded: steps.flatMap((s) =>
          s.from === null ? [] : [{ name: s.target.name, from: s.from, to: s.target.version }],
        ),
        data,
      };
    });
  } catch (error) {
    throw new LifecycleError(
      'Module installation or upgrade failed and was rolled back',
      snapshot,
      error,
    );
  }
}

/** The data of an uninstalled module, handed to `exportData` before it is deleted. */
export interface ModuleExport {
  readonly module: string;
  readonly version: string;
  readonly exportedAt: string;
  /** Every row of the tables the module created (its models and their relation tables). */
  readonly tables: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  /** Columns the module added to other modules' tables: table → column → rows `{ id, value }`. */
  readonly columns: Readonly<
    Record<string, Readonly<Record<string, readonly { id: string; value: unknown }[]>>>
  >;
}

export interface UninstallOptions {
  readonly db: Executor;
  /** The registry of the modules that remain installed. */
  readonly registry: ModelRegistry;
  /** Models of the modules to remove, dependents first (reverse dependency order). */
  readonly modules: readonly ModuleModels[];
  readonly snapshots: SnapshotStore;
  /** Security policy of the remaining modules: row-level security is rebuilt from it. */
  readonly security?: SecurityPolicy | undefined;
  /** Stores the backup export; called inside the transaction, before any deletion. */
  exportData(data: ModuleExport): Promise<void>;
  /** Where the superuser work of the data removal is recorded. */
  readonly audit?: AuditSink | undefined;
  /** Who runs the operation, for the audit journal. */
  readonly actor?: string | undefined;
}

/** What a module owns in the database: whole models, and fields added to other models. */
function ownership(module: ModuleModels): { models: string[]; fields: [string, string][] } {
  const models: string[] = [];
  const fields: [string, string][] = [];
  for (const model of module.models) {
    if (model.kind === 'define') {
      if (!model.abstract) models.push(model.name);
      continue;
    }
    for (const [field, definition] of Object.entries(model.fields ?? {})) {
      if (definition.type === 'many2many' || isStoredColumn(definition))
        fields.push([model.name, field]);
    }
  }
  return { models, fields };
}

/**
 * Uninstalls modules: snapshot, then in one transaction the export of their data, the removal
 * of their tables and columns and of their version rows.
 * @throws {@link LifecycleError}
 */
export async function uninstallModules(options: UninstallOptions): Promise<SnapshotRef> {
  const snapshot = await options.snapshots.create('avant_desinstallation');
  try {
    await options.db.transaction().execute(async (trx) => {
      await prepareSchemaTransaction(trx);
      await ensureModuleTable(trx);
      const versions = await versionsIn(trx);
      const helpers = migrationHelpers(trx, await recordedSchema(trx));

      for (const module of options.modules) {
        const version = versions.get(module.module);
        if (version === undefined)
          throw new SchemaError(`Module "${module.module}" is not installed.`);
        const { models, fields } = ownership(module);
        const recorded = helpers.schema()?.tables ?? [];
        const owned = recorded.filter(
          (table) =>
            models.includes(table.owner) ||
            models.some((m) => table.owner.startsWith(`${m}.`)) ||
            fields.some(([m, f]) => table.owner === `${m}.${f}`),
        );

        const tables: Record<string, Record<string, unknown>[]> = {};
        for (const table of owned) {
          const rows = await sql<
            Record<string, unknown>
          >`select * from ${sql.table(table.name)}`.execute(trx);
          tables[table.name] = rows.rows;
        }
        const columns: Record<string, Record<string, { id: string; value: unknown }[]>> = {};
        for (const [model, field] of fields) {
          const table = identifier(model.replaceAll('.', '_'));
          if (
            models.includes(model) ||
            !recorded.some(
              (t) => t.name === table && t.columns.some((c) => c.name === columnName(field)),
            )
          )
            continue;
          const rows = await sql<{
            id: string;
            value: unknown;
          }>`select id, ${sql.id(columnName(field))} as value from ${sql.table(table)}`.execute(
            trx,
          );
          (columns[table] ??= {})[columnName(field)] = rows.rows;
        }
        await options.exportData({
          module: module.module,
          version,
          exportedAt: new Date().toISOString(),
          tables,
          columns,
        });

        // Records the module loaded into models that stay installed go away with it.
        await unloadModuleData(
          trx,
          systemEnvironment(
            trx,
            options.registry,
            options.security,
            options.audit,
            `uninstallation of ${module.module}`,
          ),
          module.module,
        );
        const context = helpers.context(module.module, version, version);
        for (const [model, field] of fields) {
          if (!models.includes(model)) await context.dropColumn(model, field);
        }
        for (const model of models) await context.dropTable(model);
        await sql`delete from ${sql.table(MODULE_TABLE)} where name = ${module.module}`.execute(
          trx,
        );
      }
      await applySchemaIn(trx, options.registry, helpers.schema(), {
        security: options.security,
      });
      await appendAudit(trx, [
        {
          at: new Date().toISOString(),
          userId: options.actor ?? null,
          kind: 'module.uninstall',
          model: null,
          recordIds: [],
          details: { modules: options.modules.map((m) => m.module), snapshot: snapshot.name },
        },
      ]);
    });
  } catch (error) {
    throw new LifecycleError('Module uninstallation failed and was rolled back', snapshot, error);
  }
  return snapshot;
}
