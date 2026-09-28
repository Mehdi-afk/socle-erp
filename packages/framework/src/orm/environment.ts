// SPDX-License-Identifier: LGPL-3.0-only
import { uuidv7 } from '@socle/crypto';

import { andNodes, DomainError, parseDomain, type Domain, type DomainNode } from './domain.js';
import {
  AccessError,
  FieldNotLoadedError,
  MissingRecordError,
  RecordsetError,
  ServerOnlyError,
  ValidationError,
} from './errors.js';
import { isStoredColumn, type FieldDefinition } from './fields.js';
import { TECHNICAL_FIELDS } from './model.js';
import {
  parseOrder,
  type ModelMeta,
  type ModelRegistry,
  type RuntimeSide,
} from './model-registry.js';
import { Recordset, type RecordValues, type SearchParams } from './recordset.js';
import type { Storage } from './storage.js';
import { emptyValue, isRecordId, normalizeValue } from './values.js';

/**
 * Operations checked by access control.
 * @public
 */
export type Operation = 'read' | 'create' | 'write' | 'unlink';

/**
 * Who is acting, in which company and language.
 * @public
 */
export interface UserContext {
  readonly id: string;
  readonly groupIds: readonly string[];
  readonly companyIds: readonly string[];
  readonly companyId: string | null;
  readonly lang: string;
  readonly tz: string;
  /** Device the request comes from (offline clients). */
  readonly deviceId?: string | undefined;
}

/**
 * Access control plugged into the ORM (implemented by the security layer, point 5).
 * Everything is refused unless allowed: `checkModel` throws {@link AccessError}.
 * @public
 */
export interface AccessControl {
  checkModel(env: Environment, model: string, operation: Operation): void;
  /** Record rules as a domain (`{ kind: 'true' }` when none apply). */
  ruleDomain(env: Environment, model: string, operation: Operation): DomainNode;
}

/**
 * An audit event written by the ORM.
 * @public
 */
export interface AuditEvent {
  readonly type: 'sudo';
  readonly userId: string;
  readonly reason: string;
  readonly at: string;
}

/** @public */
export interface AuditSink {
  record(event: AuditEvent): void;
}

/**
 * A server method called on an offline client, to be replayed at synchronisation.
 * @public
 */
export interface ServerCall {
  readonly model: string;
  readonly method: string;
  readonly ids: readonly string[];
  readonly args: readonly unknown[];
}

/** @public */
export interface EnvironmentOptions {
  readonly registry: ModelRegistry;
  readonly storage: Storage;
  readonly user: UserContext;
  readonly access: AccessControl;
  readonly audit: AuditSink;
  /** Current instant, ISO UTC. */
  readonly now?: (() => string) | undefined;
  /** New record identifier (UUIDv7 by default). */
  readonly newId?: (() => string) | undefined;
  /** Client side: queues a server method call as an intent. */
  readonly queueServerCall?: ((call: ServerCall) => Promise<unknown>) | undefined;
}

const ENV_KEY = Symbol('socle.environment');
const MAX_RECOMPUTE_ROUNDS = 25;

type FieldMap = Map<string, unknown>;

interface Change {
  readonly model: string;
  readonly ids: readonly string[];
  readonly fields: readonly string[];
  /** Values before the change (for relational inverses). */
  readonly originals: ReadonlyMap<string, ReadonlyMap<string, unknown>>;
}

interface Trigger {
  readonly model: string;
  readonly field: string;
  readonly path: readonly string[];
  readonly viaInverse: boolean;
}

/** State shared by an environment and its `sudo()` variants (one transaction). */
class TransactionState {
  readonly cache = new Map<string, Map<string, FieldMap>>();
  /** User writes waiting for flush (checked against the user's rights): model → id → fields. */
  readonly dirty = new Map<string, Map<string, Set<string>>>();
  /** Writes made through sudo() (audited, not checked against rights). */
  readonly dirtySu = new Map<string, Map<string, Set<string>>>();
  /** The environment of the actual user, used to check their pending writes. */
  userEnv: Environment | undefined;
  /** Values of computed stored fields assigned by compute methods, waiting to be persisted. */
  readonly computedDirty = new Map<string, Map<string, Set<string>>>();
  /** First value of a modified field (model → id → field → value). */
  readonly originals = new Map<string, Map<string, Map<string, unknown>>>();
  /** Stored computed fields to recompute: `model` → field → ids. */
  readonly pending = new Map<string, Map<string, Set<string>>>();
  readonly computing = new Set<string>();
  readonly deleted = new Set<string>();
}

const runtimes = new WeakMap<Environment, Runtime>();
const triggerCache = new WeakMap<ModelRegistry, Map<string, Map<string, Trigger[]>>>();

/**
 * The context of every ORM operation: registry, user, company, rights and transaction state.
 * Create one per request/transaction with {@link createEnvironment}.
 * @public
 */
