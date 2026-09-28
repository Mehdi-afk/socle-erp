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

/** How values reach the SQL text: bound parameters (queries) or literals (policies). */
type Bind = (value: unknown) => Operand;

const parameter: Bind = (value) => sql`${value}`;

/**
 * A rule condition that cannot be expressed in a row-level security policy (relation paths,
 * placeholders with unsupported operators…): the policy generator replaces it with TRUE.
 */
export class NotMirrorable extends Error {}

/** SQL literal of a value (a policy cannot hold bound parameters). */
const literal: Bind = (value) => {
  if (value === null) return sql`null`;
  if (typeof value === 'string') {
    if (value.includes('\u0000')) throw new NotMirrorable('NUL character');
    return sql.lit(value);
  }
  if (typeof value === 'boolean') return sql.lit(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new NotMirrorable('non-finite number');
    return sql.lit(value);
  }
  if (Array.isArray(value)) {
    return value.length === 0
      ? sql`array[]`
      : sql`array[${sql.join(value.map((item) => literal(item)))}]`;
  }
  throw new NotMirrorable('unsupported literal');
};

const SETTINGS = {
  id: 'app.user_id',
  companyId: 'app.company_id',
  companyIds: 'app.company_ids',
  groupIds: 'app.group_ids',
} as const;

/**
 * A value of the acting user, read from the transaction's session settings in row-level
 * security policies (`app.user_id`, `app.company_id`, `app.company_ids`, `app.group_ids`).
 */
export class SessionValue {
  readonly key: keyof typeof SETTINGS;

  constructor(key: keyof typeof SETTINGS) {
    this.key = key;
  }

  get list(): boolean {
    return this.key === 'companyIds' || this.key === 'groupIds';
  }

  get setting(): Operand {
    return sql`nullif(current_setting(${sql.lit(SETTINGS[this.key])}, true), '')`;
  }
}

/** A condition whose value comes from the session (policy mode only). */
function sessionScalar(
  kind: ValueKind,
  column: Operand,
  operator: DomainOperator,
  value: SessionValue,
): Predicate {
  if (kind !== 'id' && kind !== 'text') throw new NotMirrorable(`$user value on a ${kind} field`);
  const text = kind === 'id' ? sql`${column}::text` : column;
  if (operator === '=' && !value.list) {
    // As in the ORM: an empty user value (no current company) matches an empty column.
    return sql<SqlBool>`(case when ${value.setting} is null then ${column} is null else ${text} = ${value.setting} end) is true`;
  }
  if (operator === 'in' && value.list) {
    return sql<SqlBool>`(${text} = any(string_to_array(coalesce(${value.setting}, ''), ','))) is true`;
  }
  throw new NotMirrorable(`$user value with operator "${operator}"`);
}

/** `column = value` with strict (`===`) semantics: a value of another type never matches. */
function equals(kind: ValueKind, column: Operand, value: unknown, bind: Bind): Predicate {
  switch (kind) {
    case 'id':
      return isRecordId(value) ? sql<SqlBool>`${column} = ${bind(value)}::uuid` : FALSE;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? sql<SqlBool>`${column} = ${bind(value)}::numeric`
        : FALSE;
    case 'boolean':
      return typeof value === 'boolean' ? sql<SqlBool>`${column} = ${bind(value)}` : FALSE;
    case 'decimal':
      // The reference compares the stored strings: "12.30" is not "12.3".
      return typeof value === 'string' ? sql<SqlBool>`${column}::text = ${bind(value)}` : FALSE;
    case 'date':
      return typeof value === 'string' && isCalendarDate(value)
        ? sql<SqlBool>`${column} = ${bind(value)}::date`
        : FALSE;
    case 'datetime':
      return typeof value === 'string' && isCanonicalInstant(value)
        ? sql<SqlBool>`${column} = ${bind(value)}::timestamptz`
        : FALSE;
    case 'json':
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? sql<SqlBool>`${column} = ${bind(JSON.stringify(value))}::jsonb`
        : FALSE;
    case 'text':
      return typeof value === 'string' ? sql<SqlBool>`${column} = ${bind(value)}` : FALSE;
  }
}

