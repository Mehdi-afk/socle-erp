// SPDX-License-Identifier: LGPL-3.0-only
import type { LocalizedText } from '../registry/manifest.js';
import { isRelational, isStoredColumn, type FieldDefinition } from './fields.js';
import {
  ModelDefinitionError,
  TECHNICAL_FIELDS,
  type ConflictPolicy,
  type MethodsFactory,
  type ModelConstraint,
  type ModelDefinition,
  type ModelExtension,
  type RecordsetConstructor,
  type UniqueConstraint,
} from './model.js';
import { composeRecordClass, RECORDSET_MEMBERS } from './recordset.js';

/**
 * Where the ORM runs: server methods are only available on the server; on the client they
 * become stubs that queue an intent for the next synchronisation.
 * @public
 */
export type RuntimeSide = 'server' | 'client';

/** @public */
export interface OrderTerm {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

/**
 * The fully composed description of a model, once every installed module has been applied.
 * @public
 */
export interface ModelMeta {
  readonly name: string;
  /** SQL table name (dots replaced by underscores). */
  readonly table: string;
  readonly abstract: boolean;
  readonly description?: LocalizedText | undefined;
  /** Every field, technical fields included. */
  readonly fields: ReadonlyMap<string, FieldDefinition>;
  readonly order: readonly OrderTerm[];
  readonly constraints: readonly ModelConstraint[];
  readonly unique: readonly UniqueConstraint[];
  /** Delegation: parent model → many2one field. */
  readonly delegations: ReadonlyMap<string, string>;
  /** Fields exposed through delegation: field → many2one field holding the parent. */
  readonly delegatedFields: ReadonlyMap<string, string>;
  /**
   * Every abstract model mixed in, directly or through a parent or another mixin
   * (e.g. `company.scoped`): record rules declared on them apply to this model.
   */
  readonly mixins: readonly string[];
  readonly offline: { readonly conflict: ConflictPolicy; readonly syncable: boolean };
  /** Modules that define or extend the model, in load order. */
  readonly modules: readonly string[];
  /** Names of the server methods (stubs on the client). */
  readonly serverMethodNames: readonly string[];
  /** The composed record class. */
  readonly recordClass: RecordsetConstructor;
}

/**
 * All composed models of a database, for one runtime side.
 * @public
 */
export interface ModelRegistry {
  readonly side: RuntimeSide;
  has(model: string): boolean;
  /** @throws {@link ModelDefinitionError} for an unknown model */
  get(model: string): ModelMeta;
  names(): readonly string[];
  /** Field resolver for domains. */
  field(model: string, field: string): FieldDefinition | undefined;
}

/**
 * The models contributed by one module (`models/*.ts` files of the module).
 * @public
 */
export interface ModuleModels {
  readonly module: string;
  readonly models: readonly (ModelDefinition | ModelExtension)[];
}

const TECHNICAL_DEFINITIONS: ReadonlyMap<string, FieldDefinition> = new Map<
  string,
  FieldDefinition
>([
  ['id', Object.freeze({ type: 'char', readonly: true, required: true })],
  ['createdAt', Object.freeze({ type: 'datetime', readonly: true })],
  ['createdBy', Object.freeze({ type: 'char', readonly: true })],
  ['updatedAt', Object.freeze({ type: 'datetime', readonly: true })],
  ['updatedBy', Object.freeze({ type: 'char', readonly: true })],
  ['version', Object.freeze({ type: 'integer', readonly: true })],
  ['deletedAt', Object.freeze({ type: 'datetime', readonly: true })],
  ['originDevice', Object.freeze({ type: 'char', readonly: true })],
]);

interface Draft {
  definition: ModelDefinition;
  module: string;
  extensions: { extension: ModelExtension; module: string }[];
}

interface Built {
  readonly meta: ModelMeta;
  /** Fields without technical fields, with the module that introduced each one. */
  readonly ownFields: ReadonlyMap<string, { definition: FieldDefinition; module: string }>;
  readonly factories: readonly MethodsFactory[];
  readonly isomorphicFactories: readonly MethodsFactory[];
  readonly serverFactories: readonly MethodsFactory[];
  readonly constraints: readonly ModelConstraint[];
  readonly unique: readonly UniqueConstraint[];
}

/**
 * Builds the model registry from the models of the installed modules, given in dependency
 * order (see `resolveInstallation`): definitions, then extensions applied in module order;
 * prototype inheritance and mixins propagate to child models; delegation exposes parent
 * fields. Every reference (comodels, inverses, related paths, compute methods, depends,
 * constraints, order) is validated.
 * @throws {@link ModelDefinitionError}
 * @public
 */
export function buildModelRegistry(
  modules: readonly ModuleModels[],
  options: { readonly side: RuntimeSide },
): ModelRegistry {
  const drafts = new Map<string, Draft>();
  for (const { module, models } of modules) {
    for (const item of models) {
      if (item.kind === 'define') {
        const existing = drafts.get(item.name);
        if (existing) {
          throw new ModelDefinitionError(
            `Model "${item.name}" is defined by both "${existing.module}" and "${module}"; use extendModel.`,
          );
        }
        drafts.set(item.name, { definition: item, module, extensions: [] });
      } else {
        const target = drafts.get(item.name);
        if (!target) {
          throw new ModelDefinitionError(
            `Module "${module}" extends unknown model "${item.name}" (missing dependency?).`,
          );
        }
        target.extensions.push({ extension: item, module });
      }
    }
  }

  const built = new Map<string, Built>();
  const visiting = new Set<string>();

  const build = (name: string, requiredBy: string): Built => {
    const done = built.get(name);
    if (done) return done;
    const draft = drafts.get(name);
    if (!draft)
      throw new ModelDefinitionError(`Model "${requiredBy}" refers to unknown model "${name}".`);
    if (visiting.has(name)) throw new ModelDefinitionError(`Inheritance cycle through "${name}".`);
    visiting.add(name);
    const result = buildOne(draft, (parent) => build(parent, name), options.side);
    visiting.delete(name);
    built.set(name, result);
    return result;
  };

  for (const name of drafts.keys()) build(name, name);

  const metas = new Map<string, ModelMeta>([...built].map(([name, b]) => [name, b.meta]));
  const registry: ModelRegistry = Object.freeze({
    side: options.side,
    has: (model: string) => metas.has(model),
    get: (model: string) => {
      const meta = metas.get(model);
      if (!meta) throw new ModelDefinitionError(`Unknown model "${model}".`);
      return meta;
    },
    names: () => [...metas.keys()].sort(),
    field: (model: string, field: string) => metas.get(model)?.fields.get(field),
  });

  for (const b of built.values()) validate(b, registry);
  return registry;
}

function mergeField(
  model: string,
  fields: Map<string, { definition: FieldDefinition; module: string }>,
  name: string,
  definition: FieldDefinition,
  module: string,
): void {
  const existing = fields.get(name);
  if (!existing) {
    fields.set(name, { definition, module });
    return;
  }
  const a = existing.definition;
  if (a.type !== definition.type || a.comodel !== definition.comodel) {
    throw new ModelDefinitionError(
      `Field "${model}.${name}" is ${a.type}${a.comodel ? `(${a.comodel})` : ''} in "${existing.module}" ` +
        `but ${definition.type}${definition.comodel ? `(${definition.comodel})` : ''} in "${module}".`,
    );
  }
  fields.set(name, { definition: Object.freeze({ ...a, ...definition }), module });
}

function buildOne(draft: Draft, parent: (name: string) => Built, side: RuntimeSide): Built {
  const { definition, module } = draft;
  const name = definition.name;
  const fields = new Map<string, { definition: FieldDefinition; module: string }>();
  const factories: MethodsFactory[] = [];
  const isomorphicFactories: MethodsFactory[] = [];
  const serverFactories: MethodsFactory[] = [];
  const constraints: ModelConstraint[] = [];
  const unique: UniqueConstraint[] = [];
  const modules = [module];
  const mixins: string[] = [];

  const absorb = (parentName: string): void => {
    const p = parent(parentName);
    for (const mixin of [...(p.meta.abstract ? [parentName] : []), ...p.meta.mixins]) {
      if (!mixins.includes(mixin)) mixins.push(mixin);
    }
    for (const [fieldName, entry] of p.ownFields)
      mergeField(name, fields, fieldName, entry.definition, entry.module);
    for (const factory of p.factories) if (!factories.includes(factory)) factories.push(factory);
    for (const factory of p.isomorphicFactories) {
      if (!isomorphicFactories.includes(factory)) isomorphicFactories.push(factory);
    }
    for (const factory of p.serverFactories)
      if (!serverFactories.includes(factory)) serverFactories.push(factory);
    constraints.push(...p.constraints);
    unique.push(...p.unique);
  };

  const addOwn = (
    own: {
      fields?: Readonly<Record<string, FieldDefinition>> | undefined;
      methods?: MethodsFactory | undefined;
      serverMethods?: MethodsFactory | undefined;
      constraints?: readonly ModelConstraint[] | undefined;
      unique?: readonly UniqueConstraint[] | undefined;
    },
    from: string,
  ): void => {
    for (const [fieldName, fieldDefinition] of Object.entries(own.fields ?? {})) {
      mergeField(name, fields, fieldName, fieldDefinition, from);
    }
    if (own.methods) {
      factories.push(own.methods);
      isomorphicFactories.push(own.methods);
    }
    if (own.serverMethods) {
      serverFactories.push(own.serverMethods);
      if (side === 'server') factories.push(own.serverMethods);
    }
    constraints.push(...(own.constraints ?? []));
    unique.push(...(own.unique ?? []));
  };

  if (definition.inherit !== undefined) {
    const p = parent(definition.inherit);
    if (p.meta.abstract) {
      throw new ModelDefinitionError(
        `"${name}" inherits abstract "${definition.inherit}": use mixins.`,
      );
    }
    absorb(definition.inherit);
  }
  for (const mixin of definition.mixins ?? []) {
    if (!parent(mixin).meta.abstract) {
      throw new ModelDefinitionError(
        `"${name}" uses "${mixin}" as a mixin, but it is not abstract.`,
      );
    }
    absorb(mixin);
  }
  addOwn(definition, module);
  for (const { extension, module: from } of draft.extensions) {
    for (const mixin of extension.mixins ?? []) {
      if (!parent(mixin).meta.abstract) {
        throw new ModelDefinitionError(
          `"${from}" mixes "${mixin}" into "${name}", but it is not abstract.`,
        );
      }
      absorb(mixin);
    }
    addOwn(extension, from);
    if (!modules.includes(from)) modules.push(from);
  }

  // Delegation: a many2one to the parent, and the parent's fields exposed as related fields.
  const delegations = new Map<string, string>();
  const delegatedFields = new Map<string, string>();
  for (const [parentName, via] of Object.entries(definition.inherits ?? {})) {
    const p = parent(parentName);
    if (p.meta.abstract)
      throw new ModelDefinitionError(`"${name}" cannot delegate to abstract "${parentName}".`);
    const link = fields.get(via);
    if (link && (link.definition.type !== 'many2one' || link.definition.comodel !== parentName)) {
      throw new ModelDefinitionError(`"${name}.${via}" must be a many2one to "${parentName}".`);
    }
    if (!link) {
      fields.set(via, {
        definition: Object.freeze({
          type: 'many2one',
          comodel: parentName,
          required: true,
          ondelete: 'cascade',
        }),
        module,
      });
    }
    delegations.set(parentName, via);
    for (const [fieldName, entry] of p.ownFields) {
      if (fields.has(fieldName)) continue;
      // The child reads and writes the parent's value: drop computation, storage and default.
      const exposed = Object.fromEntries(
        Object.entries(entry.definition).filter(
          ([key]) => !['compute', 'depends', 'store', 'default'].includes(key),
        ),
      ) as unknown as FieldDefinition;
      fields.set(fieldName, {
        definition: Object.freeze({ ...exposed, required: false, related: `${via}.${fieldName}` }),
        module: entry.module,
      });
      delegatedFields.set(fieldName, via);
    }
  }

  const allFields = new Map<string, FieldDefinition>(TECHNICAL_DEFINITIONS);
  for (const [fieldName, entry] of fields) allFields.set(fieldName, entry.definition);

  const serverMethodNames = collectMethodNames(serverFactories);
  const meta: ModelMeta = Object.freeze({
    name,
    table: name.replaceAll('.', '_'),
    abstract: definition.abstract === true,
    description: definition.description,
    fields: allFields,
    order: parseOrder(name, definition.order ?? 'id', allFields),
    constraints: Object.freeze([...constraints]),
    unique: Object.freeze([...unique]),
    delegations,
    delegatedFields,
    mixins: Object.freeze(mixins),
    offline: Object.freeze({
      conflict: definition.offline?.conflict ?? 'field-lww',
      syncable: definition.offline?.syncable ?? true,
    }),
    modules: Object.freeze(modules),
    serverMethodNames,
    recordClass: composeRecordClass(
      name,
      factories,
      side === 'client' ? serverMethodNames : [],
      [...allFields.keys()].filter((field) => field !== 'id'),
    ),
  });
  return {
    meta,
    ownFields: fields,
    factories,
    isomorphicFactories,
    serverFactories,
    constraints,
    unique,
  };
}

/** Names of the methods declared by server factories (introspected on an empty base). */
function collectMethodNames(factories: readonly MethodsFactory[]): readonly string[] {
  const names = new Set<string>();
  // An empty base (not a Recordset): only the prototype's own method names are read.
  const Empty = function EmptyBase() {
    /* no state */
  } as unknown as RecordsetConstructor;
  for (const factory of factories) {
    const cls = factory(Empty);
    for (const key of Object.getOwnPropertyNames(cls.prototype)) {
      if (key !== 'constructor') names.add(key);
    }
  }
  return Object.freeze([...names].sort());
}

/**
 * Parses an order clause (`'date desc, name'`) against the stored columns of a model.
 * @throws {@link ModelDefinitionError}
 * @public
 */
export function parseOrder(
  model: string,
  order: string,
  fields: ReadonlyMap<string, FieldDefinition>,
): OrderTerm[] {
  return order.split(',').map((part) => {
    const [field = '', direction = 'asc', ...rest] = part.trim().split(/\s+/);
    const definition = fields.get(field);
    if (!definition || !isStoredColumn(definition) || rest.length > 0) {
      throw new ModelDefinitionError(`Invalid order "${order}" on "${model}".`);
    }
    const dir = direction.toLowerCase();
    if (dir !== 'asc' && dir !== 'desc')
      throw new ModelDefinitionError(`Invalid order "${order}" on "${model}".`);
    return { field, direction: dir };
  });
}

function resolvePath(
  registry: ModelRegistry,
  model: string,
  path: string,
): FieldDefinition | undefined {
  let current = model;
  let definition: FieldDefinition | undefined;
  const parts = path.split('.');
  for (const [index, part] of parts.entries()) {
    definition = registry.field(current, part);
    if (!definition) return undefined;
    if (index < parts.length - 1) {
      if (definition.comodel === undefined) return undefined;
      current = definition.comodel;
    }
  }
  return definition;
}

function validate(built: Built, registry: ModelRegistry): void {
  const { meta } = built;
  if (meta.abstract) return;
  const fail = (message: string): never => {
    throw new ModelDefinitionError(`Model "${meta.name}": ${message}`);
  };
  const isomorphic = composeRecordClass(meta.name, built.isomorphicFactories, [])
    .prototype as Record<string, unknown>;
  const composed = meta.recordClass.prototype as Record<string, unknown>;

  for (const [name, definition] of meta.fields) {
    if (name !== 'id' && RECORDSET_MEMBERS.includes(name))
      fail(`field "${name}" clashes with a recordset member`);
    if (!TECHNICAL_FIELDS.includes(name) && typeof isomorphic[name] === 'function') {
      fail(`field "${name}" clashes with a method of the same name`);
    }
    if (isRelational(definition)) {
      const comodel = definition.comodel ?? '';
      if (!registry.has(comodel) || registry.get(comodel).abstract) {
        fail(`field "${name}" targets unknown or abstract model "${comodel}"`);
      }
      if (definition.type === 'one2many') {
        const inverse = registry.field(comodel, definition.inverse ?? '');
        if (inverse?.type !== 'many2one' || inverse.comodel !== meta.name) {
          fail(
            `one2many "${name}": "${comodel}.${String(definition.inverse)}" must be a many2one to "${meta.name}"`,
          );
        }
      }
    }
    if (definition.related !== undefined) {
      const target = resolvePath(registry, meta.name, definition.related);
      if (!target) fail(`related path "${definition.related}" of "${name}" does not resolve`);
      else if (target.type !== definition.type)
        fail(`related field "${name}" must have type ${target.type}`);
    }
    if (definition.compute !== undefined) {
      if (typeof isomorphic[definition.compute] !== 'function') {
        fail(
          typeof composed[definition.compute] === 'function'
            ? `compute method "${definition.compute}" must be an isomorphic method (methods), not a server method`
            : `compute method "${definition.compute}" of "${name}" does not exist`,
        );
      }
      for (const path of definition.depends ?? []) {
        if (!resolvePath(registry, meta.name, path))
          fail(`depends "${path}" of "${name}" does not resolve`);
      }
    }
  }
  for (const constraint of meta.constraints) {
    if (typeof composed[constraint.check] !== 'function')
      fail(`constraint method "${constraint.check}" does not exist`);
    for (const field of constraint.fields)
      if (!meta.fields.has(field)) fail(`constraint field "${field}" does not exist`);
  }
  for (const constraint of meta.unique) {
    for (const field of constraint.fields) {
      const definition = meta.fields.get(field);
      if (!definition || !isStoredColumn(definition))
        fail(`unique "${constraint.name}" uses non-column "${field}"`);
    }
  }
  if (TECHNICAL_FIELDS.some((field) => !meta.fields.has(field)))
    fail('technical fields are missing');
}
