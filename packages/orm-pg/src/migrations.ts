// SPDX-License-Identifier: LGPL-3.0-only
//
// Hand-written migrations (ARCHITECTURE.md §4.7): renames, type changes and removals are
// never automatic. A module ships, per version, a `pre` step (run before the automatic schema
// changes, on the old schema) and/or a `post` step (after them, on the new schema).
//
// The helpers below run the DDL AND update the recorded schema, so that the automatic diff
// that follows starts from what the database really contains.
import { sql, type RawBuilder, type Transaction } from 'kysely';
import semver from 'semver';

import type { Tables } from './database.js';
import { SchemaError } from './errors.js';
import { columnName, identifier } from './naming.js';
import type { ColumnSchema, ColumnType, DatabaseSchema, TableSchema } from './schema.js';

/** What a migration step receives. */
export interface MigrationContext {
  /** The transaction of the whole upgrade: data moves go through Kysely's `sql` template. */
  readonly db: Transaction<Tables>;
  readonly module: string;
  /** Installed version before the upgrade. */
  readonly from: string;
  /** Version being installed. */
  readonly to: string;
  /** Renames the column of a field (`partnerRef` → `partnerCode`). */
  renameColumn(model: string, from: string, to: string): Promise<void>;
  /**
   * Changes the type of a field's column; `using` converts existing values (default: a plain
   * cast of the column).
   */
  changeColumnType(
    model: string,
    field: string,
    type: ColumnType,
    using?: RawBuilder<unknown>,
  ): Promise<void>;
  /** Adds or removes NOT NULL (values must already comply). */
  setNotNull(model: string, field: string, notNull: boolean): Promise<void>;
  /** Drops a field's column (or, for a many2many, its relation table) and its data. */
  dropColumn(model: string, field: string): Promise<void>;
  /** Renames a model's table (and the relation tables of its many2many fields). */
  renameTable(from: string, to: string): Promise<void>;
  /** Drops a model's table (and its relation tables) with its data. */
  dropTable(model: string): Promise<void>;
}

/** The migration steps of one version of a module (`migrations/<version>/pre.ts`, `post.ts`). */
export interface ModuleMigration {
  readonly version: string;
  readonly pre?: ((context: MigrationContext) => Promise<void>) | undefined;
  readonly post?: ((context: MigrationContext) => Promise<void>) | undefined;
}

/**
 * The migrations to run for an upgrade `from` → `to`: versions `v` with `from < v ≤ to`,
 * oldest first. None on a first installation (Odoo does the same).
 * @throws {@link SchemaError} on an invalid version or a downgrade
 */
export function migrationsBetween(
  migrations: readonly ModuleMigration[],
  from: string | null,
  to: string,
): ModuleMigration[] {
  if (semver.valid(to) !== to) throw new SchemaError(`Invalid version "${to}".`);
  if (from === null) return [];
  if (semver.valid(from) !== from) throw new SchemaError(`Invalid installed version "${from}".`);
  if (semver.lt(to, from))
    throw new SchemaError(`Downgrade from ${from} to ${to} is not supported.`);
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (semver.valid(migration.version) !== migration.version) {
      throw new SchemaError(`Invalid migration version "${migration.version}".`);
    }
    if (seen.has(migration.version)) {
      throw new SchemaError(`Two migrations for version ${migration.version}.`);
    }
    seen.add(migration.version);
  }
  return migrations
    .filter((m) => semver.gt(m.version, from) && semver.lte(m.version, to))
    .sort((a, b) => semver.compare(a.version, b.version));
}

const TYPE_SQL: Readonly<Record<ColumnType, RawBuilder<unknown>>> = {
  uuid: sql`uuid`,
  text: sql`text`,
  bigint: sql`bigint`,
  integer: sql`integer`,
  numeric: sql`numeric`,
  boolean: sql`boolean`,
  date: sql`date`,
  timestamptz: sql`timestamptz`,
  jsonb: sql`jsonb`,
};

/** Table of a model, derived from its name as the registry does (the model may be gone). */
const tableOf = (model: string): string => identifier(model.replaceAll('.', '_'));

/**
 * The migration helpers over a working copy of the recorded schema. `schema()` returns the
 * copy as modified by the steps run so far.
 */
