// SPDX-License-Identifier: LGPL-3.0-only
import { SocleError } from '../errors.js';
import { isDecimalString } from './domain.js';
import type { FieldDefinition } from './fields.js';

/**
 * A value does not match its field type.
 * @public
 */
export class FieldValueError extends SocleError {
  readonly field: string;

  constructor(field: string, message: string) {
    super('orm.field_value', `Field "${field}": ${message}`);
    this.field = field;
  }
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const TIME_ZONE_SUFFIX = /(?:Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REFERENCE = /^[a-z][a-z0-9_.]*,[0-9a-f-]{36}$/;

function isValidDate(text: string): boolean {
  const match = DATE.exec(text);
  if (!match) return false;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * True for a record identifier (UUID, lowercase).
 * @public
 */
export function isRecordId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * Validates and normalizes a value written to a field. `null` means "empty" (except boolean).
 * - integer, monetary: safe integers (monetary = minor units, never a float);
 * - decimal: decimal string, within `digits`;
 * - date: `YYYY-MM-DD`; datetime: any ISO 8601 instant, normalized to UTC `…Z`;
 * - many2one: record id; one2many / many2many: arrays of record ids.
 * @throws {@link FieldValueError}
 * @public
 */
export function normalizeValue(name: string, definition: FieldDefinition, value: unknown): unknown {
  const fail = (message: string): never => {
    throw new FieldValueError(name, message);
  };
  if (value === undefined) fail('undefined is not a value (use null)');
  if (definition.type === 'boolean') {
    if (typeof value !== 'boolean') fail('expected a boolean');
    return value;
  }
  if (value === null) {
    if (definition.type === 'one2many' || definition.type === 'many2many') return [];
    return null;
  }
  switch (definition.type) {
    case 'char':
    case 'text':
    case 'html':
    case 'binary': {
      if (typeof value !== 'string') return fail('expected a string');
      if (definition.size !== undefined && value.length > definition.size) {
        fail(`longer than ${String(definition.size)} characters`);
      }
      return value;
    }
    case 'integer':
    case 'monetary':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        return fail(
          definition.type === 'monetary'
            ? 'expected an integer amount in minor units (never a float)'
            : 'expected a safe integer',
        );
      }
      return value;
    case 'decimal': {
      if (typeof value !== 'string' || !isDecimalString(value)) {
        return fail('expected a decimal string such as "12.345"');
      }
      if (definition.digits) {
        const [precision, scale] = definition.digits;
        const [whole = '', fraction = ''] = value.replace('-', '').split('.');
        if (fraction.length > scale || whole.replace(/^0+(?=\d)/, '').length > precision - scale) {
          fail(`exceeds digits (${String(precision)}, ${String(scale)})`);
        }
      }
      return value;
    }
    case 'date':
      if (typeof value !== 'string' || !isValidDate(value)) return fail('expected YYYY-MM-DD');
      return value;
    case 'datetime': {
      if (typeof value !== 'string') return fail('expected an ISO 8601 instant');
      if (value.length > 40 || !DATETIME_PREFIX.test(value) || !TIME_ZONE_SUFFIX.test(value)) {
        return fail('expected an ISO 8601 instant with a time zone');
      }
      const time = Date.parse(value);
      if (Number.isNaN(time)) return fail('invalid instant');
      return new Date(time).toISOString();
    }
    case 'selection': {
      if (typeof value !== 'string') return fail('expected a string');
      if (!(definition.selection ?? []).some(([key]) => key === value)) {
        fail(`"${value}" is not an allowed value`);
      }
      return value;
    }
    case 'many2one':
      if (!isRecordId(value)) return fail('expected a record id');
      return value;
    case 'one2many':
    case 'many2many':
      if (!Array.isArray(value) || !value.every(isRecordId)) {
        return fail('expected an array of record ids');
      }
      return [...new Set(value)];
    case 'json':
      try {
        return JSON.parse(JSON.stringify(value)) as unknown;
      } catch {
        return fail('expected a JSON-serializable value');
      }
    case 'reference':
      if (typeof value !== 'string' || !REFERENCE.test(value)) {
        return fail('expected "model,id"');
      }
      return value;
  }
}

/**
 * The empty value of a field type.
 * @public
 */
export function emptyValue(definition: FieldDefinition): unknown {
  switch (definition.type) {
    case 'boolean':
      return false;
    case 'one2many':
    case 'many2many':
      return [];
    default:
      return null;
  }
}
