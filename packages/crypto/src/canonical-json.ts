// SPDX-License-Identifier: LGPL-3.0-only
import { utf8 } from './encoding.js';

/**
 * A JSON value that can be signed.
 * @public
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

/**
 * Serializes a value to canonical JSON (RFC 8785 style): object keys sorted by UTF-16 code
 * units, no whitespace, `undefined` properties omitted. The same value always produces the
 * same bytes, which is what makes signatures reproducible.
 * Rejects non-finite numbers, non-plain objects, `undefined` in arrays and cycles.
 * @public
 */
export function canonicalJson(value: JsonValue): string {
  return serialize(value, new Set());
}

/**
 * {@link canonicalJson} encoded as UTF-8, ready to sign or hash.
 * @public
 */
export function canonicalBytes(value: JsonValue): Uint8Array {
  return utf8(canonicalJson(value));
}

function serialize(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('Canonical JSON: non-finite number.');
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError(`Canonical JSON: unsupported type ${typeof value}.`);
  }
  if (seen.has(value)) throw new TypeError('Canonical JSON: cyclic structure.');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value
        .map((item: unknown) => {
          if (item === undefined) throw new TypeError('Canonical JSON: undefined in array.');
          return serialize(item, seen);
        })
        .join(',')}]`;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON: only plain objects are allowed.');
    }
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serialize(record[key], seen)}`);
    return `{${members.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}
