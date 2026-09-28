// SPDX-License-Identifier: LGPL-3.0-only
import {
  AccessError,
  isRecordId,
  isStoredColumn,
  ValidationError,
  type DomainNode,
  type FieldDefinition,
  type ModelMeta,
  type ModelRegistry,
  type SearchOptions,
  type Storage,
  type StorageActor,
  type StoredValues,
  TECHNICAL_FIELDS,
} from '@socle/framework';
import { sql, type RawBuilder } from 'kysely';
import pg from 'pg';

import { DomainCompiler } from './compile.js';
import type { Executor } from './database.js';
import { SchemaError } from './errors.js';
import { columnName, identifier } from './naming.js';
import { FIELD_VERSIONS_COLUMN, relationTable, SYNC_TABLES } from './schema.js';
import { createPgSession, type PgSession } from './session.js';

/** PostgreSQL accepts at most 65 535 parameters per statement; stay well below. */
const MAX_PARAMETERS = 30_000;

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const ROW_SECURITY_VIOLATION = '42501';

/**
 * Foreign keys are checked at commit (deferred), outside the storage calls: a violation
 * surfaces from the transaction itself. It is a refusal (a referenced record does not exist,
 * or a deleted record is still referenced), never a temporary failure. Callers running a
 * transaction pass its error through this function.
 */
export function translateCommitError(error: unknown): unknown {
  if (error instanceof pg.DatabaseError && error.code === FOREIGN_KEY_VIOLATION) {
    return new ValidationError(
      'A referenced record does not exist, or a deleted record is still referenced.',
    );
  }
  return error;
}

function toParameter(definition: FieldDefinition, value: unknown): unknown {
  // The driver turns JavaScript arrays into PostgreSQL arrays: JSON always goes as text.
  if (definition.type === 'json' && value !== null && value !== undefined)
    return JSON.stringify(value);
  return value ?? null;
}

/**
 * The ORM storage on PostgreSQL (server side). `executor` is a pool or, for a request, the
 * transaction the whole request runs in.
 */
