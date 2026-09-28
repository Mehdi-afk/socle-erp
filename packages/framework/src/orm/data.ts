// SPDX-License-Identifier: LGPL-3.0-only
//
// Module data (ARCHITECTURE.md §3.3 `data/`, Odoo's data files): records a module ships and the
// installation loads, each with a stable external id (`module.name`), so that upgrades update
// them instead of duplicating them and other modules can reference them (`ref('base.fr')`).
import { ModelDefinitionError } from './model.js';

/**
 * A reference to a record by its external id, resolved at loading time.
 * @public
 */
export interface ExternalRef {
  readonly $ref: string;
}

/**
 * One record of a data file: `id` is local to the module (the external id is `module.id`).
 * Relational values may be {@link ExternalRef} (many2one) or arrays of them (many2many).
 * @public
 */
export interface DataRecord {
  readonly id: string;
  readonly values: Readonly<Record<string, unknown>>;
}

/**
 * The records of one model in a data file.
 * @public
 */
export interface ModuleData {
  readonly kind: 'data';
  readonly model: string;
  readonly records: readonly DataRecord[];
  /**
   * Created once, never overwritten by an upgrade (values the administrator is expected to
   * change, e.g. the default company).
   */
  readonly noupdate: boolean;
}

const LOCAL_ID = /^[a-z][a-z0-9_]{0,127}$/;
const EXTERNAL_ID = /^[a-z][a-z0-9_]{0,63}\.[a-z][a-z0-9_]{0,127}$/;

/**
 * True for a well-formed external id `module.name`.
 * @public
 */
export function isExternalId(value: string): boolean {
  return EXTERNAL_ID.test(value);
}

/**
 * A reference to the record with external id `externalId` (e.g. `base.fr`).
 * @public
 */
export function ref(externalId: string): ExternalRef {
  if (!isExternalId(externalId)) {
    throw new ModelDefinitionError(`Invalid external id "${externalId}" (expected "module.name").`);
  }
  return Object.freeze({ $ref: externalId });
}

/**
 * True for a value built by {@link ref}.
 * @public
 */
export function isExternalRef(value: unknown): value is ExternalRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { $ref?: unknown }).$ref === 'string'
  );
}

/**
 * Declares records of `model` that the module loads at installation and keeps up to date.
 * @public
 */
export function defineData(
  model: string,
  records: readonly DataRecord[],
  options: { readonly noupdate?: boolean } = {},
): ModuleData {
  const seen = new Set<string>();
  for (const record of records) {
    if (!LOCAL_ID.test(record.id)) {
      throw new ModelDefinitionError(
        `Invalid data id "${record.id}" for "${model}" (lowercase snake_case).`,
      );
    }
    if (seen.has(record.id)) {
      throw new ModelDefinitionError(`Data id "${record.id}" is declared twice for "${model}".`);
    }
    seen.add(record.id);
  }
  return Object.freeze({
    kind: 'data',
    model,
    records: Object.freeze(records.map((record) => Object.freeze({ ...record }))),
    noupdate: options.noupdate === true,
  });
}
