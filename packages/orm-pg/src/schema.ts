// SPDX-License-Identifier: LGPL-3.0-only
//
// PostgreSQL schema derived from the model registry, and the additive difference between the
// recorded schema and the desired one (ARCHITECTURE.md §4.7). Pure functions: no database.
import {
  isStoredColumn,
  type FieldDefinition,
  type ModelMeta,
  type ModelRegistry,
} from '@socle/framework';

import { SchemaError } from './errors.js';
import { columnName, identifier } from './naming.js';

/** Table holding the recorded schema (see apply.ts): reserved, no model may use it. */
export const SCHEMA_TABLE = 'socle_schema';

/** Table of installed modules and their versions (ARCHITECTURE.md §4.4, §4.7): reserved. */
export const MODULE_TABLE = 'ir_module';

/**
 * Synchronisation bookkeeping (ARCHITECTURE.md §6): version sequence, tombstones, registered
 * devices, processed mutations and archived losing versions. Reserved names.
 */
export const SYNC_TABLES = {
  sequence: 'socle_version',
  tombstone: 'socle_tombstone',
  device: 'socle_device',
  mutation: 'socle_mutation',
  archive: 'socle_archive',
} as const;

/**
 * Authentication bookkeeping of the server (ARCHITECTURE.md §9.3): users and their sessions.
 * Reserved names. (Business data about people lives in modules, e.g. `res.partner`.)
 */
export const AUTH_TABLES = {
  user: 'socle_user',
  session: 'socle_session',
} as const;

/**
 * External ids of the records loaded from module data (`module.name` → record), so that an
 * upgrade updates them instead of creating them again. Reserved name.
 */
export const EXTERNAL_ID_TABLE = 'socle_external_id';

/**
 * Per-field versions of a record (JSON object field → version), the base of conflict
 * detection. A technical column of every model table, managed by the storage.
 */
export const FIELD_VERSIONS_COLUMN = 'field_versions';

/** PostgreSQL types used by the ORM. */
export type ColumnType =
  'uuid' | 'text' | 'bigint' | 'integer' | 'numeric' | 'boolean' | 'date' | 'timestamptz' | 'jsonb';

export interface ColumnSchema {
  readonly name: string;
  readonly type: ColumnType;
  readonly notNull: boolean;
  /** Default for existing rows when the column is added (the field's empty value). */
  readonly default?: false | 0 | 'empty-object' | undefined;
  /** Kept in the database although no installed model uses it any more (never dropped automatically). */
  readonly orphan?: true | undefined;
}

export type ReferentialAction = 'cascade' | 'set null' | 'no action';

export interface ForeignKeySchema {
  readonly name: string;
  readonly column: string;
  readonly references: string;
  readonly onDelete: ReferentialAction;
}

export interface IndexSchema {
  readonly name: string;
  readonly columns: readonly string[];
}

export interface TableSchema {
  readonly name: string;
  /** The model stored in the table, or the many2many field `model.field` of a relation table. */
  readonly owner: string;
  readonly columns: readonly ColumnSchema[];
  readonly primaryKey: readonly string[];
  readonly foreignKeys: readonly ForeignKeySchema[];
  readonly uniques: readonly IndexSchema[];
  readonly indexes: readonly IndexSchema[];
  readonly orphan?: true | undefined;
}

/** Tables sorted by name. */
export interface DatabaseSchema {
  readonly tables: readonly TableSchema[];
}

/** How a many2many field is stored: its relation table and columns. */
export interface RelationTable {
  readonly table: string;
  readonly source: 'source_id';
  readonly target: 'target_id';
  readonly position: 'position';
}

/** Name of the relation table of a many2many field. */
export function relationTable(
  meta: ModelMeta,
  field: string,
  definition: FieldDefinition,
): RelationTable {
  const table = identifier(definition.relation ?? `${meta.table}_${columnName(field)}_rel`);
  return { table, source: 'source_id', target: 'target_id', position: 'position' };
}