export function createPgStorage(
  executor: Executor,
  registry: ModelRegistry,
  session: PgSession = createPgSession(executor),
): Storage {
  const table = (meta: ModelMeta): RawBuilder<unknown> => sql.table(identifier(meta.table));

  const definitionOf = (meta: ModelMeta, field: string): FieldDefinition => {
    const definition = meta.fields.get(field);
    if (!definition) throw new ValidationError(`Unknown field "${meta.name}.${field}".`);
    return definition;
  };

  /** Stored columns and many2many fields of a set of values. */
  const split = (meta: ModelMeta, values: StoredValues) => {
    const columns: [string, FieldDefinition][] = [];
    const relations: [string, FieldDefinition][] = [];
    for (const field of Object.keys(values)) {
      const definition = definitionOf(meta, field);
      if (definition.type === 'many2many') relations.push([field, definition]);
      else if (isStoredColumn(definition)) columns.push([field, definition]);
      else throw new ValidationError(`"${meta.name}.${field}" is not stored.`);
    }
    return { columns, relations };
  };

  const translate = (meta: ModelMeta, error: unknown): unknown => {
    if (error instanceof pg.DatabaseError && error.code === ROW_SECURITY_VIOLATION) {
      return new AccessError(`Operation refused by row-level security on "${meta.name}".`);
    }
    if (!(error instanceof pg.DatabaseError) || error.code !== UNIQUE_VIOLATION) return error;
    if (error.constraint === `${meta.table}_pkey`) {
      return new ValidationError(`Duplicate id in "${meta.name}".`);
    }
    const unique = meta.unique.find(
      (constraint) => `${meta.table}_${constraint.name}_key` === error.constraint,
    );
    return unique
      ? new ValidationError(`Uniqueness "${unique.name}" violated on "${meta.name}".`)
      : error;
  };

  const guarded = async <T>(meta: ModelMeta, work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw translate(meta, error);
    }
  };

  /** `count` new values of the version sequence, in order. */
  const nextVersions = async (count: number): Promise<number[]> => {
    const result = await sql<{
      v: number;
    }>`select nextval(${SYNC_TABLES.sequence}) as v from generate_series(1, ${count})`.execute(
      executor,
    );
    return result.rows.map((row) => row.v);
  };

  /** Version of each business field written (technical fields are not synchronised as edits). */
  const fieldVersions = (values: StoredValues, version: number): Record<string, number> =>
    Object.fromEntries(
      Object.keys(values)
        .filter((field) => !TECHNICAL_FIELDS.includes(field))
        .map((field) => [field, version]),
    );

  const writeRelations = async (
    meta: ModelMeta,
    rows: readonly { readonly id: string; readonly values: StoredValues }[],
    replace: boolean,
  ): Promise<void> => {
    for (const [field, definition] of meta.fields) {
      if (definition.type !== 'many2many') continue;
      const rel = relationTable(meta, field, definition);
      const touched = rows.filter((row) => field in row.values);
      if (touched.length === 0) continue;
      if (replace) {
        await sql`delete from ${sql.table(rel.table)} where ${sql.id(rel.source)} = any(${touched.map((row) => row.id)}::uuid[])`.execute(
          executor,
        );
      }
      const links = touched.flatMap(({ id, values }) => {
        const targets = values[field];
        if (!Array.isArray(targets)) return [];
        return targets.map((target, position) => sql`(${id}::uuid, ${target}::uuid, ${position})`);
      });
      for (let start = 0; start < links.length; start += MAX_PARAMETERS / 3) {
        const chunk = links.slice(start, start + MAX_PARAMETERS / 3);
        await sql`insert into ${sql.table(rel.table)} (${sql.id(rel.source)}, ${sql.id(rel.target)}, ${sql.id(rel.position)}) values ${sql.join(chunk)}`.execute(
          executor,
        );
      }
    }
  };

  const storage: Storage = {
    async search(meta: ModelMeta, where: DomainNode, options: SearchOptions): Promise<string[]> {
      const compiler = new DomainCompiler(registry);
      const alias = compiler.root();
      const predicate = compiler.compile(meta, alias, where);
      const order = compiler.order(meta, alias, options.order ?? meta.order);
      const limit = options.limit === undefined ? sql`` : sql` limit ${options.limit}`;
      const offset = options.offset ? sql` offset ${options.offset}` : sql``;
      const result = await sql<{
        id: string;
      }>`select ${compiler.column(alias, 'id')} as id from ${table(meta)} as ${sql.id(alias)} where ${predicate} order by ${order}${limit}${offset}`.execute(
        executor,
      );
      return result.rows.map((row) => row.id);
    },

    async count(meta: ModelMeta, where: DomainNode): Promise<number> {
      const compiler = new DomainCompiler(registry);
      const alias = compiler.root();
      const predicate = compiler.compile(meta, alias, where);
      const result = await sql<{
        n: number;
      }>`select count(*)::integer as n from ${table(meta)} as ${sql.id(alias)} where ${predicate}`.execute(
        executor,
      );
      return result.rows[0]?.n ?? 0;
    },

    async read(
      meta: ModelMeta,
      ids: readonly string[],
      fields: readonly string[],
    ): Promise<ReadonlyMap<string, StoredValues>> {
      const wanted = [...new Set(ids.filter(isRecordId))];
      const result = new Map<string, Record<string, unknown>>();
      if (wanted.length === 0) return result;
      const columns: string[] = [];
      const relations: string[] = [];
      for (const field of fields) {
        const definition = definitionOf(meta, field);
        if (definition.type === 'many2many') relations.push(field);
        else if (isStoredColumn(definition)) columns.push(field);
        else throw new SchemaError(`"${meta.name}.${field}" is not stored.`);
      }
      const selected = [
        sql`${sql.ref(`t0.${columnName('id')}`)} as ${sql.id('id')}`,
        ...columns.map((field) => sql`${sql.ref(`t0.${columnName(field)}`)} as ${sql.id(field)}`),
      ];
      const rows = await sql<
        Record<string, unknown>
      >`select ${sql.join(selected)} from ${table(meta)} as t0 where t0.id = any(${wanted}::uuid[])`.execute(
        executor,
      );
      for (const row of rows.rows) {
        const values: Record<string, unknown> = {};
        for (const field of columns) values[field] = row[field] ?? null;
        for (const field of relations) values[field] = [];
        result.set(row.id as string, values);
      }
      for (const field of relations) {
        const rel = relationTable(meta, field, definitionOf(meta, field));
        const links = await sql<{
          source: string;
          target: string;
        }>`select ${sql.id(rel.source)} as source, ${sql.id(rel.target)} as target from ${sql.table(rel.table)} where ${sql.id(rel.source)} = any(${[...result.keys()]}::uuid[]) order by ${sql.id(rel.source)}, ${sql.id(rel.position)}`.execute(
          executor,
        );
        for (const { source, target } of links.rows) {
          (result.get(source)?.[field] as string[] | undefined)?.push(target);
        }
      }
      return result;
    },

    async insert(
      meta: ModelMeta,
      rows: readonly { readonly id: string; readonly values: StoredValues }[],
    ): Promise<void> {
      if (rows.length === 0) return;
      const all = new Map<string, FieldDefinition>([['id', definitionOf(meta, 'id')]]);
      for (const row of rows)
        for (const [field, definition] of split(meta, row.values).columns)
          if (field !== 'version') all.set(field, definition);
      const fields = [...all.keys()];
      const perChunk = Math.max(1, Math.floor(MAX_PARAMETERS / (fields.length + 2)));
      await guarded(meta, async () => {
        // The server numbers every change (synchronisation cursor): the device's value is ignored.
        const versions = await nextVersions(rows.length);
        for (let start = 0; start < rows.length; start += perChunk) {
          const chunk = rows.slice(start, start + perChunk).map((row, offset) => {
            const version = versions[start + offset] as number;
            const values = fields.map((field) => {
              if (field === 'id') return sql`${row.id}`;
              if (!(field in row.values)) return sql`default`;
              return sql`${toParameter(all.get(field) as FieldDefinition, row.values[field])}`;
            });
            values.push(
              sql`${version}`,
              sql`${JSON.stringify(fieldVersions(row.values, version))}::jsonb`,
            );
            return sql`(${sql.join(values)})`;
          });
          const names = [
            ...fields.map((field) => sql.id(columnName(field))),
            sql.id('version'),
            sql.id(FIELD_VERSIONS_COLUMN),
          ];
          await sql`insert into ${table(meta)} (${sql.join(names)}) values ${sql.join(chunk)}`.execute(
            executor,
          );
        }
        await writeRelations(meta, rows, false);
      });
    },

    async update(meta: ModelMeta, id: string, values: StoredValues): Promise<void> {
      const { columns } = split(meta, values);
      const missing = new ValidationError(`Record ${id} of "${meta.name}" does not exist.`);
      if (!isRecordId(id)) throw missing;
      await guarded(meta, async () => {
        if (columns.length > 0 || Object.keys(values).length > 0) {
          const [version] = await nextVersions(1);
          const assignments = columns
            .filter(([field]) => field !== 'version')
            .map(
              ([field, definition]) =>
                sql`${sql.id(columnName(field))} = ${toParameter(definition, values[field])}`,
            );
          assignments.push(
            sql`version = ${version}`,
            sql`${sql.id(FIELD_VERSIONS_COLUMN)} = ${sql.id(FIELD_VERSIONS_COLUMN)} || ${JSON.stringify(fieldVersions(values, version as number))}::jsonb`,
          );
          const result =
            await sql`update ${table(meta)} set ${sql.join(assignments)} where id = ${id}::uuid`.execute(
              executor,
            );
          if (result.numAffectedRows === 0n) throw missing;
        } else {
          const found = await sql`select 1 from ${table(meta)} where id = ${id}::uuid`.execute(
            executor,
          );
          if (found.rows.length === 0) throw missing;
        }
        await writeRelations(meta, [{ id, values }], true);
      });
    },

    async delete(meta: ModelMeta, ids: readonly string[]): Promise<void> {
      const wanted = [...new Set(ids.filter(isRecordId))];
      if (wanted.length === 0) return;
      // Relation rows go with the record (ON DELETE CASCADE on both sides of every relation table).
      await guarded(meta, async () => {
        const deleted = await sql<{
          id: string;
        }>`delete from ${table(meta)} where id = any(${wanted}::uuid[]) returning id`.execute(
          executor,
        );
        if (deleted.rows.length === 0) return;
        // Tombstones: devices learn about deletions at their next pull.
        await sql`insert into ${sql.table(SYNC_TABLES.tombstone)} (model, record_id, version) select ${meta.name}, x, nextval(${SYNC_TABLES.sequence}) from unnest(${deleted.rows.map((row) => row.id)}::uuid[]) as x on conflict (model, record_id) do update set version = excluded.version, deleted_at = now()`.execute(
          executor,
        );
      });
    },
  };

  // ─── acting user (row-level security) ─────────────────────────────────────────────────
  // The settings are transaction-local (SET LOCAL) and written by the shared session only when
  // the actor changes: one round trip per switch between the user and the superuser.
  const actAs = (actor: StorageActor): Promise<void> => session.actAs(actor);

  const as = (actor: StorageActor): Storage => ({
    search: async (meta, where, options) => (
      await actAs(actor),
      storage.search(meta, where, options)
    ),
    count: async (meta, where) => (await actAs(actor), storage.count(meta, where)),
    read: async (meta, ids, fields) => (await actAs(actor), storage.read(meta, ids, fields)),
    insert: async (meta, rows) => (await actAs(actor), storage.insert(meta, rows)),
    update: async (meta, id, values) => (await actAs(actor), storage.update(meta, id, values)),
    delete: async (meta, ids) => (await actAs(actor), storage.delete(meta, ids)),
    as,
  });

  return { ...storage, as };
}