export class Environment {
  readonly registry: ModelRegistry;
  readonly user: UserContext;
  /** Superuser mode: access control is bypassed (server only, audited). */
  readonly su: boolean;

  /** @internal */
  constructor(key: symbol, options: EnvironmentOptions, state: unknown, su: boolean) {
    if (key !== ENV_KEY) throw new TypeError('Use createEnvironment().');
    this.registry = options.registry;
    this.user = options.user;
    this.su = su;
    runtimes.set(this, new Runtime(this, options, state as TransactionState));
    Object.freeze(this);
  }

  get side(): RuntimeSide {
    return this.registry.side;
  }

  /** The current company id. */
  get companyId(): string | null {
    return this.user.companyId;
  }

  /** An empty recordset of a model, to search, browse or create. */
  model(name: string): Recordset {
    const meta = this.registry.get(name);
    if (meta.abstract) throw new RecordsetError(`"${name}" is abstract.`);
    return new meta.recordClass(this, []);
  }

  /**
   * An environment with superuser rights sharing this transaction. Server only; every call
   * is written to the audit log with its reason (ARCHITECTURE.md §4.8).
   * @throws {@link ServerOnlyError} on the client
   */
  sudo(reason: string): Environment {
    return runtime(this).sudo(reason);
  }

  /** Persists pending writes, recomputes stored fields and checks constraints. */
  flush(): Promise<void> {
    return runtime(this).flush();
  }
}

/**
 * Creates an environment for one request/transaction.
 * @public
 */
export function createEnvironment(options: EnvironmentOptions): Environment {
  const state = new TransactionState();
  const env = new Environment(ENV_KEY, options, state, false);
  state.userEnv = env;
  return env;
}

/** @internal */
export function runtime(env: Environment): Runtime {
  const found = runtimes.get(env);
  if (!found) throw new TypeError('Unknown environment.');
  return found;
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = create();
    map.set(key, value);
  }
  return value;
}

function mark(
  map: Map<string, Map<string, Set<string>>>,
  model: string,
  id: string,
  field: string,
): void {
  getOrCreate(
    getOrCreate(map, model, () => new Map<string, Set<string>>()),
    id,
    () => new Set<string>(),
  ).add(field);
}

function idsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return typeof value === 'string' ? [value] : [];
}

const UNSET = Symbol('unset');

/** @internal */
export class Runtime {
  private readonly env: Environment;
  private readonly options: EnvironmentOptions;
  private readonly state: TransactionState;
  private readonly registry: ModelRegistry;
  private readonly storage: Storage;

  constructor(env: Environment, options: EnvironmentOptions, state: TransactionState) {
    this.env = env;
    this.options = options;
    this.state = state;
    this.registry = options.registry;
    this.storage = options.storage;
  }

  // ─── environment ────────────────────────────────────────────────────────────

  sudo(reason: string): Environment {
    if (this.registry.side === 'client')
      throw new ServerOnlyError('sudo() is forbidden on the client.');
    if (reason.trim() === '')
      throw new RecordsetError('sudo() requires a reason for the audit log.');
    this.options.audit.record({ type: 'sudo', userId: this.env.user.id, reason, at: this.now() });
    return new Environment(ENV_KEY, this.options, this.state, true);
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  private newId(): string {
    return this.options.newId?.() ?? uuidv7();
  }

  private suEnv(): Environment {
    return this.env.su ? this.env : new Environment(ENV_KEY, this.options, this.state, true);
  }

  private records(env: Environment, model: string, ids: readonly string[]): Recordset {
    return env.model(model).browse(ids);
  }

  // ─── access control ─────────────────────────────────────────────────────────

  /** `as`: the environment whose rights apply (the real user for their own pending writes). */
  private checkModel(model: string, operation: Operation, as: Environment = this.env): void {
    if (!as.su) this.options.access.checkModel(as, model, operation);
  }

  private rule(model: string, operation: Operation, as: Environment = this.env): DomainNode {
    return as.su ? { kind: 'true' } : this.options.access.ruleDomain(as, model, operation);
  }

  /** Every id must exist and satisfy the record rules of the operation. */
  private async checkRecords(
    meta: ModelMeta,
    ids: readonly string[],
    operation: Operation,
    as: Environment = this.env,
  ): Promise<void> {
    if (ids.length === 0) return;
    const rule = this.rule(meta.name, operation, as);
    const where = andNodes(
      { kind: 'condition', path: ['id'], operator: 'in', value: [...ids] },
      rule,
    );
    const found = new Set(await this.storage.search(meta, where, {}));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length === 0) return;
    if (rule.kind === 'true') throw new MissingRecordError(meta.name, missing);
    throw new AccessError(
      `Operation "${operation}" refused on ${String(missing.length)} "${meta.name}" record(s).`,
    );
  }

  // ─── cache ──────────────────────────────────────────────────────────────────

  private cached(model: string, id: string, field: string): unknown {
    const fields = this.state.cache.get(model)?.get(id);
    return fields?.has(field) ? fields.get(field) : UNSET;
  }