/** `column in (values)`: `= any(array)` for the common kinds, so long id lists stay one parameter. */
function isIn(kind: ValueKind, column: Operand, values: readonly unknown[], bind: Bind): Predicate {
  const parts: Predicate[] = [];
  if (values.includes(null)) parts.push(sql<SqlBool>`${column} is null`);
  const present = values.filter((value) => value !== null);
  if (kind === 'id') {
    const ids = [...new Set(present.filter(isRecordId))];
    if (ids.length > 0) parts.push(sql<SqlBool>`${column} = any(${bind(ids)}::uuid[])`);
  } else if (kind === 'text') {
    const texts = [...new Set(present.filter((value) => typeof value === 'string'))];
    if (texts.length > 0) parts.push(sql<SqlBool>`${column} = any(${bind(texts)}::text[])`);
  } else if (kind === 'number') {
    const numbers = [
      ...new Set(present.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))),
    ];
    if (numbers.length > 0) parts.push(sql<SqlBool>`${column} = any(${bind(numbers)}::numeric[])`);
  } else {
    for (const value of new Set(present)) parts.push(equals(kind, column, value, bind));
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
  bind: Bind,
): Predicate {
  const op = COMPARISON[operator];
  const operand = String(value);
  const bound = bind(operand);
  const numeric = typeof value === 'number' ? Number.isFinite(value) : isDecimalString(operand);
  const asText = sql<SqlBool>`(${textOf(kind, column)} collate "C") ${op} ${bound}`;
  switch (kind) {
    case 'number':
      // Two numbers compare as numbers whatever their text form (1e21); NaN matches nothing.
      if (typeof value === 'number') {
        return Number.isNaN(value) ? FALSE : sql<SqlBool>`${column} ${op} ${bound}::numeric`;
      }
      return isDecimalString(operand) ? sql<SqlBool>`${column} ${op} ${bound}::numeric` : asText;
    case 'decimal':
      return numeric && isDecimalString(operand)
        ? sql<SqlBool>`${column} ${op} ${bound}::numeric`
        : asText;
    case 'date':
      return isCalendarDate(operand) ? sql<SqlBool>`${column} ${op} ${bound}::date` : asText;
    case 'datetime':
      return isCanonicalInstant(operand)
        ? sql<SqlBool>`${column} ${op} ${bound}::timestamptz`
        : asText;
    case 'text':
      // A text value that looks like a decimal is compared numerically with a decimal operand.
      return numeric && isDecimalString(operand)
        ? sql<SqlBool>`case when ${column} ~ ${NUMERIC_TEXT} then ${column}::numeric ${op} ${bound}::numeric else (${column} collate "C") ${op} ${bound} end`
        : asText;
    default:
      return asText;
  }
}

/** LIKE without escape character: `%` and `_` are the only special characters, as in the reference. */
function like(column: Operand, pattern: string, caseInsensitive: boolean, bind: Bind): Predicate {
  return caseInsensitive
    ? sql<SqlBool>`lower(${column}) like lower(${bind(pattern)}) escape ''`
    : sql<SqlBool>`${column} like ${bind(pattern)} escape ''`;
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
  bind: Bind,
): Predicate {
  if (value instanceof SessionValue) return sessionScalar(kind, column, operator, value);
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
      predicate = equals(kind, column, value, bind);
      break;
    case 'in':
      predicate = isIn(kind, column, value as readonly unknown[], bind);
      break;
    case '<':
    case '<=':
    case '>':
    case '>=':
      predicate = compare(kind, column, operator, value, bind);
      break;
    case 'like':
    case 'ilike':
      predicate = like(textOf(kind, column), `%${String(value)}%`, operator === 'ilike', bind);
      break;
    case '=like':
    case '=ilike':
      predicate = like(textOf(kind, column), String(value), operator === '=ilike', bind);
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
  private readonly bind: Bind;
  private readonly registry: ModelRegistry;
  private readonly mode: 'query' | 'policy';

  /**
   * `policy`: compile for a row-level security policy — values become literals, `$user`
   * values ({@link SessionValue}) read the session settings, and paths through relations are
   * refused ({@link NotMirrorable}: a policy querying other tables could recurse through
   * their own policies).
   */
  constructor(registry: ModelRegistry, mode: 'query' | 'policy' = 'query') {
    this.registry = registry;
    this.mode = mode;
    this.bind = mode === 'policy' ? literal : parameter;
  }

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
    if (
      this.mode === 'policy' &&
      (rest.length > 0 || definition.type === 'one2many' || definition.type === 'many2many')
    ) {
      throw new NotMirrorable(`path "${path.join('.')}" crosses a relation`);
    }

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
      const matched = scalar('id', item, operator, value, this.bind);
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
    if (rest.length === 0)
      return scalar(kindOf(field, definition), column, operator, value, this.bind);

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
