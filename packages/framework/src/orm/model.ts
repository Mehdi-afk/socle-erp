// SPDX-License-Identifier: LGPL-3.0-only
import { SocleError } from '../errors.js';
import type { LocalizedText } from '../registry/manifest.js';
import type { Environment } from './environment.js';
import type { FieldDefinition } from './fields.js';
import type { Recordset } from './recordset.js';
import type {
  ExtensionClass,
  FieldDefinitions,
  RecordClass,
  TypedModelDefinition,
} from './typing.js';

/**
 * The constructor of a model's records (see {@link Recordset}); models extend it through
 * `methods` / `serverMethods` factories: `(Base) => class extends Base { … }`.
 * @public
 */
export type RecordsetConstructor = new (env: Environment, ids: readonly string[]) => Recordset;

/**
 * A class factory `(Base) => class extends Base { … }`: the way a model adds or overrides
 * methods while calling `super` (composition `extN(…ext1(Base))`, ARCHITECTURE.md §4.4).
 * @public
 */
export type MethodsFactory = (Base: RecordsetConstructor) => RecordsetConstructor;

/**
 * Conflict policy of a model for offline synchronisation (ARCHITECTURE.md §6.4).
 * @public
 */
export type ConflictPolicy = 'field-lww' | 'server-wins' | 'append-only' | 'manual';

/**
 * A constraint checked after every create or write touching one of its fields: the named
 * method receives the records and throws a {@link ValidationError} when they are invalid.
 * @public
 */
export interface ModelConstraint {
  readonly fields: readonly string[];
  readonly check: string;
}

/**
 * A uniqueness constraint enforced by the storage.
 * @public
 */
export interface UniqueConstraint {
  readonly name: string;
  readonly fields: readonly string[];
  readonly message?: LocalizedText | undefined;
}

/**
 * What a module writes in `defineModel({ … })`.
 * @public
 */
export interface ModelDefinitionInput {
  /** Technical name, dotted lowercase (e.g. `sale.order`). */
  readonly name: string;
  readonly description?: LocalizedText | undefined;
  /** Abstract model (mixin): no table, only used through `mixins`. */
  readonly abstract?: boolean | undefined;
  /** Prototype inheritance: the new model copies the structure and behaviour of this one. */
  readonly inherit?: string | undefined;
  /** Abstract models whose fields and methods are mixed in (e.g. `mail.thread`). */
  readonly mixins?: readonly string[] | undefined;
  /** Delegation: `{ 'res.partner': 'partnerId' }` — the model "has a" partner and exposes its fields. */
  readonly inherits?: Readonly<Record<string, string>> | undefined;
  readonly fields?: Readonly<Record<string, FieldDefinition>> | undefined;
  /** Default sort, e.g. `'date desc, name'`. */
  readonly order?: string | undefined;
  readonly constraints?: readonly ModelConstraint[] | undefined;
  readonly unique?: readonly UniqueConstraint[] | undefined;
  readonly offline?:
    | { readonly conflict?: ConflictPolicy | undefined; readonly syncable?: boolean | undefined }
    | undefined;
  /** Isomorphic methods: run on the server AND offline in the browser. */
  readonly methods?: MethodsFactory | undefined;
  /** Server methods: never run offline; queued as intents and replayed at synchronisation. */
  readonly serverMethods?: MethodsFactory | undefined;
}

/**
 * What a module writes in `extendModel('sale.order', { … })`.
 * @public
 */
export interface ModelExtensionInput {
  readonly mixins?: readonly string[] | undefined;
  readonly fields?: Readonly<Record<string, FieldDefinition>> | undefined;
  readonly constraints?: readonly ModelConstraint[] | undefined;
  readonly unique?: readonly UniqueConstraint[] | undefined;
  readonly methods?: MethodsFactory | undefined;
  readonly serverMethods?: MethodsFactory | undefined;
}

/** @public */
export interface ModelDefinition extends ModelDefinitionInput {
  readonly kind: 'define';
}

