// SPDX-License-Identifier: LGPL-3.0-only
import {
  isRecordId,
  isStoredColumn,
  ValidationError,
  type DomainNode,
  type FieldDefinition,
  type ModelMeta,
  type ModelRegistry,
  type SearchOptions,
  type Storage,
  type StoredValues,
} from '@socle/framework';
import { sql, type RawBuilder } from 'kysely';
import pg from 'pg';

import { DomainCompiler } from './compile.js';
import type { Executor } from './database.js';
import { SchemaError } from './errors.js';
import { columnName, identifier } from './naming.js';
import { relationTable } from './schema.js';

/** PostgreSQL accepts at most 65 535 parameters per statement; stay well below. */
const MAX_PARAMETERS = 30_000;

const UNIQUE_VIOLATION = '23505';

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
export function createPgStorage(executor: Executor, registry: ModelRegistry): Storage {
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

  return {
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
          all.set(field, definition);
      const fields = [...all.keys()];
      const perChunk = Math.max(1, Math.floor(MAX_PARAMETERS / fields.length));
      await guarded(meta, async () => {
        for (let start = 0; start < rows.length; start += perChunk) {
          const chunk = rows.slice(start, start + perChunk).map((row) => {
            const values = fields.map((field) => {
              if (field === 'id') return sql`${row.id}`;
              if (!(field in row.values)) return sql`default`;
              return sql`${toParameter(all.get(field) as FieldDefinition, row.values[field])}`;
            });
            return sql`(${sql.join(values)})`;
          });
          await sql`insert into ${table(meta)} (${sql.join(fields.map((field) => sql.id(columnName(field))))}) values ${sql.join(chunk)}`.execute(
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
        if (columns.length > 0) {
          const assignments = columns.map(
            ([field, definition]) =>
              sql`${sql.id(columnName(field))} = ${toParameter(definition, values[field])}`,
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
      await sql`delete from ${table(meta)} where id = any(${wanted}::uuid[])`.execute(executor);
    },
  };
}