  private setCached(model: string, id: string, field: string, value: unknown): void {
    getOrCreate(
      getOrCreate(this.state.cache, model, () => new Map<string, FieldMap>()),
      id,
      () => new Map(),
    ).set(field, value);
  }

  private isDirty(model: string, id: string, field: string): boolean {
    return (
      this.state.dirty.get(model)?.get(id)?.has(field) === true ||
      this.state.dirtySu.get(model)?.get(id)?.has(field) === true ||
      this.state.computedDirty.get(model)?.get(id)?.has(field) === true
    );
  }

  private rememberOriginal(model: string, id: string, field: string): void {
    const byId = getOrCreate(
      getOrCreate(this.state.originals, model, () => new Map<string, Map<string, unknown>>()),
      id,
      () => new Map<string, unknown>(),
    );
    if (!byId.has(field)) {
      const current = this.cached(model, id, field);
      byId.set(field, current === UNSET ? null : current);
    }
  }

  /** Drops every cached value of non-stored computed fields (they depend on changed data). */
  private invalidateComputed(): void {
    for (const [model, byId] of this.state.cache) {
      const meta = this.registry.get(model);
      for (const [name, definition] of meta.fields) {
        if (definition.compute !== undefined && !isStoredColumn(definition)) {
          for (const fields of byId.values()) fields.delete(name);
        }
      }
    }
  }

  /** Loads the stored columns of `ids` that are not cached yet (never overwrites pending writes). */
  private async load(meta: ModelMeta, ids: readonly string[]): Promise<void> {
    const columns = [...meta.fields]
      .filter(([, d]) => isStoredColumn(d) || d.type === 'many2many')
      .map(([name]) => name);
    const missing = ids.filter((id) =>
      columns.some((c) => this.cached(meta.name, id, c) === UNSET),
    );
    if (missing.length === 0) return;
    const rows = await this.storage.read(meta, missing, columns);
    for (const [id, row] of rows) {
      for (const column of columns) {
        if (!this.isDirty(meta.name, id, column)) {
          const definition = meta.fields.get(column) as FieldDefinition;
          this.setCached(meta.name, id, column, row[column] ?? emptyValue(definition));
        }
      }
    }
  }

  // ─── field access ───────────────────────────────────────────────────────────

  getField(record: Recordset, field: string): unknown {
    const meta = this.registry.get(record.model);
    const definition = meta.fields.get(field) as FieldDefinition;
    const value = this.rawValue(meta, record.ensureOne().ids[0] as string, field);
    return this.wrap(definition, value);
  }

  private wrap(definition: FieldDefinition, value: unknown): unknown {
    if (definition.type === 'many2one') {
      return this.records(
        this.env,
        definition.comodel as string,
        typeof value === 'string' ? [value] : [],
      );
    }
    if (definition.type === 'one2many' || definition.type === 'many2many') {
      return this.records(this.env, definition.comodel as string, idsOf(value));
    }
    return value;
  }

  private rawValue(meta: ModelMeta, id: string, field: string): unknown {
    if (field === 'id') return id;
    const definition = meta.fields.get(field) as FieldDefinition;
    let value = this.cached(meta.name, id, field);
    if (value !== UNSET) return value;
    if (definition.compute !== undefined && !isStoredColumn(definition)) {
      this.computeNow(meta, [id], definition);
      value = this.cached(meta.name, id, field);
      return value === UNSET ? emptyValue(definition) : value;
    }
    if (definition.related !== undefined && !isStoredColumn(definition)) {
      const [head = '', ...rest] = definition.related.split('.');
      const link = meta.fields.get(head) as FieldDefinition;
      const target = idsOf(this.rawValue(meta, id, head))[0];
      if (target === undefined || link.comodel === undefined) return emptyValue(definition);
      return this.rawValue(this.registry.get(link.comodel), target, rest.join('.'));
    }
    if (field.includes('.')) {
      const [head = '', ...rest] = field.split('.');
      const link = meta.fields.get(head) as FieldDefinition;
      const target = idsOf(this.rawValue(meta, id, head))[0];
      if (target === undefined || link.comodel === undefined) return null;
      return this.rawValue(this.registry.get(link.comodel), target, rest.join('.'));
    }
    throw new FieldNotLoadedError(meta.name, field);
  }

  /** Runs the compute method of a non-stored field synchronously (dependencies must be cached). */
  private computeNow(meta: ModelMeta, ids: readonly string[], definition: FieldDefinition): void {
    const key = `${meta.name}.${String(definition.compute)}`;
    const records = this.records(this.env, meta.name, ids) as unknown as Record<
      string,
      () => unknown
    >;
    this.state.computing.add(key);
    try {
      const result = records[definition.compute as string]?.call(records);
      if (result instanceof Promise) {
        throw new RecordsetError(
          `Compute method "${key}" of a non-stored field must be synchronous.`,
        );
      }
    } finally {
      this.state.computing.delete(key);
    }
  }

