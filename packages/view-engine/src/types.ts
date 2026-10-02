// SPDX-License-Identifier: LGPL-3.0-only
//
// What the view engine needs from the outside. It knows the models (the registry of the framework)
// and asks a data source for records; it does not know where they come from: the server over HTTP,
// the local database of an offline device, or a list in memory in a test.
import type { ModelRegistry } from '@socle/framework';

/** A record as the engine receives it: its `id` and the values of the fields asked for. */
export interface RecordValues {
  readonly id: string;
  readonly [field: string]: unknown;
}

export interface SearchOptions {
  /** The fields to read. */
  readonly fields: readonly string[];
  /** A search domain (the framework's), or none. */
  readonly domain?: readonly unknown[] | undefined;
  /** `name`, `name desc`, `city, name desc`. */
  readonly order?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface SearchResult {
  /** The records of the requested range. */
  readonly records: readonly RecordValues[];
  /** How many records match in all (not only in this range). */
  readonly total: number;
}

export interface DataSource {
  search(model: string, options: SearchOptions): Promise<SearchResult>;
  read(model: string, ids: readonly string[], fields: readonly string[]): Promise<RecordValues[]>;
  /** The names shown for the records a relation points to. */
  displayNames(model: string, ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /**
   * Saves the given values of one record. Without it the views are read-only. A refusal by the
   * server (a rule, a constraint, a right) is a WriteFailure. The adapter must enforce rights and
   * validate the change; hiding an edit button is not an authorization check.
   */
  write?(model: string, id: string, values: Readonly<Record<string, unknown>>): Promise<void>;
}

/**
 * A refusal safe to show to the user; fieldErrors associates field names with localized errors.
 * @public
 */
export class WriteFailure extends Error {
  readonly fieldErrors: Readonly<Record<string, string>>;
  constructor(message: string, fieldErrors: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = 'WriteFailure';
    this.fieldErrors = fieldErrors;
  }
}

export type Density = 'comfortable' | 'compact';

/** The user and the application around a view. */
export interface ViewContext {
  readonly registry: ModelRegistry;
  readonly data: DataSource;
  /** BCP 47 tag: `fr`, `en`, `ar`. */
  readonly language: string;
  /** IANA name, e.g. `Africa/Algiers`. */
  readonly timeZone: string;
  readonly density: Density;
}
