// SPDX-License-Identifier: LGPL-3.0-only
//
// Domain → SQL. The in-memory storage of @socle/framework is the executable specification:
// every predicate here reproduces its semantics exactly (null handling, negations, paths
// through relations), which the parity tests check against a real PostgreSQL.
//
// Values always travel as bound parameters; identifiers come from the model registry and go
// through `columnName` / `identifier` (allow-list) before reaching `sql.ref` / `sql.table`.
import {
  isDecimalString,
  isRecordId,
  isStoredColumn,
  matchesCondition,
  type DomainNode,
  type DomainOperator,
  type FieldDefinition,
  type ModelMeta,
  type ModelRegistry,
  type OrderTerm,
} from '@socle/framework';
import { sql, type RawBuilder, type SqlBool } from 'kysely';

import { SchemaError } from './errors.js';
import { columnName, identifier } from './naming.js';
import { relationTable } from './schema.js';

type Predicate = RawBuilder<SqlBool>;
type Operand = RawBuilder<unknown>;

const TRUE: Predicate = sql<SqlBool>`true`;
const FALSE: Predicate = sql<SqlBool>`false`;

/** Negative operators are evaluated as "no value matches the positive operator". */
const NEGATIVE: Partial<Record<DomainOperator, DomainOperator>> = {
  '!=': '=',
  'not in': 'in',
  'not like': 'like',
  'not ilike': 'ilike',
};

const COMPARISON = {
  '<': sql`<`,
  '<=': sql`<=`,
  '>': sql`>`,
  '>=': sql`>=`,
} as const;

type ComparisonOperator = keyof typeof COMPARISON;

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isCalendarDate(text: string): boolean {
  const match = CALENDAR_DATE.exec(text);
  if (!match) return false;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** The form the ORM stores instants in (`toISOString()`): only then is string order = time order. */
function isCanonicalInstant(text: string): boolean {
  const time = Date.parse(text);
  return !Number.isNaN(time) && new Date(time).toISOString() === text;
}

/** How a column's values look on the JavaScript side (the in-memory reference). */
type ValueKind = 'id' | 'number' | 'boolean' | 'decimal' | 'date' | 'datetime' | 'json' | 'text';

function kindOf(field: string, definition: FieldDefinition): ValueKind {
  if (field === 'id' || definition.type === 'many2one') return 'id';
  switch (definition.type) {
    case 'integer':
    case 'monetary':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'decimal':
      return 'decimal';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime';
    case 'json':
      return 'json';
    default:
      return 'text';
  }
}

/** The textual form the reference storage holds for a column (for text comparisons). */
function textOf(kind: ValueKind, column: Operand): Operand {
  switch (kind) {
    case 'text':
      return column;
    case 'datetime':
      return sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    default:
      return sql`${column}::text`;
  }
}

/** `column = value` with strict (`===`) semantics: a value of another type never matches. */
function equals(kind: ValueKind, column: Operand, value: unknown): Predicate {
  switch (kind) {
    case 'id':
      return isRecordId(value) ? sql<SqlBool>`${column} = ${value}::uuid` : FALSE;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? sql<SqlBool>`${column} = ${value}::numeric`
        : FALSE;
    case 'boolean':
      return typeof value === 'boolean' ? sql<SqlBool>`${column} = ${value}` : FALSE;
    case 'decimal':
      // The reference compares the stored strings: "12.30" is not "12.3".
      return typeof value === 'string' ? sql<SqlBool>`${column}::text = ${value}` : FALSE;
    case 'date':
      return typeof value === 'string' && isCalendarDate(value)
        ? sql<SqlBool>`${column} = ${value}::date`
        : FALSE;
    case 'datetime':
      return typeof value === 'string' && isCanonicalInstant(value)
        ? sql<SqlBool>`${column} = ${value}::timestamptz`
        : FALSE;
    case 'json':
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? sql<SqlBool>`${column} = ${JSON.stringify(value)}::jsonb`
        : FALSE;
    case 'text':
      return typeof value === 'string' ? sql<SqlBool>`${column} = ${value}` : FALSE;
  }
}

/** `column in (values)`: `= any(array)` for the common kinds, so long id lists stay one parameter. */
function isIn(kind: ValueKind, column: Operand, values: readonly unknown[]): Predicate {
  const parts: Predicate[] = [];
  if (values.includes(null)) parts.push(sql<SqlBool>`${column} is null`);
  const present = values.filter((value) => value !== null);
  if (kind === 'id') {
    const ids = [...new Set(present.filter(isRecordId))];
    if (ids.length > 0) parts.push(sql<SqlBool>`${column} = any(${ids}::uuid[])`);
  } else if (kind === 'text') {
    const texts = [...new Set(present.filter((value) => typeof value === 'string'))];
    if (texts.length > 0) parts.push(sql<SqlBool>`${column} = any(${texts}::text[])`);
  } else if (kind === 'number') {
    const numbers = [
      ...new Set(present.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))),
    ];
    if (numbers.length > 0) parts.push(sql<SqlBool>`${column} = any(${numbers}::numeric[])`);
  } else {
    for (const value of new Set(present)) parts.push(equals(kind, column, value));
  }
  return or(parts);
}

