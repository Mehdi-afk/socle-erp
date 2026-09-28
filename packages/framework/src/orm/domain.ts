// SPDX-License-Identifier: LGPL-3.0-only
import { SocleError } from '../errors.js';
import type { FieldDefinition } from './fields.js';

/**
 * Comparison operators of a domain condition.
 * @public
 */
export type DomainOperator =
  | '='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'in'
  | 'not in'
  | 'like'
  | 'not like'
  | 'ilike'
  | 'not ilike'
  | '=like'
  | '=ilike';

/**
 * A condition `[field path, operator, value]`.
 * @public
 */
export type DomainCondition = readonly [string, DomainOperator, unknown];

/**
 * A search domain in prefix (Polish) notation, as in Odoo:
 * `[['state', '=', 'draft'], '|', ['amount', '>', 100], ['partnerId', '=', null]]`.
 * Consecutive conditions are implicitly combined with `&`.
 * @public
 */
export type Domain = readonly (DomainCondition | '&' | '|' | '!')[];

/**
 * Parsed, validated domain tree.
 * @public
 */
export type DomainNode =
  | { readonly kind: 'true' }
  | { readonly kind: 'and'; readonly children: readonly DomainNode[] }
  | { readonly kind: 'or'; readonly children: readonly DomainNode[] }
  | { readonly kind: 'not'; readonly child: DomainNode }
  | {
      readonly kind: 'condition';
      /** Field names from the model, e.g. `['partnerId', 'countryId', 'code']`. */
      readonly path: readonly string[];
      readonly operator: DomainOperator;
      readonly value: unknown;
    };

/**
 * The domain is malformed or references an unknown field.
 * @public
 */
export class DomainError extends SocleError {
  constructor(message: string) {
    super('orm.domain', message);
  }
}

const OPERATORS = new Set<string>([
  '=',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'in',
  'not in',
  'like',
  'not like',
  'ilike',
  'not ilike',
  '=like',
  '=ilike',
]);

const PATTERN_OPERATORS = new Set<string>([
  'like',
  'not like',
  'ilike',
  'not ilike',
  '=like',
  '=ilike',
]);
const ORDER_OPERATORS = new Set<string>(['<', '<=', '>', '>=']);
const TEXT_TYPES = new Set<string>(['char', 'text', 'html', 'selection', 'reference']);
const ORDERED_TYPES = new Set<string>([
  'char',
  'text',
  'integer',
  'decimal',
  'monetary',
  'date',
  'datetime',
  'selection',
]);

/**
 * Resolves a field of a model; returns undefined for an unknown field.
 * @public
 */
export type FieldResolver = (model: string, field: string) => FieldDefinition | undefined;

/**
 * Parses and validates a domain against the model's fields (allow-list: an unknown field,
 * an invalid path or an operator incompatible with the field type is rejected).
 * @throws {@link DomainError}
 * @public
 */
export function parseDomain(domain: Domain, model: string, resolve: FieldResolver): DomainNode {
  const terms: unknown = domain;
  if (!Array.isArray(terms)) throw new DomainError('A domain must be an array.');
  const list: readonly unknown[] = terms;
  let position = 0;

  const next = (): DomainNode => {
    if (position >= list.length) throw new DomainError('Missing operand in domain.');
    const term = list[position++];
    if (term === '&' || term === '|') {
      const left = next();
      const right = next();
      return { kind: term === '&' ? 'and' : 'or', children: [left, right] };
    }
    if (term === '!') return { kind: 'not', child: next() };
    return condition(term, model, resolve);
  };

  const parts: DomainNode[] = [];
  while (position < list.length) parts.push(next());
  if (parts.length === 0) return { kind: 'true' };
  return parts.length === 1 ? (parts[0] as DomainNode) : { kind: 'and', children: parts };
}

function condition(term: unknown, model: string, resolve: FieldResolver): DomainNode {
  if (!Array.isArray(term) || term.length !== 3) {
    throw new DomainError(`Invalid domain term ${JSON.stringify(term)}.`);
  }
  const items: readonly unknown[] = term;
  const [rawPath, operator, value] = [items[0], items[1], items[2]];
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new DomainError('A condition starts with a field path.');
  }
  if (typeof operator !== 'string' || !OPERATORS.has(operator)) {
    throw new DomainError(`Unknown operator ${JSON.stringify(operator)}.`);
  }
  const path = rawPath.split('.');
  let current = model;
  let definition: FieldDefinition | undefined;
  for (const [index, name] of path.entries()) {
    definition = resolve(current, name);
    if (!definition) throw new DomainError(`Unknown field "${name}" on model "${current}".`);
    if (index < path.length - 1) {
      if (definition.comodel === undefined) {
        throw new DomainError(
          `"${name}" on "${current}" is not relational: cannot follow "${rawPath}".`,
        );
      }
      current = definition.comodel;
    }
  }
  const last = definition as FieldDefinition;
  checkOperand(rawPath, last, operator as DomainOperator, value);
  return { kind: 'condition', path, operator: operator as DomainOperator, value };
}

