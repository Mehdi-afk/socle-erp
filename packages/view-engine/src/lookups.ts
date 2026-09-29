// SPDX-License-Identifier: LGPL-3.0-only
//
// Names of the records that relations point to, and currencies of monetary values: asked from the
// data source in batches, once per record, and kept. A list of thousands of contacts asks for each
// country once, not once per row.
import { useCallback, useRef, useState } from 'react';

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

export function useLookups(context: ViewContext): Lookups {
  const names = useRef(new Map<string, string>());
  const currencies = useRef(new Map<string, Currency>());
  const asked = useRef(new Set<string>());
  const [version, setVersion] = useState(0);

  const ensure = useCallback<Lookups['ensure']>(
    async (model, records, fields) => {
      const meta = context.registry.get(model);
      const wanted = new Map<string, Set<string>>();
      const want = (target: string, id: unknown): void => {
        if (typeof id !== 'string' || asked.current.has(`${target}:${id}`)) return;
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
      if (wanted.size === 0) return;
      for (const [target, ids] of wanted)
        for (const id of ids) asked.current.add(`${target}:${id}`);
      await Promise.all(
        [...wanted].map(async ([target, ids]) => {
          const list = [...ids];
          if (target === CURRENCY_MODEL) {
            const rows = await context.data.read(CURRENCY_MODEL, list, ['code', 'decimals']);
            for (const row of rows) {
              if (typeof row.code === 'string') {
                currencies.current.set(row.id, {
                  code: row.code,
                  decimals: typeof row.decimals === 'number' ? row.decimals : 2,
                });
              }
            }
          }
          for (const [id, name] of await context.data.displayNames(target, list)) {
            names.current.set(`${target}:${id}`, name);
          }
        }),
      );
      setVersion((version) => version + 1);
    },
    [context],
  );

  const nameOf = useCallback<Lookups['nameOf']>(
    (model, id) => (typeof id === 'string' ? names.current.get(`${model}:${id}`) : undefined),
    [],
  );
  const currencyOf = useCallback<Lookups['currencyOf']>(
    (id) => (typeof id === 'string' ? currencies.current.get(id) : undefined),
    [],
  );
  return { version, nameOf, currencyOf, ensure };
}