const NUMERIC_TEXT = sql`'^-?[0-9]+(\\.[0-9]+)?$'`;

/**
 * `column < value` (and <=, >, >=) as the reference `compare()` does it: numeric when both
 * sides are numbers or decimal strings, otherwise by code units (`COLLATE "C"`).
 */
function compare(
  kind: ValueKind,
  column: Operand,
  operator: ComparisonOperator,
  value: unknown,
): Predicate {
  const op = COMPARISON[operator];
  const operand = String(value);
  const numeric = typeof value === 'number' ? Number.isFinite(value) : isDecimalString(operand);
  const asText = sql<SqlBool>`(${textOf(kind, column)} collate "C") ${op} ${operand}`;
  switch (kind) {
    case 'number':
      // Two numbers compare as numbers whatever their text form (1e21); NaN matches nothing.
      if (typeof value === 'number') {
        return Number.isNaN(value) ? FALSE : sql<SqlBool>`${column} ${op} ${operand}::numeric`;
      }
      return isDecimalString(operand) ? sql<SqlBool>`${column} ${op} ${operand}::numeric` : asText;
    case 'decimal':
      return numeric && isDecimalString(operand)
        ? sql<SqlBool>`${column} ${op} ${operand}::numeric`
        : asText;
    case 'date':
      return isCalendarDate(operand) ? sql<SqlBool>`${column} ${op} ${operand}::date` : asText;
    case 'datetime':
      return isCanonicalInstant(operand)
        ? sql<SqlBool>`${column} ${op} ${operand}::timestamptz`
        : asText;
    case 'text':
      // A text value that looks like a decimal is compared numerically with a decimal operand.
      return numeric && isDecimalString(operand)
        ? sql<SqlBool>`case when ${column} ~ ${NUMERIC_TEXT} then ${column}::numeric ${op} ${operand}::numeric else (${column} collate "C") ${op} ${operand} end`
        : asText;
    default:
      return asText;
  }
}

/** LIKE without escape character: `%` and `_` are the only special characters, as in the reference. */
function like(column: Operand, pattern: string, caseInsensitive: boolean): Predicate {
  return caseInsensitive
    ? sql<SqlBool>`lower(${column}) like lower(${pattern}) escape ''`
    : sql<SqlBool>`${column} like ${pattern} escape ''`;
}

function or(parts: readonly Predicate[]): Predicate {
  if (parts.length === 0) return FALSE;
  if (parts.length === 1) return parts[0] as Predicate;
  return sql<SqlBool>`(${sql.join(parts, sql` or `)})`;
}

function and(parts: readonly Predicate[]): Predicate {
  if (parts.length === 0) return TRUE;
  if (parts.length === 1) return parts[0] as Predicate;
  return sql<SqlBool>`(${sql.join(parts, sql` and `)})`;
}

/** A scalar condition on one value; the result is never NULL (so that NOT stays exact). */
function scalar(
  kind: ValueKind,
  column: Operand,
  operator: DomainOperator,
  value: unknown,
): Predicate {
  let predicate: Predicate;
  switch (operator) {
    case '=':
      if (value === null) return sql<SqlBool>`${column} is null`;
      if (value === false) {
        // A null value also matches `= false` in the reference.
        return kind === 'boolean'
          ? sql<SqlBool>`(${column} = false or ${column} is null)`
          : sql<SqlBool>`${column} is null`;
      }
      predicate = equals(kind, column, value);
      break;
    case 'in':
      predicate = isIn(kind, column, value as readonly unknown[]);
      break;
    case '<':
    case '<=':
    case '>':
    case '>=':
      predicate = compare(kind, column, operator, value);
      break;
    case 'like':
    case 'ilike':
      predicate = like(textOf(kind, column), `%${String(value)}%`, operator === 'ilike');
      break;
    case '=like':
    case '=ilike':
      predicate = like(textOf(kind, column), String(value), operator === '=ilike');
      break;
    default:
      throw new SchemaError(`Operator "${operator}" must be compiled through its positive form.`);
  }
  return predicate === FALSE ? FALSE : sql<SqlBool>`(${predicate}) is true`;
}

/**
 * Compiles domains of one query; generates distinct aliases for the sub-queries it creates.
 */
export class DomainCompiler {
  private counter = 0;

  constructor(private readonly registry: ModelRegistry) {}

  /** Alias of the root table of a query. */
  root(): string {
    return this.alias();
  }