  setField(record: Recordset, field: string, value: unknown): void {
    const meta = this.registry.get(record.model);
    const definition = meta.fields.get(field) as FieldDefinition;
    if (TECHNICAL_FIELDS.includes(field))
      throw new RecordsetError(`"${field}" is managed by the ORM.`);
    const normalized = this.normalizeInput(field, definition, value);

    if (definition.compute !== undefined) {
      if (!this.state.computing.has(`${meta.name}.${definition.compute}`)) {
        throw new RecordsetError(
          `"${meta.name}.${field}" is computed: only its compute method may assign it.`,
        );
      }
      for (const id of record.ids) {
        this.setCached(meta.name, id, field, normalized);
        if (isStoredColumn(definition)) mark(this.state.computedDirty, meta.name, id, field);
      }
      return;
    }
    if (definition.related !== undefined) {
      const [head = '', ...rest] = definition.related.split('.');
      const link = meta.fields.get(head) as FieldDefinition;
      for (const id of record.ids) {
        const target = idsOf(this.rawValue(meta, id, head))[0];
        if (target === undefined)
          throw new RecordsetError(`Cannot write "${field}": "${head}" is empty.`);
        this.setField(
          this.records(this.env, link.comodel as string, [target]),
          rest.join('.'),
          value,
        );
      }
      return;
    }
    if (definition.type === 'one2many') {
      throw new RecordsetError(
        `Write "${meta.name}.${field}" through the "${String(definition.comodel)}" records.`,
      );
    }
    for (const id of record.ids) {
      this.rememberOriginal(meta.name, id, field);
      this.setCached(meta.name, id, field, normalized);
      mark(this.env.su ? this.state.dirtySu : this.state.dirty, meta.name, id, field);
    }
    this.invalidateComputed();
  }

  private normalizeInput(field: string, definition: FieldDefinition, value: unknown): unknown {
    if (value instanceof Recordset) {
      if (definition.type === 'many2one') {
        if (value.length > 1) throw new RecordsetError(`"${field}" expects at most one record.`);
        return value.ids[0] ?? null;
      }
      return normalizeValue(field, definition, [...value.ids]);
    }
    return normalizeValue(field, definition, value);
  }

  // ─── domains ────────────────────────────────────────────────────────────────

  /** Parses a user domain and rewrites related fields to their stored paths. */
  private prepareDomain(model: string, domain: Domain): DomainNode {
    const node = parseDomain(domain, model, (m, f) => this.registry.field(m, f));
    return this.rewrite(model, node);
  }

  private rewrite(model: string, node: DomainNode): DomainNode {
    switch (node.kind) {
      case 'true':
        return node;
      case 'and':
      case 'or':
        return {
          kind: node.kind,
          children: node.children.map((child) => this.rewrite(model, child)),
        };
      case 'not':
        return { kind: 'not', child: this.rewrite(model, node.child) };
      case 'condition':
        return { ...node, path: this.storedPath(model, node.path) };
    }
  }

  private storedPath(model: string, path: readonly string[]): string[] {
    const result: string[] = [];
    let current = model;
    const queue = [...path];
    while (queue.length > 0) {
      const step = queue.shift() as string;
      const definition = this.registry.field(current, step) as FieldDefinition;
      if (definition.related !== undefined && !isStoredColumn(definition)) {
        queue.unshift(...definition.related.split('.'));
        continue;
      }
      if (definition.compute !== undefined && !isStoredColumn(definition)) {
        throw new DomainError(`Cannot search on non-stored computed field "${current}.${step}".`);
      }
      result.push(step);
      if (definition.comodel !== undefined) current = definition.comodel;
    }
    return result;
  }

  // ─── public operations ─────────────────────────────────────────────────────

  async search<R extends Recordset>(records: R, domain: Domain, params: SearchParams): Promise<R> {
    const meta = this.registry.get(records.model);
    this.checkModel(meta.name, 'read');
    const where = andNodes(this.prepareDomain(meta.name, domain), this.rule(meta.name, 'read'));
    await this.flush();
    const ids = await this.storage.search(meta, where, {
      order:
        params.order === undefined ? meta.order : parseOrder(meta.name, params.order, meta.fields),
      limit: params.limit,
      offset: params.offset,
    });
    await this.load(meta, ids);
    return records.browse(ids);
  }

  async searchCount(records: Recordset, domain: Domain): Promise<number> {
    const meta = this.registry.get(records.model);
    this.checkModel(meta.name, 'read');
    await this.flush();
    return this.storage.count(
      meta,
      andNodes(this.prepareDomain(meta.name, domain), this.rule(meta.name, 'read')),
    );
  }

  async prefetch<R extends Recordset>(records: R, paths: readonly string[]): Promise<R> {
    const meta = this.registry.get(records.model);
    this.checkModel(meta.name, 'read');
    await this.flush();
    await this.checkRecords(meta, records.ids, 'read');
    await this.load(meta, records.ids);
    for (const path of paths)
      await this.prefetchPath(meta, records.ids, path.split('.'), this.env.su);
    return records;
  }

