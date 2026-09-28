// SPDX-License-Identifier: LGPL-3.0-only
//
// The ORM storage on SQLite: the offline client's local replica (ARCHITECTURE.md §6).
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

import { LocalDomainCompiler } from './compile.js';
import type { SqliteExecutor, SqliteValue } from './driver.js';
import { decodeValue } from './functions.js';
import { columnName, identifier, LocalSchemaError, relationTable, valueKind } from './schema.js';

/** SQLite accepts 32 766 parameters per statement (default build); stay well below. */
const MAX_PARAMETERS = 10_000;

function encode(definition: FieldDefinition, value: unknown): SqliteValue {
  if (value === undefined || value === null) return null;
  if (definition.type === 'boolean') return value === true ? 1 : 0;
  if (definition.type === 'json') return JSON.stringify(value);
  return value as SqliteValue;
}

const UNIQUE_FAILED = 'UNIQUE constraint failed: ';

/**
 * The storage of the offline client. `db` is the connection or, for a unit of work, the
 * transaction it runs in.
 */
export function createSqliteStorage(db: SqliteExecutor, registry: ModelRegistry): Storage {
  const table = (meta: ModelMeta): RawBuilder<unknown> => sql.table(identifier(meta.table));

  const definitionOf = (meta: ModelMeta, field: string): FieldDefinition => {
    const definition = meta.fields.get(field);
    if (!definition) throw new ValidationError(`Unknown field "${meta.name}.${field}".`);
    return definition;
  };

  const columnsOf = (meta: ModelMeta, values: StoredValues): [string, FieldDefinition][] =>
    Object.keys(values).flatMap((field): [string, FieldDefinition][] => {
      const definition = definitionOf(meta, field);
      if (definition.type === 'many2many') return [];
      if (!isStoredColumn(definition))
        throw new ValidationError(`"${meta.name}.${field}" is not stored.`);
      return [[field, definition]];
    });

  /** SQLite reports "UNIQUE constraint failed: t.a, t.b": map it back to the model. */
  const translate = (meta: ModelMeta, error: unknown): unknown => {
    const message = error instanceof Error ? error.message : '';
    const at = message.indexOf(UNIQUE_FAILED);
    if (at < 0) return error;
    const columns = message
      .slice(at + UNIQUE_FAILED.length)
      .split(',')
      .map((part) => part.trim().split('.').pop() ?? '')
      .sort();
    if (columns.length === 1 && columns[0] === 'id')
      return new ValidationError(`Duplicate id in "${meta.name}".`);
    const unique = meta.unique.find((constraint) => {
      const expected = constraint.fields.map(columnName).sort();
      return expected.length === columns.length && expected.every((c, i) => c === columns[i]);
    });
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
      const rel = sql.table(relationTable(meta, field, definition));
      const touched = rows.filter((row) => field in row.values);
      for (const { id, values } of touched) {
        if (replace) await sql`delete from ${rel} where source_id = ${id}`.execute(db);
        const targets = values[field];
        if (!Array.isArray(targets) || targets.length === 0) continue;
        const links = targets.map(
          (target, position) => sql`(${id}, ${target as string}, ${position})`,
        );
        await sql`insert into ${rel} (source_id, target_id, position) values ${sql.join(links)}`.execute(
          db,
        );
      }
    }
  };

  return {
    async search(meta: ModelMeta, where: DomainNode, options: SearchOptions): Promise<string[]> {
      const compiler = new LocalDomainCompiler(registry);
      const alias = compiler.root();
      const predicate = compiler.compile(meta, alias, where);
      const order = compiler.order(meta, alias, options.order ?? meta.order);
      const limit = options.limit === undefined ? sql` limit -1` : sql` limit ${options.limit}`;
      const offset = options.offset ? sql` offset ${options.offset}` : sql``;
      const result = await sql<{
        id: string;
      }>`select ${compiler.column(alias, 'id')} as id from ${table(meta)} as ${sql.id(alias)} where ${predicate} order by ${order}${limit}${offset}`.execute(
        db,
      );
      return result.rows.map((row) => row.id);
    },

    async count(meta: ModelMeta, where: DomainNode): Promise<number> {
      const compiler = new LocalDomainCompiler(registry);
      const alias = compiler.root();
      const predicate = compiler.compile(meta, alias, where);
      // Some SQLite builds return 64-bit integers as bigint.
      const result = await sql<{
        n: number | bigint;
      }>`select count(*) as n from ${table(meta)} as ${sql.id(alias)} where ${predicate}`.execute(
        db,
      );
      return Number(result.rows[0]?.n ?? 0);
    },

    async read(
      meta: ModelMeta,
      ids: readonly string[],
      fields: readonly string[],
    ): Promise<ReadonlyMap<string, StoredValues>> {
      const wanted = [...new Set(ids.filter(isRecordId))];
      const result = new Map<string, Record<string, unknown>>();
      if (wanted.length === 0) return result;
      const columns: [string, FieldDefinition][] = [];
      const relations: [string, FieldDefinition][] = [];
      for (const field of fields) {
        const definition = definitionOf(meta, field);
        if (definition.type === 'many2many') relations.push([field, definition]);
        else if (isStoredColumn(definition)) columns.push([field, definition]);
        else throw new LocalSchemaError(`"${meta.name}.${field}" is not stored.`);
      }
      const selected = [
        sql`id`,
        ...columns.map(([field]) => sql`${sql.ref(columnName(field))} as ${sql.id(field)}`),
      ];
      for (let start = 0; start < wanted.length; start += MAX_PARAMETERS) {
        const chunk = wanted.slice(start, start + MAX_PARAMETERS);
        const rows = await sql<
          Record<string, SqliteValue>
        >`select ${sql.join(selected)} from ${table(meta)} where id in (${sql.join(chunk)})`.execute(
          db,
        );
        for (const row of rows.rows) {
          const values: Record<string, unknown> = {};
          for (const [field, definition] of columns) {
            values[field] = decodeValue(valueKind(definition), row[field] ?? null);
          }
          for (const [field] of relations) values[field] = [];
          result.set(row.id as string, values);
        }
      }
      for (const [field, definition] of relations) {
        const rel = sql.table(relationTable(meta, field, definition));
        const found = [...result.keys()];
        for (let start = 0; start < found.length; start += MAX_PARAMETERS) {
          const chunk = found.slice(start, start + MAX_PARAMETERS);
          const links = await sql<{
            source_id: string;
            target_id: string;
          }>`select source_id, target_id from ${rel} where source_id in (${sql.join(chunk)}) order by source_id, position`.execute(
            db,
          );
          for (const link of links.rows)
            (result.get(link.source_id)?.[field] as string[] | undefined)?.push(link.target_id);
        }
      }
      return result;
    },

    async insert(
      meta: ModelMeta,
      rows: readonly { readonly id: string; readonly values: StoredValues }[],
    ): Promise<void> {
      await guarded(meta, async () => {
        for (const row of rows) {
          const columns = columnsOf(meta, row.values).filter(([field]) => field !== 'id');
          const names = [sql.id('id'), ...columns.map(([field]) => sql.id(columnName(field)))];
          const values = [
            sql`${row.id}`,
            ...columns.map(([field, definition]) => sql`${encode(definition, row.values[field])}`),
          ];
          await sql`insert into ${table(meta)} (${sql.join(names)}) values (${sql.join(values)})`.execute(
            db,
          );
        }
        await writeRelations(meta, rows, false);
      });
    },

    async update(meta: ModelMeta, id: string, values: StoredValues): Promise<void> {
      const columns = columnsOf(meta, values);
      const missing = new ValidationError(`Record ${id} of "${meta.name}" does not exist.`);
      await guarded(meta, async () => {
        if (columns.length > 0) {
          const assignments = columns.map(
            ([field, definition]) =>
              sql`${sql.id(columnName(field))} = ${encode(definition, values[field])}`,
          );
          const result =
            await sql`update ${table(meta)} set ${sql.join(assignments)} where id = ${id}`.execute(
              db,
            );
          if (result.numAffectedRows === 0n) throw missing;
        } else {
          const found = await sql`select 1 from ${table(meta)} where id = ${id}`.execute(db);
          if (found.rows.length === 0) throw missing;
        }
        await writeRelations(meta, [{ id, values }], true);
      });
    },

    async delete(meta: ModelMeta, ids: readonly string[]): Promise<void> {
      const wanted = [...new Set(ids)];
      if (wanted.length === 0) return;
      await sql`delete from ${table(meta)} where id in (${sql.join(wanted)})`.execute(db);
      // No foreign keys locally: remove the relation rows on both sides by hand.
      for (const name of registry.names()) {
        const other = registry.get(name);
        if (other.abstract) continue;
        for (const [field, definition] of other.fields) {
          if (definition.type !== 'many2many') continue;
          const rel = sql.table(relationTable(other, field, definition));
          if (other.name === meta.name)
            await sql`delete from ${rel} where source_id in (${sql.join(wanted)})`.execute(db);
          if (definition.comodel === meta.name)
            await sql`delete from ${rel} where target_id in (${sql.join(wanted)})`.execute(db);
        }
      }
    },
  };
}
