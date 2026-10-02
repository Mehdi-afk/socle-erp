// SPDX-License-Identifier: LGPL-3.0-only
//
// Names of the records that relations point to, and currencies of monetary values: asked from the
// data source in batches, once per record, and kept. A list of thousands of contacts asks for each
// country once, not once per row.
import { useMemo, useSyncExternalStore } from 'react';

import type { Currency } from './format.js';
import type { RecordValues, ViewContext } from './types.js';

export interface Lookups {
  /** Grows every time something arrived: rows that were memoised draw again. */
  readonly version: number;
  /** The display name of a related record, once known. */
  readonly nameOf: (model: string, id: unknown) => string | undefined;
  /** The currency of a monetary value, once known. */
  readonly currencyOf: (id: unknown) => Currency | undefined;
  /** Asks for whatever the given fields of these records point to and is not known yet. */
  readonly ensure: (
    model: string,
    records: readonly RecordValues[],
    fields: readonly string[],
  ) => Promise<void>;
}

const CURRENCY_MODEL = 'res.currency';

/** Each source/registry pair owns its cache, pending requests and change notifications. */
function lookupCache(data: ViewContext['data'], registry: ViewContext['registry']) {
  const names = new Map<string, string>();
  const currencies = new Map<string, Currency>();
  const loaded = new Set<string>();
  const pending = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  let version = 0;

  const ensure: Lookups['ensure'] = async (model, records, fields) => {
    const meta = registry.get(model);
    const wanted = new Map<string, Set<string>>();
    const waiting = new Set<Promise<void>>();
    const want = (target: string, id: unknown): void => {
      if (typeof id !== 'string') return;
      const key = `${target}:${id}`;
      if (loaded.has(key)) return;
      const request = pending.get(key);
      if (request) {
        waiting.add(request);
        return;
      }
      let ids = wanted.get(target);
      if (!ids) wanted.set(target, (ids = new Set()));
      ids.add(id);
    };
    for (const name of fields) {
      const definition = meta.fields.get(name);
      if (!definition) continue;
      if (definition.type === 'many2one' && definition.comodel !== undefined) {
        for (const record of records) want(definition.comodel, record[name]);
      } else if (definition.type === 'monetary') {
        const currencyField = definition.currencyField ?? 'currencyId';
        for (const record of records) want(CURRENCY_MODEL, record[currencyField]);
      }
    }
    for (const [target, ids] of wanted) {
      const list = [...ids];
      // Register the promise before invoking an adapter, which might throw synchronously.
      const request = Promise.resolve()
        .then(async () => {
          const [rows, displayNames] = await Promise.all([
            target === CURRENCY_MODEL ? data.read(target, list, ['code', 'decimals']) : [],
            data.displayNames(target, list),
          ]);
          // Publish a complete batch only: a failed name request must remain retryable too.
          for (const row of rows) {
            if (typeof row.code === 'string') {
              currencies.set(row.id, {
                code: row.code,
                decimals: typeof row.decimals === 'number' ? row.decimals : 2,
              });
            }
          }
          for (const [id, name] of displayNames) {
            names.set(`${target}:${id}`, name);
          }
          for (const id of ids) loaded.add(`${target}:${id}`);
          version += 1;
          for (const listener of listeners) listener();
        })
        .finally(() => {
          for (const id of ids) pending.delete(`${target}:${id}`);
        });
      for (const id of ids) pending.set(`${target}:${id}`, request);
      waiting.add(request);
    }
    await Promise.all(waiting);
  };

  const nameOf: Lookups['nameOf'] = (model, id) =>
    typeof id === 'string' ? names.get(`${model}:${id}`) : undefined;
  const currencyOf: Lookups['currencyOf'] = (id) =>
    typeof id === 'string' ? currencies.get(id) : undefined;
  return {
    nameOf,
    currencyOf,
    ensure,
    getVersion: () => version,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function useLookups(context: ViewContext): Lookups {
  const cache = useMemo(
    () => lookupCache(context.data, context.registry),
    [context.data, context.registry],
  );
  const version = useSyncExternalStore(cache.subscribe, cache.getVersion, cache.getVersion);
  return { version, nameOf: cache.nameOf, currencyOf: cache.currencyOf, ensure: cache.ensure };
}
