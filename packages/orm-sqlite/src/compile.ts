// SPDX-License-Identifier: LGPL-3.0-only
//
// Domain → SQLite. Paths through relations are joined in SQL; the condition on the final value
// is evaluated by the reference implementation (`socle_match`, see functions.ts). Values are
// bound parameters; identifiers come from the registry through the allow-list.
import {
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

import { columnName, identifier, LocalSchemaError, relationTable, valueKind } from './schema.js';

type Predicate = RawBuilder<SqlBool>;
type Operand = RawBuilder<unknown>;

const TRUE: Predicate = sql<SqlBool>`1`;
const FALSE: Predicate = sql<SqlBool>`0`;

const NEGATIVE: Partial<Record<DomainOperator, DomainOperator>> = {
  '!=': '=',
  'not in': 'in',
  'not like': 'like',
  'not ilike': 'ilike',
};

const match = (
  kind: string,
  value: Operand,
  operator: DomainOperator,
  operand: unknown,
): Predicate =>
  // Constant function name (see MATCH_FUNCTION in functions.ts).
  sql<SqlBool>`socle_match(${kind}, ${value}, ${operator}, ${JSON.stringify(operand)})`;

function or(parts: readonly Predicate[]): Predicate {
  if (parts.length === 0) return FALSE;
  return parts.length === 1
    ? (parts[0] as Predicate)
    : sql<SqlBool>`(${sql.join(parts, sql` or `)})`;
}

function and(parts: readonly Predicate[]): Predicate {
  if (parts.length === 0) return TRUE;
  return parts.length === 1
    ? (parts[0] as Predicate)
    : sql<SqlBool>`(${sql.join(parts, sql` and `)})`;
}

export class LocalDomainCompiler {
  private counter = 0;
  private readonly registry: ModelRegistry;

  constructor(registry: ModelRegistry) {
    this.registry = registry;
  }

  root(): string {
    return this.alias();
  }

  column(alias: string, field: string): Operand {
    return sql.ref(`${identifier(alias)}.${columnName(field)}`);
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

  /** `ORDER BY` as the reference: nulls last (first when descending), decimals by value, id last. */
  order(meta: ModelMeta, alias: string, terms: readonly OrderTerm[]): Operand {
    const parts = terms.map(({ field, direction }) => {
      const definition = this.field(meta, field);
      const column = this.column(alias, field);
      const key = definition.type === 'decimal' ? sql`cast(${column} as real)` : column;
      return direction === 'asc'
        ? sql`${column} is null, ${key} asc`
        : sql`${column} is null desc, ${key} desc`;
    });
    parts.push(sql`${this.column(alias, 'id')} asc`);
    return sql.join(parts, sql`, `);
  }

  private alias(): string {
    return `t${String(this.counter++)}`;
  }

  private field(meta: ModelMeta, field: string): FieldDefinition {
    const definition = meta.fields.get(field);
    if (!definition) throw new LocalSchemaError(`Unknown field "${meta.name}.${field}".`);
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
    const nullMatches = matchesCondition(null, operator, value);

    if (definition.type === 'one2many' || definition.type === 'many2many') {
      const child = this.alias();
      let source: Operand;
      let link: Predicate;
      let item: Operand;
      if (definition.type === 'one2many') {
        const target = this.registry.get(definition.comodel ?? '');
        source = sql`${sql.table(identifier(target.table))} as ${sql.id(child)}`;
        link = sql<SqlBool>`${this.column(child, definition.inverse ?? '')} = ${this.column(alias, 'id')}`;
        item = this.column(child, 'id');
      } else {
        source = sql`${sql.table(relationTable(meta, field, definition))} as ${sql.id(child)}`;
        link = sql<SqlBool>`${sql.ref(`${child}.source_id`)} = ${this.column(alias, 'id')}`;
        item = sql.ref(`${child}.target_id`);
      }
      const none = sql<SqlBool>`not exists (select 1 from ${source} where ${link})`;
      if (rest.length > 0) {
        const target = this.registry.get(definition.comodel ?? '');
        const next = this.alias();
        const inner = this.path(target, next, rest, operator, value);
        const found = sql<SqlBool>`exists (select 1 from ${source} join ${sql.table(identifier(target.table))} as ${sql.id(next)} on ${this.column(next, 'id')} = ${item} where ${link} and ${inner})`;
        return nullMatches ? or([found, none]) : found;
      }
      // The value is the list of related ids: `= null` means "none", otherwise "some id matches".
      if (operator === '=' && value === null) return none;
      return sql<SqlBool>`exists (select 1 from ${source} where ${link} and ${match('text', item, operator, value)})`;
    }

    if (!isStoredColumn(definition)) {
      throw new LocalSchemaError(
        `"${meta.name}.${field}" is not stored: the ORM must rewrite it first.`,
      );
    }
    const column = this.column(alias, field);
    if (rest.length === 0) return match(valueKind(definition), column, operator, value);

    const target = this.registry.get(definition.comodel ?? '');
    const table = sql.table(identifier(target.table));
    const next = this.alias();
    const inner = this.path(target, next, rest, operator, value);
    const found = sql<SqlBool>`exists (select 1 from ${table} as ${sql.id(next)} where ${this.column(next, 'id')} = ${column} and ${inner})`;
    if (!nullMatches) return found;
    const missing = this.alias();
    return or([
      found,
      sql<SqlBool>`not exists (select 1 from ${table} as ${sql.id(missing)} where ${this.column(missing, 'id')} = ${column})`,
    ]);
  }
}