function columnType(field: string, definition: FieldDefinition): ColumnSchema {
  const name = columnName(field);
  if (field === 'id') return { name, type: 'uuid', notNull: true };
  switch (definition.type) {
    case 'integer':
    case 'monetary':
      // Safe integers (up to 2^53): bigint. Empty value 0, never null.
      return { name, type: 'bigint', notNull: true, default: 0 };
    case 'boolean':
      return { name, type: 'boolean', notNull: true, default: false };
    case 'decimal':
      // Unconstrained numeric keeps the scale that was written ("12.30" reads back "12.30");
      // precision is enforced by the ORM (normalizeValue).
      return { name, type: 'numeric', notNull: false };
    case 'date':
      return { name, type: 'date', notNull: false };
    case 'datetime':
      return { name, type: 'timestamptz', notNull: false };
    case 'many2one':
      return { name, type: 'uuid', notNull: false };
    case 'json':
      return { name, type: 'jsonb', notNull: false };
    case 'char':
    case 'text':
    case 'html':
    case 'selection':
    case 'binary':
    case 'reference':
      return { name, type: 'text', notNull: false };
    case 'one2many':
    case 'many2many':
      throw new SchemaError(`"${field}" (${definition.type}) has no column.`);
  }
}

const ON_DELETE: Readonly<Record<'restrict' | 'cascade' | 'set null', ReferentialAction>> = {
  // The ORM applies `ondelete` itself with clear errors; the database enforces the same rule
  // as a second line of defence. RESTRICT cannot be deferred: NO ACTION DEFERRABLE instead.
  restrict: 'no action',
  cascade: 'cascade',
  'set null': 'set null',
};

function modelTable(registry: ModelRegistry, meta: ModelMeta): TableSchema[] {
  const table = identifier(meta.table);
  const columns: ColumnSchema[] = [];
  const foreignKeys: ForeignKeySchema[] = [];
  const indexes: IndexSchema[] = [];
  const relations: TableSchema[] = [];

  for (const [field, definition] of meta.fields) {
    if (definition.type === 'many2many') {
      const target = registry.get(definition.comodel ?? '');
      const rel = relationTable(meta, field, definition);
      relations.push({
        name: rel.table,
        owner: `${meta.name}.${field}`,
        columns: [
          { name: rel.source, type: 'uuid', notNull: true },
          { name: rel.target, type: 'uuid', notNull: true },
          { name: rel.position, type: 'integer', notNull: true, default: 0 },
        ],
        primaryKey: [rel.source, rel.target],
        foreignKeys: [
          {
            name: identifier(`${rel.table}_source_fk`),
            column: rel.source,
            references: table,
            onDelete: 'cascade',
          },
          {
            name: identifier(`${rel.table}_target_fk`),
            column: rel.target,
            references: identifier(target.table),
            onDelete: 'cascade',
          },
        ],
        uniques: [],
        indexes: [{ name: identifier(`${rel.table}_target_idx`), columns: [rel.target] }],
      });
      continue;
    }
    if (!isStoredColumn(definition)) continue;
    const column = columnType(field, definition);
    columns.push(column);
    if (definition.type === 'many2one') {
      const target = registry.get(definition.comodel ?? '');
      foreignKeys.push({
        name: identifier(`${table}_${column.name}_fk`),
        column: column.name,
        references: identifier(target.table),
        onDelete: ON_DELETE[definition.ondelete ?? 'set null'],
      });
    }
    // many2one columns are always indexed: one2many reads and ondelete checks search them.
    if (field !== 'id' && (definition.index === true || definition.type === 'many2one')) {
      indexes.push({ name: identifier(`${table}_${column.name}_idx`), columns: [column.name] });
    }
  }

  const uniques = meta.unique.map((constraint) => ({
    name: identifier(`${table}_${identifier(constraint.name)}_key`),
    columns: constraint.fields.map((field) => {
      const definition = meta.fields.get(field);
      if (!definition || !isStoredColumn(definition)) {
        throw new SchemaError(
          `Unique "${constraint.name}" of "${meta.name}": "${field}" is not a stored column.`,
        );
      }
      return columnName(field);
    }),
  }));

  if (columns.some((column) => column.name === FIELD_VERSIONS_COLUMN)) {
    throw new SchemaError(`"${meta.name}": the column "${FIELD_VERSIONS_COLUMN}" is reserved.`);
  }
  columns.push({
    name: FIELD_VERSIONS_COLUMN,
    type: 'jsonb',
    notNull: true,
    default: 'empty-object',
  });
  // Changes since a cursor are read by version.
  indexes.push({ name: identifier(`${table}_version_idx`), columns: ['version'] });

  return [
    { name: table, owner: meta.name, columns, primaryKey: ['id'], foreignKeys, uniques, indexes },
    ...relations,
  ];
}

