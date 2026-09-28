// SPDX-License-Identifier: LGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { f, isRelational, isStoredColumn } from './fields.js';
import { emptyValue, FieldValueError, normalizeValue } from './values.js';

const ID = '0192f1e2-7c3a-7b6d-8e9f-0a1b2c3d4e5f';

describe('f builders', () => {
  it('produce frozen definitions with their type and options', () => {
    const amount = f.monetary({ required: true });
    expect(amount).toEqual({ type: 'monetary', required: true });
    expect(Object.isFrozen(amount)).toBe(true);
    expect(f.many2one('res.partner')).toEqual({
      type: 'many2one',
      comodel: 'res.partner',
      ondelete: 'set null',
    });
    expect(f.one2many('sale.order.line', 'orderId').inverse).toBe('orderId');
  });

  it('know which fields are columns', () => {
    expect(isStoredColumn(f.char())).toBe(true);
    expect(isStoredColumn(f.one2many('x.y', 'zId'))).toBe(false);
    expect(isStoredColumn(f.monetary({ compute: 'computeTotal' }))).toBe(false);
    expect(isStoredColumn(f.monetary({ compute: 'computeTotal', store: true }))).toBe(true);
    expect(isStoredColumn(f.char({ related: 'partnerId.name' }))).toBe(false);
    expect(isRelational(f.many2many('res.partner.category'))).toBe(true);
  });
});

describe('normalizeValue', () => {
  it.each([
    ['char', f.char(), 'abc', 'abc'],
    ['integer', f.integer(), 42, 42],
    ['monetary in cents', f.monetary(), 12_345, 12_345],
    ['decimal string', f.decimal({ digits: [10, 3] }), '12.345', '12.345'],
    ['boolean', f.boolean(), false, false],
    ['date', f.date(), '2026-02-28', '2026-02-28'],
    [
      'datetime with offset, normalized to UTC',
      f.datetime(),
      '2026-09-28T02:30:00+02:00',
      '2026-09-28T00:30:00.000Z',
    ],
    ['selection', f.selection([['draft', 'Brouillon']]), 'draft', 'draft'],
    ['many2one', f.many2one('res.partner'), ID, ID],
    ['many2many (deduplicated)', f.many2many('res.partner'), [ID, ID], [ID]],
    ['null x2many becomes empty', f.one2many('a.b', 'cId'), null, []],
    ['json', f.json(), { a: [1, 'x'] }, { a: [1, 'x'] }],
    ['reference', f.reference(), `res.partner,${ID}`, `res.partner,${ID}`],
    ['null', f.char(), null, null],
  ])('accepts %s', (_case, definition, value, expected) => {
    expect(normalizeValue('x', definition, value)).toEqual(expected);
  });

  it.each([
    ['a float amount', f.monetary(), 12.5],
    ['an unsafe integer', f.integer(), 2 ** 60],
    ['a decimal number (not a string)', f.decimal(), 1.5],
    ['a decimal beyond its digits', f.decimal({ digits: [5, 2] }), '1234.5'],
    ['an impossible date', f.date(), '2026-02-30'],
    ['a datetime without time zone', f.datetime(), '2026-09-28T10:00:00'],
    ['an unknown selection value', f.selection([['draft', 'Brouillon']]), 'done'],
    ['a non-id many2one', f.many2one('res.partner'), '42'],
    ['null for a boolean', f.boolean(), null],
    ['undefined', f.char(), undefined],
    ['a too long char', f.char({ size: 3 }), 'abcd'],
    ['a bad reference', f.reference(), 'res.partner,42'],
  ])('rejects %s', (_case, definition, value) => {
    expect(() => normalizeValue('x', definition, value)).toThrow(FieldValueError);
  });

  it('gives the empty value of each type', () => {
    expect(emptyValue(f.boolean())).toBe(false);
    expect(emptyValue(f.many2many('a.b'))).toEqual([]);
    expect(emptyValue(f.char())).toBeNull();
  });
});