  compile(meta: ModelMeta, alias: string, node: DomainNode): Predicate {
    switch (node.kind) {
      case 'true':
        return TRUE;
      case 'and':
        return and(node.children.map((child) => this.compile(meta, alias, child)));
      case 'or':
        return or(node.children.map((child) => this.compile(meta, alias, child)));
      case 'not':
        return sql<SqlBool>`not (${this.compile(meta, alias, node.child)})`;
      case 'condition': {
        const positive = NEGATIVE[node.operator];
        if (positive)
          return sql<SqlBool>`not (${this.path(meta, alias, node.path, positive, node.value)})`;
        return this.path(meta, alias, node.path, node.operator, node.value);
      }
    }
  }

  /** `ORDER BY` terms, with the id as final tie-breaker (as the reference storage). */
  order(meta: ModelMeta, alias: string, terms: readonly OrderTerm[]): Operand {
    const parts = terms.map(({ field, direction }) => {
      const definition = this.field(meta, field);
      const column = this.column(alias, field);
      const kind = kindOf(field, definition);
      const key = kind === 'text' ? sql`${column} collate "C"` : column;
      return direction === 'asc' ? sql`${key} asc` : sql`${key} desc`;
    });
    parts.push(sql`${this.column(alias, 'id')} asc`);
    return sql.join(parts, sql`, `);
  }

  column(alias: string, field: string): Operand {
    return sql.ref(`${identifier(alias)}.${columnName(field)}`);
  }

  private alias(): string {
    return `t${String(this.counter++)}`;
  }

  private field(meta: ModelMeta, field: string): FieldDefinition {
    const definition = meta.fields.get(field);
    if (!definition) throw new SchemaError(`Unknown field "${meta.name}.${field}".`);
    return definition;
  }

  private path(
    meta: ModelMeta,
    alias: string,
    path: readonly string[],
    operator: DomainOperator,
    value: unknown,
  ): Predicate {
    const [field = '', ...rest] = path;
    const definition = this.field(meta, field);

    if (definition.type === 'one2many' || definition.type === 'many2many') {
      const { source, link, item } = this.children(meta, alias, field, definition);
      const none = sql<SqlBool>`not exists (select 1 from ${source} where ${link})`;
      if (rest.length > 0) {
        const target = this.registry.get(definition.comodel ?? '');
        const next = this.alias();
        const inner = this.path(target, next, rest, operator, value);
        const found = sql<SqlBool>`exists (select 1 from ${source} join ${sql.table(identifier(target.table))} as ${sql.id(next)} on ${this.column(next, 'id')} = ${item} where ${link} and ${inner})`;
        return matchesCondition(null, operator, value) ? or([found, none]) : found;
      }
      // The value is the list of related ids: `= null` means "none", otherwise "some id matches".
      if (operator === '=' && value === null) return none;
      const matched = scalar('id', item, operator, value);
      return matched === FALSE
        ? FALSE
        : sql<SqlBool>`exists (select 1 from ${source} where ${link} and ${matched})`;
    }

    if (!isStoredColumn(definition)) {
      throw new SchemaError(
        `"${meta.name}.${field}" is not stored: the ORM must rewrite it first.`,
      );
    }
    const column = this.column(alias, field);
    if (rest.length === 0) return scalar(kindOf(field, definition), column, operator, value);

    // many2one followed by more steps: the target record must match; a missing target counts
    // as a null value (reference semantics).
    const target = this.registry.get(definition.comodel ?? '');
    const next = this.alias();
    const table = sql.table(identifier(target.table));
    const inner = this.path(target, next, rest, operator, value);
    const found = sql<SqlBool>`exists (select 1 from ${table} as ${sql.id(next)} where ${this.column(next, 'id')} = ${column} and ${inner})`;
    if (!matchesCondition(null, operator, value)) return found;
    const missing = this.alias();
    return or([
      found,
      sql<SqlBool>`not exists (select 1 from ${table} as ${sql.id(missing)} where ${this.column(missing, 'id')} = ${column})`,
    ]);
  }

  /** The related rows of an x2many field: table, link to the parent row, related id. */
  private children(
    meta: ModelMeta,
    alias: string,
    field: string,
    definition: FieldDefinition,
  ): { source: Operand; link: Predicate; item: Operand } {
    const child = this.alias();
    if (definition.type === 'one2many') {
      const target = this.registry.get(definition.comodel ?? '');
      return {
        source: sql`${sql.table(identifier(target.table))} as ${sql.id(child)}`,
        link: sql<SqlBool>`${this.column(child, definition.inverse ?? '')} = ${this.column(alias, 'id')}`,
        item: this.column(child, 'id'),
      };
    }
    const rel = relationTable(meta, field, definition);
    return {
      source: sql`${sql.table(rel.table)} as ${sql.id(child)}`,
      link: sql<SqlBool>`${sql.ref(`${child}.${rel.source}`)} = ${this.column(alias, 'id')}`,
      item: sql.ref(`${child}.${rel.target}`),
    };
  }
}
