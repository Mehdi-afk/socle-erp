// SPDX-License-Identifier: LGPL-3.0-only
import type { LocalizedText } from '../registry/manifest.js';

/**
 * Every field type of ARCHITECTURE.md §4.6.
 * @public
 */
export type FieldType =
  | 'char'
  | 'text'
  | 'html'
  | 'integer'
  | 'decimal'
  | 'monetary'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'selection'
  | 'many2one'
  | 'one2many'
  | 'many2many'
  | 'binary'
  | 'json'
  | 'reference';

/**
 * Attributes shared by every field type.
 * @public
 */
export interface CommonFieldOptions {
  readonly label?: LocalizedText | undefined;
  readonly help?: LocalizedText | undefined;
  readonly required?: boolean | undefined;
  readonly readonly?: boolean | undefined;
  /** Create a database index on this column. */
  readonly index?: boolean | undefined;
  /** Default value, or the name of a model method returning it. */
  readonly default?: unknown;
  /** Name of the model method that computes the field. */
  readonly compute?: string | undefined;
  /** Field paths the computation depends on (e.g. `lines.priceSubtotal`). */
  readonly depends?: readonly string[] | undefined;
  /** Store a computed field in the database (recomputed when a dependency changes). */
  readonly store?: boolean | undefined;
  /** Path of another field this one mirrors (e.g. `partnerId.countryId`). */
  readonly related?: string | undefined;
  /** Groups allowed to see the field (checked server-side). */
  readonly groups?: readonly string[] | undefined;
  /** Changes are recorded in the chatter. */
  readonly tracking?: boolean | undefined;
  /** Translatable content (char, text, html). */
  readonly translate?: boolean | undefined;
  /** Encrypted at rest, masked in logs, never replicated offline (data classification). */
  readonly sensitive?: boolean | undefined;
  /** `false`: never synchronised to offline clients. */
  readonly offline?: boolean | undefined;
}

/**
 * The definition of a field, as produced by the `f.*` builders.
 * @public
 */
export interface FieldDefinition extends CommonFieldOptions {
  readonly type: FieldType;
  /** Maximum length (char). */
  readonly size?: number | undefined;
  /** Allowed values and their labels (selection). */
  readonly selection?: readonly (readonly [string, string])[] | undefined;
  /** Target model (many2one, one2many, many2many). */
  readonly comodel?: string | undefined;
  /** many2one field of the comodel pointing back (one2many). */
  readonly inverse?: string | undefined;
  /** What happens when the target of a many2one is deleted. */
  readonly ondelete?: 'restrict' | 'cascade' | 'set null' | undefined;
  /** Relation table of a many2many (generated when omitted). */
  readonly relation?: string | undefined;
  /** Total number of digits and decimals (decimal). */
  readonly digits?: readonly [number, number] | undefined;
  /** Name of the many2one field holding the currency (monetary). Default: `currencyId`. */
  readonly currencyField?: string | undefined;
}

/**
 * A field definition whose type is known at compile time (used to type records).
 * @public
 */
export interface TypedField<T extends FieldType> extends FieldDefinition {
  readonly type: T;
}

/**
 * A relational field definition whose target model is known at compile time.
 * @public
 */
export interface RelationalField<
  T extends 'many2one' | 'one2many' | 'many2many',
  C extends string,
> extends TypedField<T> {
  readonly comodel: C;
}

/**
 * A selection field whose allowed keys are known at compile time.
 * @public
 */
export interface SelectionField<K extends string> extends TypedField<'selection'> {
  readonly selection: readonly (readonly [K, string])[];
}

/** @public */
export interface CharOptions extends CommonFieldOptions {
  readonly size?: number | undefined;
}

/** @public */
export interface DecimalOptions extends CommonFieldOptions {
  readonly digits?: readonly [number, number] | undefined;
}

/** @public */
export interface MonetaryOptions extends CommonFieldOptions {
  readonly currencyField?: string | undefined;
}