  private async prefetchPath(
    meta: ModelMeta,
    ids: readonly string[],
    steps: readonly string[],
    su: boolean,
  ): Promise<void> {
    if (steps.length === 0 || ids.length === 0) return;
    const [step = '', ...rest] = steps;
    const definition = meta.fields.get(step);
    if (!definition) throw new DomainError(`Unknown field "${step}" on "${meta.name}".`);
    if (definition.related !== undefined && !isStoredColumn(definition)) {
      await this.prefetchPath(meta, ids, [...definition.related.split('.'), ...rest], su);
      return;
    }
    if (definition.compute !== undefined && !isStoredColumn(definition)) {
      for (const dependency of definition.depends ?? []) {
        await this.prefetchPath(meta, ids, dependency.split('.'), su);
      }
    } else if (definition.type === 'one2many') {
      await this.loadOne2many(meta, ids, step, definition, su);
    } else {
      await this.load(meta, ids);
    }
    if (rest.length === 0 || definition.comodel === undefined) return;
    const next = this.registry.get(definition.comodel);
    const nextIds = [...new Set(ids.flatMap((id) => idsOf(this.rawValue(meta, id, step))))];
    if (!su) {
      this.options.access.checkModel(this.env, next.name, 'read');
      await this.checkRecords(next, nextIds, 'read');
    }
    await this.load(next, nextIds);
    await this.prefetchPath(next, nextIds, rest, su);
  }

  private async loadOne2many(
    meta: ModelMeta,
    ids: readonly string[],
    field: string,
    definition: FieldDefinition,
    su: boolean,
  ): Promise<void> {
    const child = this.registry.get(definition.comodel as string);
    const inverse = definition.inverse as string;
    const rule = su
      ? ({ kind: 'true' } as const)
      : this.options.access.ruleDomain(this.env, child.name, 'read');
    const where = andNodes(
      { kind: 'condition', path: [inverse], operator: 'in', value: [...ids] },
      rule,
    );
    const childIds = await this.storage.search(child, where, { order: child.order });
    await this.load(child, childIds);
    const byParent = new Map<string, string[]>(ids.map((id) => [id, []]));
    for (const childId of childIds) {
      const parentId = this.cached(child.name, childId, inverse);
      if (typeof parentId === 'string') byParent.get(parentId)?.push(childId);
    }
    for (const [parentId, children] of byParent)
      this.setCached(meta.name, parentId, field, children);
  }

  async read(records: Recordset, fields?: readonly string[]): Promise<Record<string, unknown>[]> {
    const meta = this.registry.get(records.model);
    const names =
      fields ??
      [...meta.fields.keys()].filter((name) => !TECHNICAL_FIELDS.includes(name) || name === 'id');
    await this.prefetch(
      records,
      names.filter((name) => name !== 'id'),
    );
    return records.ids.map((id) =>
      Object.fromEntries(names.map((name) => [name, this.rawValue(meta, id, name)])),
    );
  }

