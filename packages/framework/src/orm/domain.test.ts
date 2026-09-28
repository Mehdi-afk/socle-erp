// SPDX-License-Identifier: LGPL-3.0-only
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  andNodes,
  DomainError,
  matchesCondition,
  matchesPattern,
  parseDomain,
  type Domain,
  type FieldResolver,
} from './domain.js';
import { f, type FieldDefinition } from './fields.js';

const models: Record<string, Record<string, FieldDefinition>> = {
  'sale.order': {
    name: f.char(),
    state: f.selection([
      ['draft', 'Brouillon'],
      ['sale', 'Confirmé'],
    ]),
    amount: f.monetary(),
    partnerId: f.many2one('res.partner'),
    lines: f.one2many('sale.order.line', 'orderId'),
    confirmed: f.boolean(),
  },
  'res.partner': { name: f.char(), countryId: f.many2one('res.country') },
  'res.country': { code: f.char() },
  'sale.order.line': { orderId: f.many2one('sale.order'), qty: f.integer() },
};
const resolve: FieldResolver = (model, field) => models[model]?.[field];
const parse = (domain: Domain) => parseDomain(domain, 'sale.order', resolve);

describe('parseDomain', () => {
  it('returns "true" for an empty domain', () => {
    expect(parse([])).toEqual({ kind: 'true' });
  });

  it('combines consecutive conditions with AND', () => {
    expect(
      parse([
        ['state', '=', 'draft'],
        ['amount', '>', 100],
      ]),
    ).toEqual({
      kind: 'and',
      children: [
        { kind: 'condition', path: ['state'], operator: '=', value: 'draft' },
        { kind: 'condition', path: ['amount'], operator: '>', value: 100 },
      ],
    });
  });

  it('parses prefix operators', () => {
    const node = parse(['|', ['state', '=', 'draft'], '!', ['amount', '<', 10]]);
    expect(node).toEqual({
      kind: 'or',
      children: [
        { kind: 'condition', path: ['state'], operator: '=', value: 'draft' },
        { kind: 'not', child: { kind: 'condition', path: ['amount'], operator: '<', value: 10 } },
      ],
    });
  });

  it('follows relational paths', () => {
    expect(parse([['partnerId.countryId.code', '=', 'DZ']])).toMatchObject({
      path: ['partnerId', 'countryId', 'code'],
    });
  });

  it.each([
    ['an unknown field', [['secret', '=', 1]]],
    ['a path through a non-relational field', [['name.length', '=', 1]]],
    ['an unknown operator', [['name', 'LIKE', 'x']]],
    ['a SQL injection attempt as field', [['name; DROP TABLE x', '=', 1]]],
    ['a missing operand', ['|', ['name', '=', 'x']]],
    ['"in" without an array', [['state', 'in', 'draft']]],
    ['"like" on a number', [['amount', 'like', '1']]],
    ['"<" on a boolean', [['confirmed', '<', true]]],
    ['"<" with null', [['amount', '<', null]]],
    ['an object value', [['name', '=', { $ne: 1 }]]],
    ['a malformed term', [['name', '=']]],
    ['a non-array domain', 'state = draft'],
  ])('rejects %s', (_case, domain) => {
    expect(() => parse(domain as Domain)).toThrow(DomainError);
  });

  it('andNodes drops trivial nodes', () => {
    const condition = parse([['state', '=', 'draft']]);
    expect(andNodes({ kind: 'true' }, condition)).toBe(condition);
    expect(andNodes()).toEqual({ kind: 'true' });
  });
});

describe('matchesCondition', () => {
  it.each([
    ['draft', '=', 'draft', true],
    [null, '=', null, true],
    [null, '=', false, true],
    ['x', '!=', null, true],
    [5, 'in', [1, 5], true],
    [5, 'not in', [1, 5], false],
    [150, '>', 100, true],
    [null, '>', 100, false],
    ['12.50', '>=', '12.5', true],
    ['2026-01-02', '<', '2026-01-10', true],
    ['Société Générale', 'ilike', 'générale', true],
    ['Société Générale', 'like', 'générale', false],
    ['Société', 'not ilike', 'xyz', true],
    ['INV-2026-0001', '=like', 'INV-____-%', true],
    ['INV-26-1', '=like', 'INV-____-%', false],
  ])('%j %s %j → %s', (value, operator, operand, expected) => {
    expect(matchesCondition(value, operator as never, operand)).toBe(expected);
  });

  it('treats x2many values as "any element matches"', () => {
    expect(matchesCondition(['a', 'b'], 'in', ['b'])).toBe(true);
    expect(matchesCondition(['a', 'b'], 'not in', ['b'])).toBe(false);
    expect(matchesCondition([], '=', null)).toBe(true);
    expect(matchesCondition(['a'], '!=', null)).toBe(true);
  });
});

describe('matchesPattern', () => {
  it('agrees with a reference implementation on random inputs', () => {
    // Naive recursive matcher: exponential, but fine for the tiny inputs used here.
    const reference = (text: string, pattern: string): boolean => {
      if (pattern === '') return text === '';
      const head = pattern.charAt(0);
      if (head === '%') {
        return (
          reference(text, pattern.slice(1)) || (text !== '' && reference(text.slice(1), pattern))
        );
      }
      return (
        text !== '' &&
        (head === '_' || head === text.charAt(0)) &&
        reference(text.slice(1), pattern.slice(1))
      );
    };
    const alphabet = fc.constantFrom('a', 'b', '%', '_');
    fc.assert(
      fc.property(
        fc.string({ unit: alphabet, maxLength: 8 }),
        fc.string({ unit: alphabet, maxLength: 6 }),
        (text, pattern) => {
          expect(matchesPattern(text, pattern, false)).toBe(reference(text, pattern));
        },
      ),
    );
  });

  it('stays fast on adversarial patterns', () => {
    const start = Date.now();
    expect(matchesPattern('a'.repeat(5000), `${'%a'.repeat(200)}b`, false)).toBe(false);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