/**
 * The schema of every concrete model of the registry (abstract models have no table).
 * @throws {@link SchemaError} when two models or relations would share a table or a name.
 */
export function buildSchema(registry: ModelRegistry): DatabaseSchema {
  const tables = registry
    .names()
    .map((name) => registry.get(name))
    .filter((meta) => !meta.abstract)
    .flatMap((meta) => modelTable(registry, meta));

  const owners = new Map<string, string>(
    [
      SCHEMA_TABLE,
      MODULE_TABLE,
      ...Object.values(SYNC_TABLES),
      ...Object.values(AUTH_TABLES),
      EXTERNAL_ID_TABLE,
    ].flatMap((reserved) => [
      [reserved, 'the ORM'],
      [`${reserved}_pkey`, 'the ORM'],
    ]),
  );
  for (const table of tables) {
    const names = [
      table.name,
      `${table.name}_pkey`,
      ...table.foreignKeys.map((fk) => fk.name),
      ...table.uniques.map((unique) => unique.name),
      ...table.indexes.map((index) => index.name),
    ];
    for (const name of names) {
      const previous = owners.get(name);
      if (previous !== undefined) {
        throw new SchemaError(
          `"${table.owner}" and "${previous}" both need the SQL name "${name}" (rename a model or set an explicit many2many relation).`,
        );
      }
      owners.set(name, table.owner);
    }
  }
  return { tables: tables.sort((a, b) => (a.name < b.name ? -1 : 1)) };
}

/** One step of an automatic, additive schema change. */
export type SchemaOperation =
  | { readonly kind: 'createTable'; readonly table: TableSchema }
  | { readonly kind: 'addColumn'; readonly table: string; readonly column: ColumnSchema }
  | { readonly kind: 'dropForeignKey'; readonly table: string; readonly name: string }
  | { readonly kind: 'dropUnique'; readonly table: string; readonly name: string }
  | { readonly kind: 'dropIndex'; readonly name: string }
  | { readonly kind: 'addUnique'; readonly table: string; readonly unique: IndexSchema }
  | { readonly kind: 'createIndex'; readonly table: string; readonly index: IndexSchema }
  | {
      readonly kind: 'addForeignKey';
      readonly table: string;
      readonly foreignKey: ForeignKeySchema;
    };

export interface SchemaPlan {
  /** Operations to run, in this order, in one transaction. */
  readonly operations: readonly SchemaOperation[];
  /**
   * Changes that would lose or rewrite data (type change, nullability change): never done
   * automatically, a `migrations/<version>/pre.ts` or `post.ts` must handle them first.
   */
  readonly destructive: readonly string[];
  /** Tables and columns no longer used by any model: kept, with their data. */
  readonly orphans: readonly string[];
  /** The schema to record once the operations are applied (desired schema plus orphans). */
  readonly recorded: DatabaseSchema;
}

const sameIndex = (a: IndexSchema, b: IndexSchema): boolean =>
  a.columns.length === b.columns.length && a.columns.every((column, i) => column === b.columns[i]);

const sameForeignKey = (a: ForeignKeySchema, b: ForeignKeySchema): boolean =>
  a.column === b.column && a.references === b.references && a.onDelete === b.onDelete;

/**
 * Compares the recorded schema (`null` for an empty database) with the desired one.
 * Only additive operations are planned; constraints and indexes, which hold no data, are
 * also dropped or rebuilt when they change.
 */
