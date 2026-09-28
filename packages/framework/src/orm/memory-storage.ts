// SPDX-License-Identifier: LGPL-3.0-only
import { matchesCondition, type DomainNode, type DomainOperator } from './domain.js';
import { ValidationError } from './errors.js';
import type { ModelMeta, ModelRegistry, OrderTerm } from './model-registry.js';
import type { SearchOptions, Storage, StoredValues } from './storage.js';

type Row = Record<string, unknown>;

/** Deep copy of normalized (JSON-compatible) values, so callers never share mutable state. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function copy<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

const NEGATIVE: Partial<Record<DomainOperator, DomainOperator>> = {
  '!=': '=',
  'not in': 'in',
  'not like': 'like',
  'not ilike': 'ilike',
};

/**
 * The in-memory reference storage: same contract as the SQL adapters, used by tests and as
 * the executable specification of domain semantics.
 * @public
 */
export interface MemoryStorage extends Storage {
  /** Runs `work`; on failure every change made meanwhile is rolled back. */
  transaction<T>(work: () => Promise<T>): Promise<T>;
  /** Number of rows of a model (test helper). */
  size(model: string): number;
}

/**
 * Creates an empty in-memory storage for the models of a registry.
 * @public
 */
export function createMemoryStorage(registry: ModelRegistry): MemoryStorage {
  let tables = new Map<string, Map<string, Row>>();

  const table = (model: string): Map<string, Row> => {
    let rows = tables.get(model);
    if (!rows) {
      rows = new Map();
      tables.set(model, rows);
    }
    return rows;
  };

  /** Values reached by following `path` from a row (several when crossing x2many fields). */
  const values = (model: string, row: Row, path: readonly string[]): unknown[] => {
    const [step = '', ...rest] = path;
    if (step === 'id') return [row.id];
    const definition = registry.field(model, step);
    if (!definition) return [null];
    let value: unknown;
    if (definition.type === 'one2many') {
      const inverse = definition.inverse ?? '';
      value = [...table(definition.comodel ?? '').values()]
        .filter((child) => child[inverse] === row.id)
        .map((child) => child.id);
    } else {
      value = row[step] ?? null;
    }
    // A JSON value is opaque: an array stored in a json field is not a list of related ids.
    if (definition.type === 'json' && Array.isArray(value)) return [{ json: value }];
    if (rest.length === 0) return [value];
    const ids = Array.isArray(value) ? value : value === null ? [] : [value];
    const next = ids
      .map((id) => table(definition.comodel ?? '').get(id as string))
      .filter((r): r is Row => r !== undefined);
    if (next.length === 0) return [null];
    return next.flatMap((r) => values(definition.comodel ?? '', r, rest));
  };

  const evaluate = (model: string, row: Row, node: DomainNode): boolean => {
    switch (node.kind) {
      case 'true':
        return true;
      case 'and':
        return node.children.every((child) => evaluate(model, row, child));
      case 'or':
        return node.children.some((child) => evaluate(model, row, child));
      case 'not':
        return !evaluate(model, row, node.child);
      case 'condition': {
        const found = values(model, row, node.path);
        const positive = NEGATIVE[node.operator];
        if (positive) return !found.some((v) => matchesCondition(v, positive, node.value));
        return found.some((v) => matchesCondition(v, node.operator, node.value));
      }
    }
  };

  const compare = (meta: ModelMeta, a: Row, b: Row, order: readonly OrderTerm[]): number => {
    for (const { field, direction } of order) {
      const x = a[field] ?? null;
      const y = b[field] ?? null;
      if (x === y) continue;
      let result: number;
      if (x === null) result = 1;
      else if (y === null) result = -1;
      else if (typeof x === 'number' && typeof y === 'number') result = x - y;
      // Decimals are strings: order them by value ("9" before "10"; "1.5" and "1.50" tie).
      else if (meta.fields.get(field)?.type === 'decimal')
        result = Math.sign(Number(x) - Number(y));
      else result = asText(x) < asText(y) ? -1 : 1;
      if (result === 0) continue;
      return direction === 'asc' ? result : -result;
    }
    return String(a.id) < String(b.id) ? -1 : 1;
  };

  const checkUnique = (meta: ModelMeta, id: string, row: Row): void => {
    for (const constraint of meta.unique) {
      const key = constraint.fields.map((field) => row[field] ?? null);
      if (key.some((value) => value === null)) continue;
      for (const [otherId, other] of table(meta.name)) {
        if (otherId !== id && constraint.fields.every((field, i) => other[field] === key[i])) {
          throw new ValidationError(`Uniqueness "${constraint.name}" violated on "${meta.name}".`);
        }
      }
    }
  };

  const clone = (source: Map<string, Map<string, Row>>): Map<string, Map<string, Row>> =>
    new Map(
      [...source].map(([model, rows]) => [
        model,
        new Map([...rows].map(([id, row]) => [id, copy(row)])),
      ]),
    );

  return {
    search(meta: ModelMeta, where: DomainNode, options: SearchOptions): Promise<string[]> {
      const rows = [...table(meta.name).values()].filter((row) => evaluate(meta.name, row, where));
      rows.sort((a, b) => compare(meta, a, b, options.order ?? meta.order));
      const start = options.offset ?? 0;
      const end = options.limit === undefined ? undefined : start + options.limit;
      return Promise.resolve(rows.slice(start, end).map((row) => row.id as string));
    },
    count(meta: ModelMeta, where: DomainNode): Promise<number> {
      return Promise.resolve(
        [...table(meta.name).values()].filter((row) => evaluate(meta.name, row, where)).length,
      );
    },
    read(
      meta: ModelMeta,
      ids: readonly string[],
      fields: readonly string[],
    ): Promise<ReadonlyMap<string, StoredValues>> {
      const result = new Map<string, StoredValues>();
      for (const id of ids) {
        const row = table(meta.name).get(id);
        if (row)
          result.set(
            id,
            Object.fromEntries(fields.map((field) => [field, copy(row[field] ?? null)])),
          );
      }
      return Promise.resolve(result);
    },
    insert(
      meta: ModelMeta,
      rows: readonly { readonly id: string; readonly values: StoredValues }[],
    ): Promise<void> {
      for (const { id, values: stored } of rows) {
        if (table(meta.name).has(id))
          return Promise.reject(new ValidationError(`Duplicate id ${id} in "${meta.name}".`));
        const row = { ...copy(stored), id };
        checkUnique(meta, id, row);
        table(meta.name).set(id, row);
      }
      return Promise.resolve();
    },
    update(meta: ModelMeta, id: string, stored: StoredValues): Promise<void> {
      const row = table(meta.name).get(id);
      if (!row)
        return Promise.reject(
          new ValidationError(`Record ${id} of "${meta.name}" does not exist.`),
        );
      const next = { ...row, ...copy(stored) };
      checkUnique(meta, id, next);
      table(meta.name).set(id, next);
      return Promise.resolve();
    },
    delete(meta: ModelMeta, ids: readonly string[]): Promise<void> {
      for (const id of ids) table(meta.name).delete(id);
      // Remove the ids from many2many columns pointing to this model.
      for (const model of registry.names()) {
        for (const [field, definition] of registry.get(model).fields) {
          if (definition.type !== 'many2many' || definition.comodel !== meta.name) continue;
          for (const row of table(model).values()) {
            const current = row[field];
            if (Array.isArray(current))
              row[field] = current.filter((value) => !ids.includes(value as string));
          }
        }
      }
      return Promise.resolve();
    },
    async transaction<T>(work: () => Promise<T>): Promise<T> {
      const snapshot = clone(tables);
      try {
        return await work();
      } catch (error) {
        tables = snapshot;
        throw error;
      }
    },
    size(model: string): number {
      return table(model).size;
    },
  };
}
