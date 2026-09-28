// SPDX-License-Identifier: LGPL-3.0-only
//
// Applies the automatic part of ARCHITECTURE.md §4.7: new tables, columns, indexes and
// constraints. The schema last applied is recorded in `socle_schema` (no ad-hoc introspection
// of the catalog), and the next diff starts from it.
import type { ModelRegistry, SecurityPolicy } from '@socle/framework';
import {
  sql,
  type ColumnDefinitionBuilder,
  type CreateTableBuilder,
  type Transaction,
} from 'kysely';
import { z } from 'zod';

import type { Executor, Tables } from './database.js';
import { SchemaError } from './errors.js';
import { applyRowSecurity, buildRowSecurity } from './rls.js';
import {
  buildSchema,
  diffSchema,
  SCHEMA_TABLE,
  SYNC_TABLES,
  AUTH_TABLES,
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
      default: z.union([z.literal(false), z.literal(0), z.literal('empty-object')]).optional(),
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

/** The schema recorded by the last change (`null` on an empty database). */
export async function recordedSchema(trx: Transaction<Tables>): Promise<DatabaseSchema | null> {
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
    if (column.default === 'empty-object') result = result.defaultTo(sql`'{}'::jsonb`);
    else if (column.default !== undefined) result = result.defaultTo(column.default);
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

/** Creates the synchronisation bookkeeping objects if they do not exist yet. */
async function ensureSyncObjects(trx: Transaction<Tables>): Promise<void> {
  const t = SYNC_TABLES;
  await sql`create sequence if not exists ${sql.id(t.sequence)}`.execute(trx);
  await sql`create table if not exists ${sql.table(t.tombstone)} (model text not null, record_id uuid not null, version bigint not null, deleted_at timestamptz not null default now(), primary key (model, record_id))`.execute(
    trx,
  );
  await sql`create index if not exists socle_tombstone_version_idx on ${sql.table(t.tombstone)} (version)`.execute(
    trx,
  );
  await sql`create table if not exists ${sql.table(t.device)} (id text primary key, user_id text not null, public_key text not null, status text not null check (status in ('active', 'revoked')), registered_at timestamptz not null default now(), last_seen_at timestamptz)`.execute(
    trx,
  );
  await sql`create table if not exists ${sql.table(t.mutation)} (mutation_id uuid primary key, device_id text not null, status text not null, conflict boolean not null, reason text not null, processed_at timestamptz not null default now())`.execute(
    trx,
  );
  await sql`create table if not exists ${sql.table(t.archive)} (id bigint generated always as identity primary key, model text not null, record_id uuid not null, side text not null check (side in ('local', 'remote')), mutation_id uuid not null, device_id text not null, user_id text not null, reason text not null, "values" jsonb not null, archived_at timestamptz not null default now())`.execute(
    trx,
  );
  const a = AUTH_TABLES;
  await sql`create table if not exists ${sql.table(a.user)} (id text primary key, login text not null unique, password_hash text not null, group_ids text[] not null default '{}', company_ids text[] not null default '{}', company_id text, lang text not null default 'fr', tz text not null default 'UTC', active boolean not null default true, failed_attempts integer not null default 0, locked_until timestamptz)`.execute(
    trx,
  );
  // Only a hash of the session token is stored: a database leak does not leak sessions.
  await sql`create table if not exists ${sql.table(a.session)} (token_hash text primary key, user_id text not null references ${sql.table(a.user)} (id) on delete cascade, created_at timestamptz not null default now(), last_seen_at timestamptz not null default now(), expires_at timestamptz not null, revoked boolean not null default false)`.execute(
    trx,
  );
}

/** Takes the schema lock and makes sure the bookkeeping table exists (inside `trx`). */
export async function prepareSchemaTransaction(trx: Transaction<Tables>): Promise<void> {
  await sql`select pg_advisory_xact_lock(${SCHEMA_LOCK})`.execute(trx);
  // Schema changes, exports and migrations see every row (row-level security bypass).
  await sql`select set_config('app.su', 'on', true)`.execute(trx);
  await sql`create table if not exists ${sql.table(SCHEMA_TABLE)} (table_name text primary key, definition jsonb not null, applied_at timestamptz not null default now())`.execute(
    trx,
  );
}

/** Replaces the recorded schema. */
export async function recordSchema(
  trx: Transaction<Tables>,
  schema: DatabaseSchema,
): Promise<void> {
  await sql`delete from ${sql.table(SCHEMA_TABLE)}`.execute(trx);
  for (const table of schema.tables) {
    await sql`insert into ${sql.table(SCHEMA_TABLE)} (table_name, definition) values (${table.name}, ${JSON.stringify(table)}::jsonb)`.execute(
      trx,
    );
  }
}

/**
 * Applies the additive changes from `previous` to the registry's schema inside `trx` and
 * records the result. Refuses any destructive change.
 * @throws {@link SchemaError}
 */
export interface ApplySchemaOptions {
  /**
   * The security policy of the installed modules: when given, the row-level security
   * policies mirroring its record rules are (re)created. When omitted, they are left as is.
   */
  readonly security?: SecurityPolicy | undefined;
}

export async function applySchemaIn(
  trx: Transaction<Tables>,
  registry: ModelRegistry,
  previous: DatabaseSchema | null,
  options: ApplySchemaOptions = {},
): Promise<SchemaPlan> {
  const plan = diffSchema(previous, buildSchema(registry));
  if (plan.destructive.length > 0) {
    throw new SchemaError(
      `Schema changes need a migration (migrations/<version>/pre.ts or post.ts):\n- ${plan.destructive.join('\n- ')}`,
    );
  }
  await ensureSyncObjects(trx);
  for (const operation of plan.operations) await run(trx, operation);
  if (options.security) await applyRowSecurity(trx, buildRowSecurity(registry, options.security));
  await recordSchema(trx, plan.recorded);
  return plan;
}

/**
 * Brings the database schema in line with the registry, in one transaction, under an advisory
 * lock. Refuses any destructive change (it needs a hand-written migration first).
 * @throws {@link SchemaError}
 */
export async function applySchema(
  db: Executor,
  registry: ModelRegistry,
  options: ApplySchemaOptions = {},
): Promise<SchemaPlan> {
  return db.transaction().execute(async (trx) => {
    await prepareSchemaTransaction(trx);
    return applySchemaIn(trx, registry, await recordedSchema(trx), options);
  });
}