  async create<R extends Recordset>(records: R, list: readonly RecordValues[]): Promise<R> {
    const meta = this.registry.get(records.model);
    this.checkModel(meta.name, 'create');
    await this.flush();
    const rows: { id: string; values: Record<string, unknown> }[] = [];
    const children: { definition: FieldDefinition; parent: string; values: RecordValues[] }[] = [];
    const now = this.now();

    for (const input of list) {
      // A Map, not an object: client-supplied keys such as "__proto__" stay plain data.
      const own = new Map<string, unknown>(Object.entries(input));
      const givenId = own.get('id');
      const id = typeof givenId === 'string' && isRecordId(givenId) ? givenId : this.newId();
      own.delete('id');

      for (const [parentModel, via] of meta.delegations) {
        const parentValues: Record<string, unknown> = {};
        for (const [name, link] of meta.delegatedFields) {
          if (link === via && own.has(name)) {
            parentValues[name] = own.get(name);
            own.delete(name);
          }
        }
        const linked = own.get(via);
        if (linked === undefined || linked === null) {
          own.set(via, (await this.create(this.env.model(parentModel), [parentValues])).id);
        } else if (Object.keys(parentValues).length > 0) {
          const parentId = linked instanceof Recordset ? linked.id : linked;
          if (typeof parentId !== 'string')
            throw new ValidationError(`"${via}" expects a record id.`);
          await this.records(this.env, parentModel, [parentId]).write(parentValues);
        }
      }

      for (const name of [...own.keys()]) {
        const definition = meta.fields.get(name);
        if (!definition) throw new ValidationError(`Unknown field "${meta.name}.${name}".`);
        if (TECHNICAL_FIELDS.includes(name))
          throw new ValidationError(`"${name}" is managed by the ORM.`);
        if (definition.compute !== undefined)
          throw new ValidationError(`"${meta.name}.${name}" is computed.`);
        if (definition.type === 'one2many') {
          const values = own.get(name);
          if (!Array.isArray(values))
            throw new ValidationError(`"${name}" expects a list of values to create.`);
          children.push({ definition, parent: id, values: values as RecordValues[] });
          own.delete(name);
        }
      }

      const values: Record<string, unknown> = {};
      for (const [name, definition] of meta.fields) {
        if (
          TECHNICAL_FIELDS.includes(name) ||
          !(isStoredColumn(definition) || definition.type === 'many2many')
        )
          continue;
        if (definition.compute !== undefined) continue;
        let value = own.get(name);
        if (value === undefined && definition.default !== undefined) {
          value =
            typeof definition.default === 'function'
              ? (definition.default as (env: Environment) => unknown)(this.env)
              : definition.default;
        }
        values[name] =
          value === undefined
            ? emptyValue(definition)
            : this.normalizeInput(name, definition, value);
      }
      Object.assign(values, {
        createdAt: now,
        updatedAt: now,
        createdBy: this.env.user.id,
        updatedBy: this.env.user.id,
        version: 0,
        deletedAt: null,
        originDevice: this.env.user.deviceId ?? null,
      });
      for (const [name, value] of Object.entries(values))
        this.setCached(meta.name, id, name, value);
      for (const [name, definition] of meta.fields) {
        if (definition.compute !== undefined && isStoredColumn(definition))
          this.setCached(meta.name, id, name, emptyValue(definition));
      }
      rows.push({ id, values });
    }

    await this.storage.insert(meta, rows);
    const ids = rows.map((row) => row.id);
    for (const [name, definition] of meta.fields) {
      if (definition.compute !== undefined && isStoredColumn(definition))
        this.schedule(meta.name, name, ids);
    }
    await this.propagate({
      model: meta.name,
      ids,
      fields: [...meta.fields.keys()],
      originals: new Map(),
    });

    for (const { definition, parent, values } of children) {
      await this.create(
        this.env.model(definition.comodel as string),
        values.map((child) => ({ ...child, [definition.inverse as string]: parent })),
      );
    }
    this.invalidateComputed();
    await this.runRecomputes();
    await this.checkRequired(meta, ids, [...meta.fields.keys()]);
    await this.checkConstraints(meta, ids, [...meta.fields.keys()]);
    await this.checkRecords(meta, ids, 'create');
    return records.browse(ids);
  }

  async write(records: Recordset, values: RecordValues): Promise<void> {
    const meta = this.registry.get(records.model);
    this.checkModel(meta.name, 'write');
    await this.load(meta, records.ids);
    for (const [name, value] of Object.entries(values)) {
      if (!meta.fields.has(name))
        throw new ValidationError(`Unknown field "${meta.name}.${name}".`);
      this.setField(records, name, value);
    }
    await this.flush();
  }

  async flush(): Promise<void> {
    const state = this.state;
    const userEnv = state.userEnv ?? this.env;
    while (
      state.dirty.size > 0 ||
      state.dirtySu.size > 0 ||
      state.pending.size > 0 ||
      state.computedDirty.size > 0
    ) {
      const batches: { dirty: Map<string, Map<string, Set<string>>>; as: Environment }[] = [
        { dirty: new Map(state.dirty), as: userEnv },
        { dirty: new Map(state.dirtySu), as: this.suEnv() },
      ];
      state.dirty.clear();
      state.dirtySu.clear();
      const originals = new Map(state.originals);
      state.originals.clear();
      const touched: { meta: ModelMeta; ids: string[]; fields: string[] }[] = [];

      for (const { dirty, as } of batches)
        for (const [model, byId] of dirty) {
          const meta = this.registry.get(model);
          this.checkModel(model, 'write', as);
          await this.checkRecords(meta, [...byId.keys()], 'write', as);
          const now = this.now();
          const fields = new Set<string>();
          for (const [id, names] of byId) {
            const values: Record<string, unknown> = { updatedAt: now, updatedBy: this.env.user.id };
            for (const name of names) {
              values[name] = this.cached(model, id, name);
              fields.add(name);
            }
            this.setCached(model, id, 'updatedAt', now);
            this.setCached(model, id, 'updatedBy', this.env.user.id);
            await this.storage.update(meta, id, values);
          }
          const ids = [...byId.keys()];
          touched.push({ meta, ids, fields: [...fields] });
          await this.propagate({
            model,
            ids,
            fields: [...fields],
            originals: originals.get(model) ?? new Map(),
          });
        }
      await this.runRecomputes();
      for (const { meta, ids, fields } of touched) {
        await this.checkRequired(meta, ids, fields);
        await this.checkConstraints(meta, ids, fields);
      }
    }
  }

