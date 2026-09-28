// SPDX-License-Identifier: LGPL-3.0-only
//
// Applies the automatic part of ARCHITECTURE.md §4.7: new tables, columns, indexes and
// constraints. The schema last applied is recorded in `socle_schema` (no ad-hoc introspection
// of the catalog), and the next diff starts from it.
import type { ModelRegistry } from '@socle/framework';
import {
  sql,
  type ColumnDefinitionBuilder,
  type CreateTableBuilder,
  type Transaction,
} from 'kysely';
import { z } from 'zod';

import type { Executor, Tables } from './database.js';
import { SchemaError } from './errors.js';
import {
  buildSchema,
  diffSchema,
  SCHEMA_TABLE,
  type ColumnSchema,
  type DatabaseSchema,
  type SchemaOperation,
  type SchemaPlan,
} from './schema.js';

/** Advisory lock serialising schema changes of a database (arbitrary constant). */
const SCHEMA_LOCK = 0x736f636c65; // "socle"

const name = z
  .string()
  .regex(/^[a-z_][a-z0-9_]*$/)
  .max(63);
const index = z.object({ name, columns: z.array(name).min(1) });
const tableSchema = z.object({
  name,
  owner: z.string().max(200),
  columns: z.array(
    z.object({
      name,
      type: z.enum([
        'uuid',
        'text',
        'bigint',
        'integer',
        'numeric',
        'boolean',
        'date',
        'timestamptz',
        'jsonb',
      ]),
      notNull: z.boolean(),
      default: z.union([z.literal(false), z.literal(0)]).optional(),
      orphan: z.literal(true).optional(),
    }),
  ),
  primaryKey: z.array(name).min(1),
  foreignKeys: z.array(
    z.object({
      name,
      column: name,
      references: name,
      onDelete: z.enum(['cascade', 'set null', 'no action']),
    }),
  ),
  uniques: z.array(index),
  indexes: z.array(index),
  orphan: z.literal(true).optional(),
});

async function recordedSchema(trx: Transaction<Tables>): Promise<DatabaseSchema | null> {
  const result = await sql<{
    definition: unknown;
  }>`select definition from ${sql.table(SCHEMA_TABLE)} order by table_name`.execute(trx);
  if (result.rows.length === 0) return null;
  // A malformed record must stop the process: diffing against a wrong base would corrupt the schema.
  const tables = result.rows.map((row) => {
    const parsed = tableSchema.safeParse(row.definition);
    if (!parsed.success)
      throw new SchemaError(`Corrupted row in ${SCHEMA_TABLE}: ${parsed.error.message}`);
    return parsed.data;
  });
  return { tables };
}

function columnBuilder(column: ColumnSchema) {
  return (builder: ColumnDefinitionBuilder): ColumnDefinitionBuilder => {
    let result = column.notNull ? builder.notNull() : builder;
    if (column.default !== undefined) result = result.defaultTo(column.default);
    return result;
  };
}

async function run(trx: Transaction<Tables>, operation: SchemaOperation): Promise<void> {
  const schema = trx.schema;
  switch (operation.kind) {
    case 'createTable': {
      const { table } = operation;
      let builder: CreateTableBuilder<string, string> = schema.createTable(table.name);
      for (const column of table.columns)
        builder = builder.addColumn(column.name, column.type, columnBuilder(column));
      await builder.addPrimaryKeyConstraint(`${table.name}_pkey`, [...table.primaryKey]).execute();
      return;
    }
    case 'addColumn':
      await schema
        .alterTable(operation.table)
        .addColumn(operation.column.name, operation.column.type, columnBuilder(operation.column))
        .execute();
      return;
    case 'dropForeignKey':
    case 'dropUnique':
      await schema.alterTable(operation.table).dropConstraint(operation.name).execute();
      return;
    case 'dropIndex':
      await schema.dropIndex(operation.name).execute();
      return;
    case 'addUnique':
      await schema
        .alterTable(operation.table)
        .addUniqueConstraint(operation.unique.name, [...operation.unique.columns])
        .execute();
      return;
    case 'createIndex':
      await schema
        .createIndex(operation.index.name)
        .on(operation.table)
        .columns([...operation.index.columns])
        .execute();
      return;
    case 'addForeignKey': {
      const { foreignKey } = operation;
      // Deferred to commit: the ORM may write a reference before the referenced record in a flush.
      await schema
        .alterTable(operation.table)
        .addForeignKeyConstraint(
          foreignKey.name,
          [foreignKey.column],
          foreignKey.references,
          ['id'],
          (fk) => fk.onDelete(foreignKey.onDelete),
        )
        .deferrable()
        .initiallyDeferred()
        .execute();
      return;
    }
  }
}

/**
 * Brings the database schema in line with the registry, in one transaction, under an advisory
 * lock. Refuses any destructive change (it needs a hand-written migration first).
 * @throws {@link SchemaError}
 */
export async function applySchema(db: Executor, registry: ModelRegistry): Promise<SchemaPlan> {
  const desired = buildSchema(registry);
  return db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(${SCHEMA_LOCK})`.execute(trx);
    await sql`create table if not exists ${sql.table(SCHEMA_TABLE)} (table_name text primary key, definition jsonb not null, applied_at timestamptz not null default now())`.execute(
      trx,
    );
    const plan = diffSchema(await recordedSchema(trx), desired);
    if (plan.destructive.length > 0) {
      throw new SchemaError(
        `Schema changes need a migration (migrations/<version>/pre.ts or post.ts):\n- ${plan.destructive.join('\n- ')}`,
      );
    }
    for (const operation of plan.operations) await run(trx, operation);
    await sql`delete from ${sql.table(SCHEMA_TABLE)}`.execute(trx);
    for (const table of plan.recorded.tables) {
      await sql`insert into ${sql.table(SCHEMA_TABLE)} (table_name, definition) values (${table.name}, ${JSON.stringify(table)}::jsonb)`.execute(
        trx,
      );
    }
    return plan;
  });
}
