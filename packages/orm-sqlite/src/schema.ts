// SPDX-License-Identifier: LGPL-3.0-only
//
// Schema of the local replica (offline client). No foreign keys: the replica is partial
// (ARCHITECTURE.md §6.1), referenced records may legitimately be absent; integrity is the
// server's job. Changes are additive; anything else rebuilds the replica, which is a cache
// refilled by the synchronisation (pending local changes live outside these tables).
import {
  isStoredColumn,
  SocleError,
  type FieldDefinition,
  type ModelMeta,
  type ModelRegistry,
} from '@socle/framework';
import { sql } from 'kysely';

import type { SqliteExecutor } from './driver.js';
import type { ValueKind } from './functions.js';

/** The local schema cannot be derived from the models. */
export class LocalSchemaError extends SocleError {
  constructor(message: string) {
    super('orm_sqlite.schema', message);
  }
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** Checks an SQL identifier (same rules as the PostgreSQL adapter). */
export function identifier(name: string): string {
  if (!IDENTIFIER.test(name) || name.length > 63) {
    throw new LocalSchemaError(`Invalid SQL identifier "${name}".`);
  }
  return name;
}

/** camelCase field → snake_case column (`partnerId` → `partner_id`). */
export function columnName(field: string): string {
  let result = '';
  for (const char of field) {
    const lower = char.toLowerCase();
    result += lower === char ? char : `_${lower}`;
  }
  return identifier(result);
}

/** Table holding the recorded local schema. */
export const LOCAL_SCHEMA_TABLE = 'socle_local_schema';

export type SqliteType = 'text' | 'integer';

export interface LocalColumn {
  readonly name: string;
  readonly type: SqliteType;
  /** Empty value for rows that exist before the column (0 / false). */
  readonly default: 0 | null;
}

export interface LocalTable {
  readonly name: string;
  readonly columns: readonly LocalColumn[];
  readonly primaryKey: readonly string[];
  readonly unique: readonly { readonly name: string; readonly columns: readonly string[] }[];
  readonly indexes: readonly { readonly name: string; readonly columns: readonly string[] }[];
}

/** How the values of a field are stored and decoded. */
export function valueKind(definition: FieldDefinition): ValueKind {
  switch (definition.type) {
    case 'boolean':
      return 'boolean';
    case 'json':
      return 'json';
    case 'integer':
    case 'monetary':
      return 'number';
    default:
      return 'text';
  }
}

function column(field: string, definition: FieldDefinition): LocalColumn {
  const kind = valueKind(definition);
  const numeric = kind === 'number' || kind === 'boolean';
  return {
    name: columnName(field),
    type: numeric ? 'integer' : 'text',
    default: numeric ? 0 : null,
  };
}

/** Relation table of a many2many field (same naming as the server). */
export function relationTable(meta: ModelMeta, field: string, definition: FieldDefinition): string {
  return identifier(definition.relation ?? `${meta.table}_${columnName(field)}_rel`);
}

/** The local tables of every concrete model. */
export function buildLocalSchema(registry: ModelRegistry): LocalTable[] {
  const tables: LocalTable[] = [];
  for (const name of registry.names()) {
    const meta = registry.get(name);
    if (meta.abstract) continue;
    const table = identifier(meta.table);
    const columns: LocalColumn[] = [];
    const indexes: { name: string; columns: string[] }[] = [];
    for (const [field, definition] of meta.fields) {
      if (definition.type === 'many2many') {
        const rel = relationTable(meta, field, definition);
        tables.push({
          name: rel,
          columns: [
            { name: 'source_id', type: 'text', default: null },
            { name: 'target_id', type: 'text', default: null },
            { name: 'position', type: 'integer', default: 0 },
          ],
          primaryKey: ['source_id', 'target_id'],
          unique: [],
          indexes: [{ name: identifier(`${rel}_target_idx`), columns: ['target_id'] }],
        });
        continue;
      }
      if (!isStoredColumn(definition)) continue;
      columns.push(column(field, definition));
      if (field !== 'id' && (definition.index === true || definition.type === 'many2one')) {
        indexes.push({
          name: identifier(`${table}_${columnName(field)}_idx`),
          columns: [columnName(field)],
        });
      }
    }
    tables.push({
      name: table,
      columns,
      primaryKey: ['id'],
      unique: meta.unique.map((constraint) => ({
        name: identifier(`${table}_${identifier(constraint.name)}_key`),
        columns: constraint.fields.map(columnName),
      })),
      indexes,
    });
  }
  return tables.sort((a, b) => (a.name < b.name ? -1 : 1));
}

async function createTable(db: SqliteExecutor, table: LocalTable): Promise<void> {
  let builder = db.schema.createTable(table.name);
  for (const col of table.columns) {
    builder = builder.addColumn(col.name, col.type, (c) => {
      let definition = c;
      if (col.default !== null) definition = definition.notNull().defaultTo(col.default);
      return definition;
    });
  }
  await builder
    .addPrimaryKeyConstraint(`${table.name}_pkey`, [...table.primaryKey] as never[])
    .execute();
}

async function createIndexes(db: SqliteExecutor, table: LocalTable): Promise<void> {
  for (const unique of table.unique) {
    await db.schema
      .createIndex(unique.name)
      .ifNotExists()
      .unique()
      .on(table.name)
      .columns([...unique.columns])
      .execute();
  }
  for (const index of table.indexes) {
    await db.schema
      .createIndex(index.name)
      .ifNotExists()
      .on(table.name)
      .columns([...index.columns])
      .execute();
  }
}

export interface LocalSchemaResult {
  readonly created: readonly string[];
  readonly altered: readonly string[];
  /** The replica was dropped and recreated (incompatible change): a full pull is needed. */
  readonly reset: boolean;
}

/**
 * Brings the local tables in line with the registry: additive changes in place; any other
 * change (type change, removed column or table) drops and recreates the model tables.
 */
export async function applyLocalSchema(
  db: SqliteExecutor,
  registry: ModelRegistry,
): Promise<LocalSchemaResult> {
  const desired = buildLocalSchema(registry);
  return db.transaction().execute(async (trx) => {
    await sql`create table if not exists ${sql.table(LOCAL_SCHEMA_TABLE)} (name text primary key, definition text not null)`.execute(
      trx,
    );
    const rows = await sql<{
      name: string;
      definition: string;
    }>`select name, definition from ${sql.table(LOCAL_SCHEMA_TABLE)}`.execute(trx);
    const recorded = new Map(
      rows.rows.map((row) => [row.name, JSON.parse(row.definition) as LocalTable]),
    );

    const compatible = [...recorded.values()].every((old) => {
      const wanted = desired.find((table) => table.name === old.name);
      return (
        wanted !== undefined &&
        old.columns.every((c) => wanted.columns.some((w) => w.name === c.name && w.type === c.type))
      );
    });

    const created: string[] = [];
    const altered: string[] = [];
    if (!compatible) {
      for (const old of recorded.values())
        await sql`drop table if exists ${sql.table(identifier(old.name))}`.execute(trx);
      await sql`delete from ${sql.table(LOCAL_SCHEMA_TABLE)}`.execute(trx);
      recorded.clear();
    }
    for (const table of desired) {
      const old = recorded.get(table.name);
      if (!old) {
        await createTable(trx, table);
        created.push(table.name);
      } else {
        for (const col of table.columns.filter(
          (c) => !old.columns.some((o) => o.name === c.name),
        )) {
          await trx.schema
            .alterTable(table.name)
            .addColumn(col.name, col.type, (c) =>
              col.default !== null ? c.notNull().defaultTo(col.default) : c,
            )
            .execute();
          altered.push(`${table.name}.${col.name}`);
        }
      }
      await createIndexes(trx, table);
      await sql`insert into ${sql.table(LOCAL_SCHEMA_TABLE)} (name, definition) values (${table.name}, ${JSON.stringify(table)}) on conflict (name) do update set definition = excluded.definition`.execute(
        trx,
      );
    }
    return { created, altered, reset: !compatible };
  });
}