function checkOperand(
  path: string,
  definition: FieldDefinition,
  operator: DomainOperator,
  value: unknown,
): void {
  const fail = (message: string): never => {
    throw new DomainError(`Condition on "${path}": ${message}`);
  };
  if (operator === 'in' || operator === 'not in') {
    if (!Array.isArray(value)) fail(`"${operator}" expects an array`);
    return;
  }
  if (PATTERN_OPERATORS.has(operator)) {
    if (!TEXT_TYPES.has(definition.type)) fail(`"${operator}" only applies to text fields`);
    if (typeof value !== 'string') fail(`"${operator}" expects a string`);
    return;
  }
  if (ORDER_OPERATORS.has(operator)) {
    if (!ORDERED_TYPES.has(definition.type))
      fail(`"${operator}" does not apply to ${definition.type}`);
    if (value === null) fail(`"${operator}" cannot compare with null`);
  }
  if (value !== null && typeof value === 'object') fail('the value must be a scalar');
}

/**
 * SQL-like pattern matching (`%` = any sequence, `_` = any character) without regular
 * expressions: linear-space greedy algorithm, immune to catastrophic backtracking.
 * @public
 */
export function matchesPattern(text: string, pattern: string, caseInsensitive: boolean): boolean {
  const t = caseInsensitive ? text.toLowerCase() : text;
  const p = caseInsensitive ? pattern.toLowerCase() : pattern;
  let ti = 0;
  let pi = 0;
  let star = -1;
  let mark = 0;
  while (ti < t.length) {
    if (pi < p.length && (p[pi] === '_' || (p[pi] !== '%' && p[pi] === t[ti]))) {
      ti++;
      pi++;
    } else if (pi < p.length && p[pi] === '%') {
      star = pi++;
      mark = ti;
    } else if (star !== -1) {
      pi = star + 1;
      ti = ++mark;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === '%') pi++;
  return pi === p.length;
}

const INTEGER_STRING = /^-?\d+$/;
const FRACTION_STRING = /^-?\d+\.\d+$/;

/**
 * A decimal string such as `-12` or `12.345` (flat regexes: no backtracking risk).
 * @public
 */
export function isDecimalString(text: string): boolean {
  return INTEGER_STRING.test(text) || FRACTION_STRING.test(text);
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const x = String(a);
  const y = String(b);
  // Decimal strings compare numerically; dates and datetimes (ISO) compare as strings.
  if (isDecimalString(x) && isDecimalString(y)) return Number(x) - Number(y);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Tests one scalar field value against a condition (in-memory evaluation, used by the
 * reference store and by client-side filtering). For x2many fields, pass the array of ids:
 * the condition holds when it holds for at least one element (or for `= null` when empty).
 * @public
 */
export function matchesCondition(
  fieldValue: unknown,
  operator: DomainOperator,
  operand: unknown,
): boolean {
  if (Array.isArray(fieldValue)) {
    if (operand === null && (operator === '=' || operator === '!=')) {
      return operator === '=' ? fieldValue.length === 0 : fieldValue.length > 0;
    }
    if (operator === 'not in' || operator === '!=' || operator.startsWith('not ')) {
      return !fieldValue.some((item) => matchesCondition(item, negate(operator), operand));
    }
    return fieldValue.some((item) => matchesCondition(item, operator, operand));
  }
  switch (operator) {
    case '=':
      return fieldValue === operand || (fieldValue === null && operand === false);
    case '!=':
      return !matchesCondition(fieldValue, '=', operand);
    case 'in':
      return (operand as readonly unknown[]).includes(fieldValue);
    case 'not in':
      return !(operand as readonly unknown[]).includes(fieldValue);
    case '<':
    case '<=':
    case '>':
    case '>=': {
      if (fieldValue === null) return false;
      const c = compare(fieldValue, operand);
      return operator === '<'
        ? c < 0
        : operator === '<='
          ? c <= 0
          : operator === '>'
            ? c > 0
            : c >= 0;
    }
    case 'like':
    case 'ilike':
      return (
        typeof fieldValue === 'string' &&
        matchesPattern(fieldValue, `%${String(operand)}%`, operator === 'ilike')
      );
    case 'not like':
    case 'not ilike':
      return !matchesCondition(fieldValue, operator === 'not like' ? 'like' : 'ilike', operand);
    case '=like':
    case '=ilike':
      return (
        typeof fieldValue === 'string' &&
        matchesPattern(fieldValue, String(operand), operator === '=ilike')
      );
  }
}

function negate(operator: DomainOperator): DomainOperator {
  switch (operator) {
    case '!=':
      return '=';
    case 'not in':
      return 'in';
    case 'not like':
      return 'like';
    case 'not ilike':
      return 'ilike';
    default:
      return operator;
  }
}

/**
 * Combines domains with AND (useful to add record rules to a user search).
 * @public
 */
export function andNodes(...nodes: DomainNode[]): DomainNode {
  const children = nodes.filter((node) => node.kind !== 'true');
  if (children.length === 0) return { kind: 'true' };
  return children.length === 1 ? (children[0] as DomainNode) : { kind: 'and', children };
}
