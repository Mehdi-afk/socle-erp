// SPDX-License-Identifier: LGPL-3.0-only
//
// SQL functions implemented with the reference semantics of @socle/framework: a condition on
// one value is evaluated by `matchesCondition` itself, so the SQLite storage cannot drift from
// the in-memory specification (null handling, `= false`, strict equality, numeric-or-text
// comparison, LIKE patterns, case folding of non-ASCII letters…).
import { matchesCondition, type DomainOperator } from '@socle/framework';

import type { SqliteConnection, SqliteValue } from './driver.js';

/** How a stored SQLite value maps back to the ORM's value. */
export type ValueKind = 'boolean' | 'json' | 'number' | 'text';

/** Decodes a stored value (0/1 booleans, JSON text, bigint) to the ORM's representation. */
export function decodeValue(kind: ValueKind, value: SqliteValue): unknown {
  if (value === null) return null;
  if (typeof value === 'bigint') return Number(value);
  if (kind === 'boolean') return value !== 0;
  if (kind === 'json' && typeof value === 'string') return JSON.parse(value) as unknown;
  return value;
}

const OPERATORS = new Set<string>([
  '=',
  'in',
  '<',
  '<=',
  '>',
  '>=',
  'like',
  'ilike',
  '=like',
  '=ilike',
]);

/** Name of the SQL function: `socle_match(kind, value, operator, operandJson)` → 0 or 1. */
export const MATCH_FUNCTION = 'socle_match';

/** Registers the reference functions on a connection. */
export function registerFunctions(connection: SqliteConnection): void {
  const operands = new Map<string, unknown>();
  connection.defineFunction(MATCH_FUNCTION, (kind, value, operator, operand) => {
    if (typeof operator !== 'string' || !OPERATORS.has(operator) || typeof operand !== 'string') {
      throw new Error(`${MATCH_FUNCTION}: invalid arguments`);
    }
    let parsed = operands.get(operand);
    if (parsed === undefined && !operands.has(operand)) {
      parsed = JSON.parse(operand) as unknown;
      if (operands.size > 256) operands.clear();
      operands.set(operand, parsed);
    }
    let decoded = decodeValue(kind as ValueKind, value);
    // As in the reference storage: a JSON array is an opaque value, not a list of ids.
    if (kind === 'json' && Array.isArray(decoded)) decoded = { json: decoded };
    return matchesCondition(decoded, operator as DomainOperator, parsed) ? 1 : 0;
  });
}