export function diffSchema(previous: DatabaseSchema | null, next: DatabaseSchema): SchemaPlan {
  const before = new Map((previous?.tables ?? []).map((table) => [table.name, table]));
  const created: SchemaOperation[] = [];
  const added: SchemaOperation[] = [];
  const dropped: SchemaOperation[] = [];
  const built: SchemaOperation[] = [];
  const linked: SchemaOperation[] = [];
  const destructive: string[] = [];
  const orphans: string[] = [];
  const recorded: TableSchema[] = [];

  const constraints = (table: string, old: TableSchema | undefined, wanted: TableSchema): void => {
    for (const fk of old?.foreignKeys ?? []) {
      const kept = wanted.foreignKeys.find((other) => other.name === fk.name);
      if (!kept || !sameForeignKey(fk, kept))
        dropped.push({ kind: 'dropForeignKey', table, name: fk.name });
    }
    for (const unique of old?.uniques ?? []) {
      const kept = wanted.uniques.find((other) => other.name === unique.name);
      if (!kept || !sameIndex(unique, kept))
        dropped.push({ kind: 'dropUnique', table, name: unique.name });
    }
    for (const index of old?.indexes ?? []) {
      const kept = wanted.indexes.find((other) => other.name === index.name);
      if (!kept || !sameIndex(index, kept)) dropped.push({ kind: 'dropIndex', name: index.name });
    }
    for (const unique of wanted.uniques) {
      const had = old?.uniques.find((other) => other.name === unique.name);
      if (!had || !sameIndex(had, unique)) built.push({ kind: 'addUnique', table, unique });
    }
    for (const index of wanted.indexes) {
      const had = old?.indexes.find((other) => other.name === index.name);
      if (!had || !sameIndex(had, index)) built.push({ kind: 'createIndex', table, index });
    }
    for (const foreignKey of wanted.foreignKeys) {
      const had = old?.foreignKeys.find((other) => other.name === foreignKey.name);
      if (!had || !sameForeignKey(had, foreignKey))
        linked.push({ kind: 'addForeignKey', table, foreignKey });
    }
  };

  for (const wanted of next.tables) {
    const old = before.get(wanted.name);
    before.delete(wanted.name);
    if (!old) {
      created.push({
        kind: 'createTable',
        table: { ...wanted, foreignKeys: [], uniques: [], indexes: [] },
      });
      constraints(wanted.name, undefined, wanted);
      recorded.push(wanted);
      continue;
    }
    if (
      !sameIndex({ name: '', columns: old.primaryKey }, { name: '', columns: wanted.primaryKey })
    ) {
      destructive.push(`${wanted.name}: primary key changes`);
    }
    const oldColumns = new Map(old.columns.map((column) => [column.name, column]));
    const columns: ColumnSchema[] = [];
    for (const column of wanted.columns) {
      const had = oldColumns.get(column.name);
      oldColumns.delete(column.name);
      if (!had) {
        if (column.notNull && column.default === undefined) {
          destructive.push(`${wanted.name}.${column.name}: new NOT NULL column without default`);
        }
        added.push({ kind: 'addColumn', table: wanted.name, column });
      } else if (had.type !== column.type) {
        destructive.push(`${wanted.name}.${column.name}: type ${had.type} → ${column.type}`);
      } else if (had.notNull !== column.notNull) {
        destructive.push(
          `${wanted.name}.${column.name}: ${column.notNull ? 'becomes NOT NULL' : 'becomes nullable'}`,
        );
      }
      columns.push(column);
    }
    for (const column of oldColumns.values()) {
      if (column.notNull && column.default === undefined) {
        destructive.push(`${wanted.name}.${column.name}: unused NOT NULL column without default`);
      }
      orphans.push(`${wanted.name}.${column.name}`);
      columns.push({ ...column, orphan: true });
    }
    constraints(wanted.name, old, wanted);
    recorded.push({ ...wanted, columns });
  }

  // Tables of models that disappeared: kept with their data, but their constraints go (a
  // leftover foreign key would otherwise block deletions in live tables).
  for (const old of before.values()) {
    orphans.push(old.name);
    const bare: TableSchema = { ...old, foreignKeys: [], uniques: [], indexes: [], orphan: true };
    constraints(old.name, old, bare);
    recorded.push(bare);
  }

  return {
    operations: [...created, ...added, ...dropped, ...built, ...linked],
    destructive,
    orphans,
    recorded: { tables: recorded.sort((a, b) => (a.name < b.name ? -1 : 1)) },
  };
}