/** @public */
export interface ModelExtension extends ModelExtensionInput {
  readonly kind: 'extend';
  readonly name: string;
}

/**
 * A model definition is invalid, or the registry cannot be built from the definitions.
 * @public
 */
export class ModelDefinitionError extends SocleError {
  constructor(message: string) {
    super('orm.model_definition', message);
  }
}

const MODEL_NAME_SEGMENT = /^[a-z][a-z0-9_]*$/;
const FIELD_NAME = /^[a-z][A-Za-z0-9]*$/;

/**
 * Technical fields added by the ORM to every model; modules may not define them.
 * @public
 */
export const TECHNICAL_FIELDS: readonly string[] = Object.freeze([
  'id',
  'createdAt',
  'createdBy',
  'updatedAt',
  'updatedBy',
  'version',
  'deletedAt',
  'originDevice',
]);

function checkFields(
  model: string,
  fields: Readonly<Record<string, FieldDefinition>> | undefined,
): void {
  for (const name of Object.keys(fields ?? {})) {
    if (!FIELD_NAME.test(name)) {
      throw new ModelDefinitionError(`Field "${name}" of "${model}" must be camelCase.`);
    }
    if (TECHNICAL_FIELDS.includes(name)) {
      throw new ModelDefinitionError(`Field "${name}" of "${model}" is reserved by the ORM.`);
    }
  }
}

function checkModelName(name: string): void {
  if (name.length > 63 || !name.split('.').every((segment) => MODEL_NAME_SEGMENT.test(segment))) {
    throw new ModelDefinitionError(`Invalid model name "${name}" (expected e.g. "sale.order").`);
  }
}

/**
 * What `defineModel` accepts: the fields `F` are inferred, and the `Base` class of `methods` /
 * `serverMethods` exposes them with their types.
 * @public
 */
export interface TypedModelInput<N extends string, F extends FieldDefinitions> extends Omit<
  ModelDefinitionInput,
  'name' | 'fields' | 'methods' | 'serverMethods'
> {
  readonly name: N;
  readonly fields?: F | undefined;
  readonly methods?: ((Base: RecordClass<N, F>) => RecordsetConstructor) | undefined;
  readonly serverMethods?: ((Base: RecordClass<N, F>) => RecordsetConstructor) | undefined;
}

/**
 * What `extendModel` accepts: the `Base` class exposes every known field of the model plus the
 * fields `F` added by the extension.
 * @public
 */
export interface TypedExtensionInput<N extends string, F extends FieldDefinitions> extends Omit<
  ModelExtensionInput,
  'fields' | 'methods' | 'serverMethods'
> {
  readonly fields?: F | undefined;
  readonly methods?: ((Base: ExtensionClass<N, F>) => RecordsetConstructor) | undefined;
  readonly serverMethods?: ((Base: ExtensionClass<N, F>) => RecordsetConstructor) | undefined;
}

/**
 * Declares a new model.
 * @public
 */
export function defineModel<
  const N extends string,
  // eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type -- no fields by default
  const F extends FieldDefinitions = Record<never, never>,
>(input: TypedModelInput<N, F>): TypedModelDefinition<N, F> {
  checkModelName(input.name);
  checkFields(input.name, input.fields);
  if (input.abstract && (input.inherit !== undefined || input.inherits !== undefined)) {
    throw new ModelDefinitionError(`Abstract model "${input.name}" can only use mixins.`);
  }
  return Object.freeze({ ...(input as ModelDefinitionInput), name: input.name, kind: 'define' });
}

/**
 * Extends an existing model from another module: adds fields, constraints and mixins, and
 * overrides methods while reusing the original behaviour through `super`.
 * @public
 */
export function extendModel<
  const N extends string,
  // eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type -- no fields by default
  const F extends FieldDefinitions = Record<never, never>,
>(name: N, input: TypedExtensionInput<N, F>): ModelExtension {
  checkModelName(name);
  checkFields(name, input.fields);
  return Object.freeze({ ...(input as ModelExtensionInput), kind: 'extend', name });
}
