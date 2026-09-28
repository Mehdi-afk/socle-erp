// SPDX-License-Identifier: LGPL-3.0-only
import { SocleError } from '../errors.js';

/**
 * The current user may not perform this operation (refused by default).
 * @public
 */
export class AccessError extends SocleError {
  constructor(message: string) {
    super('orm.access', message);
  }
}

/**
 * A business rule, a required field or a uniqueness constraint is violated.
 * @public
 */
export class ValidationError extends SocleError {
  constructor(message: string) {
    super('orm.validation', message);
  }
}

/**
 * A record does not exist (or no longer exists).
 * @public
 */
export class MissingRecordError extends SocleError {
  constructor(model: string, ids: readonly string[]) {
    super('orm.missing_record', `Records not found in "${model}": ${ids.join(', ')}.`);
  }
}

/**
 * A field was accessed synchronously before being loaded; call `await records.prefetch([...])`.
 * @public
 */
export class FieldNotLoadedError extends SocleError {
  constructor(model: string, field: string) {
    super(
      'orm.field_not_loaded',
      `Field "${model}.${field}" is not loaded: prefetch it first (await records.prefetch(['${field}'])).`,
    );
  }
}

/**
 * A server method was called offline without an intent queue, or `sudo()` was used on the client.
 * @public
 */
export class ServerOnlyError extends SocleError {
  constructor(message: string) {
    super('orm.server_only', message);
  }
}

/**
 * Misuse of the recordset API (e.g. reading a field on several records at once).
 * @public
 */
export class RecordsetError extends SocleError {
  constructor(message: string) {
    super('orm.recordset', message);
  }
}