  async unlink(records: Recordset): Promise<void> {
    const meta = this.registry.get(records.model);
    if (records.ids.length === 0) return;
    this.checkModel(meta.name, 'unlink');
    await this.flush();
    await this.checkRecords(meta, records.ids, 'unlink');
    await this.load(meta, records.ids);
    const ids = records.ids;
    const su = this.suEnv();

    for (const other of this.registry.names()) {
      const otherMeta = this.registry.get(other);
      if (otherMeta.abstract) continue;
      for (const [name, definition] of otherMeta.fields) {
        if (
          definition.type !== 'many2one' ||
          definition.comodel !== meta.name ||
          !isStoredColumn(definition)
        )
          continue;
        const where: DomainNode = {
          kind: 'condition',
          path: [name],
          operator: 'in',
          value: [...ids],
        };
        const referencing = (await this.storage.search(otherMeta, where, {})).filter(
          (id) => !ids.includes(id) || other !== meta.name,
        );
        if (referencing.length === 0) continue;
        if (definition.ondelete === 'restrict') {
          throw new ValidationError(
            `Cannot delete "${meta.name}": referenced by ${String(referencing.length)} "${other}" record(s).`,
          );
        }
        if (definition.ondelete === 'cascade') {
          await runtime(su).unlink(this.records(su, other, referencing));
        } else {
          await runtime(su).write(this.records(su, other, referencing), { [name]: null });
        }
      }
    }

    const originals = new Map<string, Map<string, unknown>>();
    for (const id of ids) {
      const fields = new Map<string, unknown>();
      for (const name of meta.fields.keys()) {
        const value = this.cached(meta.name, id, name);
        if (value !== UNSET) fields.set(name, value);
      }
      originals.set(id, fields);
    }
    await this.propagate({ model: meta.name, ids, fields: [...meta.fields.keys()], originals });
    await this.storage.delete(meta, ids);
    for (const id of ids) {
      this.state.cache.get(meta.name)?.delete(id);
      this.state.deleted.add(`${meta.name}:${id}`);
    }
    for (const byId of this.state.cache.values()) {
      for (const fields of byId.values()) {
        for (const [name, value] of fields) {
          if (Array.isArray(value) && value.some((v) => ids.includes(v as string)))
            fields.delete(name);
        }
      }
    }
    this.invalidateComputed();
    await this.runRecomputes();
  }

  async callServer(records: Recordset, method: string, args: readonly unknown[]): Promise<unknown> {
    const queue = this.options.queueServerCall;
    if (!queue)
      throw new ServerOnlyError(
        `"${records.model}.${method}" is a server method and no intent queue is configured.`,
      );
    await this.flush();
    return queue({ model: records.model, method, ids: records.ids, args });
  }

  // ─── recomputation ──────────────────────────────────────────────────────────

  private schedule(model: string, field: string, ids: Iterable<string>): void {
    const set = getOrCreate(
      getOrCreate(this.state.pending, model, () => new Map<string, Set<string>>()),
      field,
      () => new Set<string>(),
    );
    for (const id of ids) set.add(id);
  }

  private triggers(): Map<string, Map<string, Trigger[]>> {
    return getOrCreate(
      triggerCache as Map<ModelRegistry, Map<string, Map<string, Trigger[]>>>,
      this.registry,
      () => buildTriggers(this.registry),
    );
  }

  /** Schedules the stored computed fields that depend on a change. */
  private async propagate(change: Change): Promise<void> {
    const byField = this.triggers().get(change.model);
    if (!byField) return;
    const su = this.suEnv();
    for (const field of change.fields) {
      for (const trigger of byField.get(field) ?? []) {
        let targets: readonly string[];
        if (trigger.path.length === 0) {
          targets = change.ids;
        } else if (trigger.viaInverse) {
          const parents = new Set<string>();
          for (const id of change.ids) {
            for (const value of idsOf(this.cached(change.model, id, field))) parents.add(value);
            for (const value of idsOf(change.originals.get(id)?.get(field))) parents.add(value);
          }
          targets =
            trigger.path.length === 1
              ? [...parents]
              : await this.searchIds(su, trigger.model, trigger.path.slice(0, -1), [...parents]);
        } else {
          targets = await this.searchIds(su, trigger.model, trigger.path, change.ids);
        }
        this.schedule(
          trigger.model,
          trigger.field,
          targets.filter((id) => !this.state.deleted.has(`${trigger.model}:${id}`)),
        );
      }
    }
  }

  private async searchIds(
    env: Environment,
    model: string,
    path: readonly string[],
    ids: readonly string[],
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    const meta = this.registry.get(model);
    const where: DomainNode = {
      kind: 'condition',
      path: runtime(env).storedPath(model, path),
      operator: 'in',
      value: [...ids],
    };
    return this.storage.search(meta, where, {});
  }