export function migrationHelpers(
  db: Transaction<Tables>,
  recorded: DatabaseSchema | null,
): {
  context(module: string, from: string, to: string): MigrationContext;
  schema(): DatabaseSchema | null;
} {
  let tables = recorded ? recorded.tables.map((table) => ({ ...table })) : null;

  const find = (name: string): TableSchema => {
    const table = tables?.find((candidate) => candidate.name === name);
    if (!table) throw new SchemaError(`Table "${name}" is not in the recorded schema.`);
    return table;
  };
  const replace = (name: string, next: TableSchema | null): void => {
    if (!tables) return;
    tables = tables
      .flatMap((table) => (table.name === name ? (next ? [next] : []) : [table]))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  };
  const column = (table: TableSchema, name: string): ColumnSchema => {
    const found = table.columns.find((candidate) => candidate.name === name);
    if (!found)
      throw new SchemaError(`Column "${table.name}.${name}" is not in the recorded schema.`);
    return found;
  };
  const withColumn = (
    table: TableSchema,
    name: string,
    next: ColumnSchema | null,
  ): TableSchema => ({
    ...table,
    columns: table.columns.flatMap((c) => (c.name === name ? (next ? [next] : []) : [c])),
    // Constraints and indexes on a dropped column go with it.
    foreignKeys: next ? table.foreignKeys : table.foreignKeys.filter((fk) => fk.column !== name),
    uniques: next ? table.uniques : table.uniques.filter((u) => !u.columns.includes(name)),
    indexes: next ? table.indexes : table.indexes.filter((i) => !i.columns.includes(name)),
  });
  /** Relation tables owned by the many2many fields of a model. */
  const relationsOf = (model: string): TableSchema[] =>
    (tables ?? []).filter((table) => table.owner.startsWith(`${model}.`));

  return {
    schema: () => (tables ? { tables } : null),
    context: (module, from, to) => ({
      db,
      module,
      from,
      to,
      async renameColumn(model, fromField, toField) {
        const table = find(tableOf(model));
        const [oldName, newName] = [columnName(fromField), columnName(toField)];
        const old = column(table, oldName);
        await sql`alter table ${sql.table(table.name)} rename column ${sql.id(oldName)} to ${sql.id(newName)}`.execute(
          db,
        );
        const renamed: TableSchema = {
          ...table,
          columns: table.columns.map((c) => (c === old ? { ...c, name: newName } : c)),
          foreignKeys: table.foreignKeys.map((fk) =>
            fk.column === oldName ? { ...fk, column: newName } : fk,
          ),
          uniques: table.uniques.map((u) => ({
            ...u,
            columns: u.columns.map((c) => (c === oldName ? newName : c)),
          })),
          indexes: table.indexes.map((i) => ({
            ...i,
            columns: i.columns.map((c) => (c === oldName ? newName : c)),
          })),
        };
        replace(table.name, renamed);
      },
      async changeColumnType(model, field, type, using) {
        const table = find(tableOf(model));
        const name = columnName(field);
        const old = column(table, name);
        await sql`alter table ${sql.table(table.name)} alter column ${sql.id(name)} type ${TYPE_SQL[type]} using ${using ?? sql`${sql.id(name)}::${TYPE_SQL[type]}`}`.execute(
          db,
        );
        replace(table.name, withColumn(table, name, { ...old, type }));
      },
      async setNotNull(model, field, notNull) {
        const table = find(tableOf(model));
        const name = columnName(field);
        const old = column(table, name);
        await (
          notNull
            ? sql`alter table ${sql.table(table.name)} alter column ${sql.id(name)} set not null`
            : sql`alter table ${sql.table(table.name)} alter column ${sql.id(name)} drop not null`
        ).execute(db);
        replace(table.name, withColumn(table, name, { ...old, notNull }));
      },
      async dropColumn(model, field) {
        const table = find(tableOf(model));
        const name = columnName(field);
        // A many2many field has no column: its relation table goes instead.
        const relation = (tables ?? []).find((t) => t.owner === `${model}.${field}`);
        if (relation && !table.columns.some((c) => c.name === name)) {
          await sql`drop table ${sql.table(relation.name)}`.execute(db);
          replace(relation.name, null);
          return;
        }
        column(table, name);
        await sql`alter table ${sql.table(table.name)} drop column ${sql.id(name)}`.execute(db);
        replace(table.name, withColumn(table, name, null));
      },
      async renameTable(fromModel, toModel) {
        const [oldName, newName] = [tableOf(fromModel), tableOf(toModel)];
        const table = find(oldName);
        await sql`alter table ${sql.table(oldName)} rename to ${sql.id(newName)}`.execute(db);
        await sql`alter table ${sql.table(newName)} rename constraint ${sql.id(`${oldName}_pkey`)} to ${sql.id(identifier(`${newName}_pkey`))}`.execute(
          db,
        );
        replace(oldName, { ...table, name: newName, owner: toModel });
        // Default relation tables are named after the model's table: rename them too.
        for (const rel of relationsOf(fromModel)) {
          const field = rel.owner.slice(fromModel.length + 1);
          const renamed = rel.name.startsWith(`${oldName}_`)
            ? identifier(`${newName}_${rel.name.slice(oldName.length + 1)}`)
            : rel.name;
          if (renamed !== rel.name) {
            await sql`alter table ${sql.table(rel.name)} rename to ${sql.id(renamed)}`.execute(db);
            await sql`alter table ${sql.table(renamed)} rename constraint ${sql.id(`${rel.name}_pkey`)} to ${sql.id(identifier(`${renamed}_pkey`))}`.execute(
              db,
            );
          }
          replace(rel.name, { ...rel, name: renamed, owner: `${toModel}.${field}` });
        }
        // References from other tables follow the renamed table.
        tables = (tables ?? []).map((other) => ({
          ...other,
          foreignKeys: other.foreignKeys.map((fk) =>
            fk.references === oldName ? { ...fk, references: newName } : fk,
          ),
        }));
      },
      async dropTable(model) {
        const name = tableOf(model);
        find(name);
        const relations = relationsOf(model);
        const dropped = new Set([name, ...relations.map((rel) => rel.name)]);
        // Refuse silently cutting references from tables that stay: they must be migrated first.
        const referencing = (tables ?? []).filter(
          (other) =>
            !dropped.has(other.name) && other.foreignKeys.some((fk) => fk.references === name),
        );
        if (referencing.length > 0) {
          throw new SchemaError(
            `Cannot drop "${name}": still referenced by ${referencing.map((t) => t.name).join(', ')}.`,
          );
        }
        for (const rel of relations) {
          await sql`drop table ${sql.table(rel.name)}`.execute(db);
          replace(rel.name, null);
        }
        await sql`drop table ${sql.table(name)}`.execute(db);
        replace(name, null);
      },
    }),
  };
}
