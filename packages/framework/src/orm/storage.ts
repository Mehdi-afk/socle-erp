// SPDX-License-Identifier: LGPL-3.0-only
import type { DomainNode } from './domain.js';
import type { ModelMeta, OrderTerm } from './model-registry.js';

/** @public */
export interface SearchOptions {
  readonly order?: readonly OrderTerm[] | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/**
 * A row as exchanged with the storage: stored columns (camelCase field names) and
 * many2many fields as arrays of ids. Values are already normalized by the ORM.
 * @public
 */
export type StoredValues = Readonly<Record<string, unknown>>;

/**
 * Who a storage call acts for. SQL storages use it as a second line of defence (PostgreSQL
 * row-level security); the ORM has already applied the access rules itself.
 * @public
 */
export interface StorageActor {
  readonly userId: string;
  /** A superuser call (`env.sudo()`, integrity checks, recomputations). */
  readonly su: boolean;
  readonly companyId: string | null;
  readonly companyIds: readonly string[];
  readonly groupIds: readonly string[];
}

/**
 * What the ORM needs from a database. Implemented by the PostgreSQL adapter (server), the
 * SQLite WASM adapter (offline client) and the in-memory reference store (tests).
 * Domains received here only reference stored fields (the ORM rewrites related fields and
 * refuses non-stored computed ones). Every identifier (table, column) comes from the model
 * registry, never from user input.
 * @public
 */
export interface Storage {
  search(model: ModelMeta, where: DomainNode, options: SearchOptions): Promise<string[]>;
  count(model: ModelMeta, where: DomainNode): Promise<number>;
  /** Returns the requested stored fields of the existing records among `ids`. */
  read(
    model: ModelMeta,
    ids: readonly string[],
    fields: readonly string[],
  ): Promise<ReadonlyMap<string, StoredValues>>;
  insert(
    model: ModelMeta,
    rows: readonly { readonly id: string; readonly values: StoredValues }[],
  ): Promise<void>;
  update(model: ModelMeta, id: string, values: StoredValues): Promise<void>;
  delete(model: ModelMeta, ids: readonly string[]): Promise<void>;
  /** The same storage acting for `actor` (optional: storages without row-level security ignore it). */
  as?(actor: StorageActor): Storage;
}