  /**
   * Recomputes the scheduled stored fields until stable, persists them, then checks the
   * constraints involving the recomputed fields (a constraint on a total must hold when a
   * line changes, not only when the total is written directly).
   */
  private async runRecomputes(): Promise<void> {
    const su = this.suEnv();
    const recomputed: { meta: ModelMeta; ids: string[]; fields: string[] }[] = [];
    for (let round = 0; this.state.pending.size > 0 || this.state.computedDirty.size > 0; round++) {
      if (round >= MAX_RECOMPUTE_ROUNDS)
        throw new ValidationError('Computed fields did not converge (dependency loop?).');
      const pending = new Map(this.state.pending);
      this.state.pending.clear();
      for (const [model, byField] of pending) {
        const meta = this.registry.get(model);
        const done = new Set<string>();
        for (const [field, idSet] of byField) {
          const definition = meta.fields.get(field) as FieldDefinition;
          const method = definition.compute ?? '';
          const ids = [...idSet].filter((id) => !this.state.deleted.has(`${model}:${id}`));
          if (ids.length === 0 || done.has(method)) continue;
          done.add(method);
          const suRuntime = runtime(su);
          await suRuntime.load(meta, ids);
          for (const dependency of definition.depends ?? [])
            await suRuntime.prefetchPath(meta, ids, dependency.split('.'), true);
          const recordsSu = this.records(su, model, ids) as unknown as Record<
            string,
            () => unknown
          >;
          this.state.computing.add(`${model}.${method}`);
          try {
            await recordsSu[method]?.call(recordsSu);
          } finally {
            this.state.computing.delete(`${model}.${method}`);
          }
        }
      }
      const computed = new Map(this.state.computedDirty);
      this.state.computedDirty.clear();
      for (const [model, byId] of computed) {
        const meta = this.registry.get(model);
        const fields = new Set<string>();
        for (const [id, names] of byId) {
          const values: Record<string, unknown> = {};
          for (const name of names) {
            values[name] = this.cached(model, id, name);
            fields.add(name);
          }
          await this.storage.update(meta, id, values);
        }
        this.invalidateComputed();
        recomputed.push({ meta, ids: [...byId.keys()], fields: [...fields] });
        await this.propagate({
          model,
          ids: [...byId.keys()],
          fields: [...fields],
          originals: new Map(),
        });
      }
    }
    for (const { meta, ids, fields } of recomputed) await this.checkConstraints(meta, ids, fields);
  }

  // ─── checks ─────────────────────────────────────────────────────────────────

  private async checkRequired(
    meta: ModelMeta,
    ids: readonly string[],
    fields: readonly string[],
  ): Promise<void> {
    for (const name of fields) {
      const definition = meta.fields.get(name);
      if (!definition?.required || TECHNICAL_FIELDS.includes(name) || !isStoredColumn(definition))
        continue;
      for (const id of ids) {
        const value = this.cached(meta.name, id, name);
        if (value === null || value === UNSET || (Array.isArray(value) && value.length === 0)) {
          throw new ValidationError(`Field "${meta.name}.${name}" is required.`);
        }
      }
    }
    await Promise.resolve();
  }

  private async checkConstraints(
    meta: ModelMeta,
    ids: readonly string[],
    fields: readonly string[],
  ): Promise<void> {
    const live = ids.filter((id) => !this.state.deleted.has(`${meta.name}:${id}`));
    for (const constraint of meta.constraints) {
      if (live.length === 0 || !constraint.fields.some((field) => fields.includes(field))) continue;
      const records = this.records(this.suEnv(), meta.name, live);
      await runtime(this.suEnv()).prefetch(
        records,
        constraint.fields.filter((field) => {
          const definition = meta.fields.get(field);
          return (
            definition !== undefined &&
            (definition.type === 'one2many' ||
              definition.related !== undefined ||
              definition.compute !== undefined)
          );
        }),
      );
      const target = records as unknown as Record<string, () => unknown>;
      await target[constraint.check]?.call(target);
    }
  }
}

function buildTriggers(registry: ModelRegistry): Map<string, Map<string, Trigger[]>> {
  const triggers = new Map<string, Map<string, Trigger[]>>();
  const add = (model: string, field: string, trigger: Trigger): void => {
    getOrCreate(
      getOrCreate(triggers, model, () => new Map<string, Trigger[]>()),
      field,
      () => [],
    ).push(trigger);
  };
  for (const name of registry.names()) {
    const meta = registry.get(name);
    if (meta.abstract) continue;
    for (const [field, definition] of meta.fields) {
      if (definition.compute === undefined || !isStoredColumn(definition)) continue;
      for (const dependency of definition.depends ?? []) {
        let current = name;
        const prefix: string[] = [];
        for (const step of dependency.split('.')) {
          const stepDefinition = registry.field(current, step);
          if (!stepDefinition) break;
          add(current, step, { model: name, field, path: [...prefix], viaInverse: false });
          if (stepDefinition.type === 'one2many' && stepDefinition.comodel !== undefined) {
            add(stepDefinition.comodel, stepDefinition.inverse as string, {
              model: name,
              field,
              path: [...prefix, step],
              viaInverse: true,
            });
          }
          prefix.push(step);
          if (stepDefinition.comodel === undefined) break;
          current = stepDefinition.comodel;
        }
      }
    }
  }
  return triggers;
}