/** @public */
export interface Many2oneOptions extends CommonFieldOptions {
  readonly ondelete?: 'restrict' | 'cascade' | 'set null' | undefined;
}

/** @public */
export interface Many2manyOptions extends CommonFieldOptions {
  readonly relation?: string | undefined;
}

function field<D extends FieldDefinition>(definition: D): D {
  return Object.freeze(definition);
}

/**
 * Field builders used in `defineModel({ fields: { … } })`.
 * @public
 */
export const f = Object.freeze({
  char: (options: CharOptions = {}): TypedField<'char'> => field({ ...options, type: 'char' }),
  text: (options: CommonFieldOptions = {}): TypedField<'text'> =>
    field({ ...options, type: 'text' }),
  /** HTML content, sanitized with DOMPurify before storage and rendering. */
  html: (options: CommonFieldOptions = {}): TypedField<'html'> =>
    field({ ...options, type: 'html' }),
  integer: (options: CommonFieldOptions = {}): TypedField<'integer'> =>
    field({ ...options, type: 'integer' }),
  /** Exact decimal, stored and exchanged as a string (use decimal.js for arithmetic). */
  decimal: (options: DecimalOptions = {}): TypedField<'decimal'> =>
    field({ ...options, type: 'decimal' }),
  /** Money: an integer in minor units (cents), with the currency in `currencyField`. */
  monetary: (options: MonetaryOptions = {}): TypedField<'monetary'> =>
    field({ ...options, type: 'monetary' }),
  boolean: (options: CommonFieldOptions = {}): TypedField<'boolean'> =>
    field({ ...options, type: 'boolean' }),
  /** Calendar date `YYYY-MM-DD` (no time zone). */
  date: (options: CommonFieldOptions = {}): TypedField<'date'> =>
    field({ ...options, type: 'date' }),
  /** Instant, always stored in UTC. */
  datetime: (options: CommonFieldOptions = {}): TypedField<'datetime'> =>
    field({ ...options, type: 'datetime' }),
  selection: <const K extends string>(
    values: readonly (readonly [K, string])[],
    options: CommonFieldOptions = {},
  ): SelectionField<K> => field({ ...options, type: 'selection', selection: values }),
  many2one: <const C extends string>(
    comodel: C,
    options: Many2oneOptions = {},
  ): RelationalField<'many2one', C> =>
    field({ ondelete: 'set null', ...options, type: 'many2one', comodel }),
  one2many: <const C extends string>(
    comodel: C,
    inverse: string,
    options: CommonFieldOptions = {},
  ): RelationalField<'one2many', C> => field({ ...options, type: 'one2many', comodel, inverse }),
  many2many: <const C extends string>(
    comodel: C,
    options: Many2manyOptions = {},
  ): RelationalField<'many2many', C> => field({ ...options, type: 'many2many', comodel }),
  /** Reference to a stored object (S3 key); the content never lives in the database. */
  binary: (options: CommonFieldOptions = {}): TypedField<'binary'> =>
    field({ ...options, type: 'binary' }),
  json: (options: CommonFieldOptions = {}): TypedField<'json'> =>
    field({ ...options, type: 'json' }),
  /** Dynamic reference `model,id`. */
  reference: (options: CommonFieldOptions = {}): TypedField<'reference'> =>
    field({ ...options, type: 'reference' }),
});

/**
 * Field types whose value lives in the model's own table.
 * @public
 */
export function isStoredColumn(definition: FieldDefinition): boolean {
  if (definition.type === 'one2many' || definition.type === 'many2many') return false;
  if (definition.related !== undefined) return definition.store === true;
  if (definition.compute !== undefined) return definition.store === true;
  return true;
}

/**
 * Relational field types.
 * @public
 */
export function isRelational(definition: FieldDefinition): boolean {
  return (
    definition.type === 'many2one' ||
    definition.type === 'one2many' ||
    definition.type === 'many2many'
  );
}
