// SPDX-License-Identifier: LGPL-3.0-only
//
// A data source over lists in memory: for the tests of the engine, the style guide and the first
// screens of the web client before it is connected to the server. It sorts and pages like the
// server does; its domains understand `=`, `!=` and `ilike` on plain fields.
import type { DataSource, RecordValues, SearchOptions } from './types.js';

export interface MemoryDataSource extends DataSource {
  /** How many `search` calls were made (to check that a list loads only what it shows). */
  readonly searches: readonly SearchOptions[];
  /** Replaces the records of a model. */
  set(model: string, records: readonly RecordValues[]): void;
}

const asText = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
      ? String(value)
      : '';

const compare = (a: unknown, b: unknown): number => {
  if (a === b) return 0;
  // Missing values sort last, as PostgreSQL does for an ascending order.
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return asText(a).localeCompare(asText(b), 'en', { sensitivity: 'base', numeric: true });
};

function matches(record: RecordValues, domain: readonly unknown[] | undefined): boolean {
  return (domain ?? []).every((term) => {
    if (!Array.isArray(term) || term.length !== 3) return true;
    const [field, operator, expected] = term as [string, string, unknown];
    const value = record[field];
    if (operator === '=') return value === expected;
    if (operator === '!=') return value !== expected;
    if (operator === 'ilike') {
      return asText(value).toLowerCase().includes(asText(expected).toLowerCase());
    }
    return true;
  });
}

/** `city, name desc` → sorting terms. */
function terms(order: string | undefined): { field: string; descending: boolean }[] {
  return (order ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const [field = '', direction] = part.split(/\s+/);
      return { field, descending: direction?.toLowerCase() === 'desc' };
    });
}

export function createMemoryDataSource(
  initial: Readonly<Record<string, readonly RecordValues[]>> = {},
  options: { readonly delayMs?: number } = {},
): MemoryDataSource {
  const tables = new Map<string, readonly RecordValues[]>(Object.entries(initial));
  const searches: SearchOptions[] = [];
  const later = async <T>(value: T): Promise<T> => {
    if ((options.delayMs ?? 0) > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    return value;
  };

  return {
    searches,
    set(model, records) {
      tables.set(model, records);
    },
    async search(model, query) {
      searches.push(query);
      const matching = (tables.get(model) ?? []).filter((record) => matches(record, query.domain));
      const order = terms(query.order);
      const sorted =
        order.length === 0
          ? matching
          : [...matching].sort((a, b) => {
              for (const { field, descending } of order) {
                const result = compare(a[field], b[field]);
                if (result !== 0) return descending ? -result : result;
              }
              return 0;
            });
      const page = sorted.slice(query.offset, query.offset + query.limit);
      return later({
        records: page.map((record) => pick(record, query.fields)),
        total: sorted.length,
      });
    },
    async read(model, ids, fields) {
      const wanted = new Set(ids);
      const found = (tables.get(model) ?? []).filter((record) => wanted.has(record.id));
      return later(found.map((record) => pick(record, fields)));
    },
    async displayNames(model, ids) {
      const wanted = new Set(ids);
      const names = new Map<string, string>();
      for (const record of tables.get(model) ?? []) {
        if (wanted.has(record.id)) names.set(record.id, asText(record.name) || record.id);
      }
      return later(names);
    },
  };
}

function pick(record: RecordValues, fields: readonly string[]): RecordValues {
  const values: Record<string, unknown> = { id: record.id };
  for (const field of fields) values[field] = record[field] ?? null;
  return values as RecordValues;
}
