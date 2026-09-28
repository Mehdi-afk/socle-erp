// SPDX-License-Identifier: LGPL-3.0-only
//
// SQL identifiers are only ever derived from the model registry (never from user input) and
// are checked against a strict allow-list before use.
import { SchemaError } from './errors.js';

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** PostgreSQL truncates identifiers beyond 63 bytes: refuse them instead of colliding. */
export const MAX_IDENTIFIER_LENGTH = 63;

/** Checks an SQL identifier (lowercase snake_case, at most 63 characters) and returns it. */
export function identifier(name: string): string {
  if (!IDENTIFIER.test(name) || name.length > MAX_IDENTIFIER_LENGTH) {
    throw new SchemaError(
      `Invalid SQL identifier "${name}" (lowercase snake_case, at most ${String(MAX_IDENTIFIER_LENGTH)} characters).`,
    );
  }
  return name;
}

/**
 * Column name of a field: camelCase → snake_case (`partnerId` → `partner_id`). Injective on
 * field names (camelCase without underscores), so two fields never share a column.
 */
export function columnName(field: string): string {
  let result = '';
  for (const char of field) {
    const lower = char.toLowerCase();
    result += lower === char ? char : `_${lower}`;
  }
  return identifier(result);
}
