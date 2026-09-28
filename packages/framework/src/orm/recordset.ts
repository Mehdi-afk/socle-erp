// SPDX-License-Identifier: LGPL-3.0-only
import type { Domain } from './domain.js';
import type { Environment } from './environment.js';
import { runtime } from './environment.js';
import { RecordsetError } from './errors.js';
import type { MethodsFactory, RecordsetConstructor } from './model.js';

const MODEL = Symbol('socle.model');

/**
 * Values accepted by `create` and `write`: field name → value. Relational fields accept ids
 * or recordsets; a one2many accepts, at creation, a list of child values to create.
 * @public
 */
export type RecordValues = Readonly<Record<string, unknown>>;

/** @public */
export interface SearchParams {
  /** e.g. `'date desc, name'`; defaults to the model order. */
  readonly order?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/**
 * An ordered set of records of one model, bound to an environment (user, company, rights,
 * transaction). Iterating yields single-record recordsets; reading a field requires a single
 * record (`ensureOne`). Fields are synchronous accessors over the environment cache:
 * `search`, `browse(...).prefetch()` and compute methods load what they need.
 * @public
 */
export class Recordset {
  readonly env: Environment;
  readonly ids: readonly string[];

  constructor(env: Environment, ids: readonly string[]) {
    this.env = env;
    this.ids = Object.freeze([...new Set(ids)]);
  }

  /** Technical name of the model. */
  get model(): string {
    return (this.constructor as { [MODEL]?: string })[MODEL] ?? '';
  }

  get length(): number {
    return this.ids.length;
  }

  *[Symbol.iterator](): Iterator<this> {
    for (const id of this.ids) yield this.browse([id]);
  }

  /** The id of a single record. @throws {@link RecordsetError} unless exactly one record */
  get id(): string {
    return this.ensureOne().ids[0] as string;
  }

  /** @throws {@link RecordsetError} unless the recordset holds exactly one record */
  ensureOne(): this {
    if (this.ids.length !== 1) {
      throw new RecordsetError(
        `Expected a single "${this.model}" record, got ${String(this.ids.length)}.`,
      );
    }
    return this;
  }

  /** Same model and environment, other records (no database access). */
  browse(ids: readonly string[]): this {
    const Ctor = this.constructor as new (env: Environment, ids: readonly string[]) => this;
    return new Ctor(this.env, ids);
  }

  filtered(predicate: (record: this) => boolean): this {
    return this.browse([...this].filter(predicate).map((record) => record.id));
  }

  /** Values of a field for every record (relational fields give their ids). */
  mapped(field: string): unknown[] {
    return [...this].flatMap((record) => {
      const value: unknown = (record as unknown as Record<string, unknown>)[field];
      return value instanceof Recordset ? [...value.ids] : [value];
    });
  }

  /**
   * The same records with superuser rights (server only). Every call is written to the audit log.
   * @throws {@link ServerOnlyError} on the client
   */
  sudo(reason: string): this {
    const Ctor = this.constructor as new (env: Environment, ids: readonly string[]) => this;
    return new Ctor(this.env.sudo(reason), this.ids);
  }

  /** Searches records of this model; rights and record rules are applied. */
  search(domain: Domain = [], params: SearchParams = {}): Promise<this> {
    return runtime(this.env).search(this, domain, params);
  }

  searchCount(domain: Domain = []): Promise<number> {
    return runtime(this.env).searchCount(this, domain);
  }

  /** Creates one or several records and returns them. */
  create(values: RecordValues | readonly RecordValues[]): Promise<this> {
    return runtime(this.env).create(
      this,
      Array.isArray(values) ? values : [values as RecordValues],
    );
  }

  /** Writes the same values on every record, then flushes (checks, recomputations, constraints). */
  write(values: RecordValues): Promise<void> {
    return runtime(this.env).write(this, values);
  }

  /** Deletes the records (with `ondelete` handling and recomputation of dependent fields). */
  unlink(): Promise<void> {
    return runtime(this.env).unlink(this);
  }

  /** Loads fields and relational paths (e.g. `['partnerId.name', 'lines.qty']`) into the cache. */
  prefetch(paths: readonly string[] = []): Promise<this> {
    return runtime(this.env).prefetch(this, paths);
  }

  /**
   * Locks the records until the end of the transaction (server only): another transaction
   * locking them waits. Pending writes are flushed first and the records are read again after.
   * @throws {@link ServerOnlyError} on the client
   */
  lockForUpdate(): Promise<void> {
    return runtime(this.env).lock(this);
  }

  /** Plain values of the records (relational fields as ids), e.g. for the RPC layer. */
  read(fields?: readonly string[]): Promise<Record<string, unknown>[]> {
    return runtime(this.env).read(this, fields);
  }
}

/**
 * Members of {@link Recordset}; a field may not use one of these names.
 * @public
 */
export const RECORDSET_MEMBERS: readonly string[] = Object.freeze([
  ...Object.getOwnPropertyNames(Recordset.prototype),
  'env',
  'ids',
]);

/**
 * Composes the record class of a model: `Recordset` extended by every factory in order, then
 * (client side) stubs for server methods, then field accessors.
 * @internal
 */
export function composeRecordClass(
  model: string,
  factories: readonly MethodsFactory[],
  serverStubs: readonly string[],
  fieldNames: readonly string[] = [],
): RecordsetConstructor {
  let composed: RecordsetConstructor = Recordset;
  for (const factory of factories) composed = factory(composed);

  const Final = class extends composed {};
  Object.defineProperty(Final, MODEL, { value: model });
  Object.defineProperty(Final, 'name', { value: `Model(${model})` });

  for (const method of serverStubs) {
    Object.defineProperty(Final.prototype, method, {
      value: function serverStub(this: Recordset, ...args: unknown[]): Promise<unknown> {
        return runtime(this.env).callServer(this, method, args);
      },
      writable: false,
    });
  }
  for (const field of fieldNames) {
    Object.defineProperty(Final.prototype, field, {
      get(this: Recordset): unknown {
        return runtime(this.env).getField(this, field);
      },
      set(this: Recordset, value: unknown) {
        runtime(this.env).setField(this, field, value);
      },
      enumerable: true,
    });
  }
  return Final;
}
