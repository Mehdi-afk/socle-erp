// SPDX-License-Identifier: LGPL-3.0-only
//
// Compile-time typing of records (ARCHITECTURE.md §4.3, ADR 009).
import type { Environment } from './environment.js';
import type { FieldDefinition } from './fields.js';
import type { ModelDefinition } from './model.js';
import type { Recordset } from './recordset.js';

/**
 * Fields of each model, declared ONCE by the module that defines it:
 * `declare module '@socle/framework' { interface ModelFields { 'sale.order': FieldsOf<typeof saleOrder> } }`.
 * @public
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- augmentation point
export interface ModelFields {}

/**
 * Fields added by extensions, keyed by the extending module's name (unique), then by model:
 * `interface ModelExtensions { sale_margin: { 'sale.order': { margin: Money } } }`.
 * @public
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- augmentation point
export interface ModelExtensions {}

/**
 * Money: an integer amount in minor units (cents) — never a float.
 * @public
 */
export type Money = number;

/**
 * Fields that the extensions of every installed module add to model `M` (the intersection of
 * all of them, through contravariant inference; `unknown` when there is none).
 * @public
 */
export type ExtensionFieldsOf<M extends string> = (
  {
    [Module in keyof ModelExtensions]: M extends keyof ModelExtensions[Module]
      ? (fields: ModelExtensions[Module][M]) => void
      : never;
  }[keyof ModelExtensions] extends (fields: infer I) => void
    ? I
    : never
) extends infer All
  ? [All] extends [never]
    ? unknown
    : All
  : never;

/**
 * Every known field of model `M`: its definition plus all its extensions.
 * @public
 */
export type FieldsOfModel<M extends string> = (M extends keyof ModelFields
  ? ModelFields[M]
  : unknown) &
  ExtensionFieldsOf<M>;

/**
 * A recordset of model `M` with its typed fields.
 * @public
 */
export type RecordsetOf<M extends string> = Recordset & FieldsOfModel<M>;

/**
 * The value type of a field definition, as read on a record:
 * boolean → boolean; integer/monetary → number (0 when empty); relational → recordset of the
 * target model; selection → one of its keys or null; json → unknown; others → string or null.
 * @public
 */
export type FieldValue<D> = D extends { readonly type: 'boolean' }
  ? boolean
  : D extends { readonly type: 'integer' | 'monetary' }
    ? number
    : D extends {
          readonly type: 'many2one' | 'one2many' | 'many2many';
          readonly comodel: infer C extends string;
        }
      ? RecordsetOf<C>
      : D extends {
            readonly type: 'selection';
            readonly selection: readonly (readonly [infer K, string])[];
          }
        ? K | null
        : D extends { readonly type: 'json' }
          ? unknown
          : string | null;

/**
 * Typed values of a set of field definitions.
 * @public
 */
export type FieldValues<F> = { -readonly [K in keyof F]: FieldValue<F[K]> };

/**
 * A model definition that remembers its name and fields at compile time.
 * @public
 */
export interface TypedModelDefinition<N extends string, F> extends ModelDefinition {
  readonly name: N;
  /** Phantom property carrying the field types (never set at runtime). */
  readonly fieldTypes?: F;
}

/**
 * The typed fields of a model definition, for `interface ModelFields`.
 * @public
 */
export type FieldsOf<D> = D extends TypedModelDefinition<string, infer F> ? FieldValues<F> : never;

/**
 * The `Base` class given to the `methods` / `serverMethods` factories of model `N` whose own
 * fields are `F`: records expose `F`, plus the fields added by extensions of `N`.
 * @public
 */
export type RecordClass<N extends string, F> = new (
  env: Environment,
  ids: readonly string[],
) => Recordset & FieldValues<F> & ExtensionFieldsOf<N>;

/**
 * The `Base` class given to the factories of an extension of model `N`: every known field of
 * the model (definition and extensions) plus the fields `F` added by this extension.
 * @public
 */
export type ExtensionClass<N extends string, F> = new (
  env: Environment,
  ids: readonly string[],
) => RecordsetOf<N> & FieldValues<F>;

/**
 * Field definitions, for generic constraints.
 * @public
 */
export type FieldDefinitions = Readonly<Record<string, FieldDefinition>>;
