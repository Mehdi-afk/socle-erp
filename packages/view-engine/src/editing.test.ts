// SPDX-License-Identifier: LGPL-3.0-only
import { f, normalizeValue, type FieldDefinition } from '@socle/framework';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { changesOf, decimalToMinor, fromDraft, isEditable, toDraft } from './editing.js';
import type { Currency } from './format.js';
import type { FormField } from './form-model.js';

const EUR: Currency = { code: 'EUR', decimals: 2 };
const field = (definition: FieldDefinition, name = 'value'): FormField => ({
  name,
  definition,
  label: name,
  sensitive: definition.sensitive === true,
  widget: undefined,
  tones: undefined,
});

describe('editable fields', () => {
  it.each([
    f.char({ readonly: true }),
    f.integer({ compute: 'total' }),
    f.integer({ compute: 'total', store: true }),
    f.char({ related: 'partnerId.name' }),
    f.char({ related: 'partnerId.name', store: true }),
    f.char({ sensitive: true }),
    f.one2many('sale.line', 'orderId'),
    f.many2many('res.partner'),
    f.json(),
    f.html(),
    f.datetime(),
  ])('does not offer an input for protected or unsupported $type fields', (definition) => {
    expect(isEditable(field(definition), EUR)).toBe(false);
    expect(fromDraft(field(definition), 'new value', EUR)).toEqual({
      ok: false,
      problem: { code: 'invalid' },
    });
  });

  it('honors both model and view protection', () => {
    expect(isEditable({ ...field(f.char()), readonly: true }, EUR)).toBe(false);
    expect(isEditable({ ...field(f.char()), sensitive: true }, EUR)).toBe(false);
    expect(isEditable({ ...field(f.char({ sensitive: true })), sensitive: false }, EUR)).toBe(
      false,
    );
    expect(isEditable(field(f.char()), undefined)).toBe(true);
  });

  it.each([
    undefined,
    { ...EUR, decimals: -1 },
    { ...EUR, decimals: 1.5 },
    { ...EUR, decimals: Infinity },
  ])('requires usable currency metadata for amounts', (currency) => {
    expect(isEditable(field(f.monetary()), currency)).toBe(false);
    expect(toDraft(f.monetary(), 1, currency)).toBe('');
  });
});

describe('exact amounts', () => {
  it.each([
    ['12,50', 2, 1250],
    ['-0.05', 2, -5],
    ['1.23000', 2, 123],
    ['000.000', 0, 0],
    ['7', 0, 7],
    ['1.234', 3, 1234],
    ['90071992547409.91', 2, Number.MAX_SAFE_INTEGER],
    ['-90071992547409.91', 2, Number.MIN_SAFE_INTEGER],
    ['90071992547409.92', 2, '9007199254740992'],
  ] as const)('converts %s with %i decimals exactly', (draft, decimals, expected) => {
    expect(decimalToMinor(draft, decimals)).toBe(expected);
  });

  it.each(['1.001', '1e2', '1.2.3', 'Infinity', 'NaN', '', '1,234.50'])(
    'rejects %s without rounding',
    (draft) => {
      expect(decimalToMinor(draft, 2)).toBeUndefined();
    },
  );

  it.each([-1, 1.5, Infinity, NaN, 101])('rejects malformed decimal metadata %s', (decimals) => {
    expect(decimalToMinor('1', decimals)).toBeUndefined();
  });

  it('rejects amounts outside the safe integer contract of the ORM', () => {
    for (const draft of ['90071992547409.92', '-90071992547409.92']) {
      expect(fromDraft(field(f.monetary()), draft, EUR)).toEqual({
        ok: false,
        problem: { code: 'number' },
      });
    }
    expect(fromDraft(field(f.monetary()), '1.001', EUR)).toEqual({
      ok: false,
      problem: { code: 'decimals', max: 2 },
    });
  });

  it('round-trips every generated safe amount through an input and the ORM (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
        fc.integer({ min: 0, max: 4 }),
        (minor, decimals) => {
          const currency = { ...EUR, decimals };
          const amount = field(f.monetary());
          const parsed = fromDraft(amount, toDraft(amount.definition, minor, currency), currency);
          expect(parsed).toEqual({ ok: true, value: minor });
          if (parsed.ok)
            expect(normalizeValue(amount.name, amount.definition, parsed.value)).toBe(minor);
        },
      ),
    );
  });
});

describe('draft validation', () => {
  it.each([
    '2026-02-30',
    '2025-02-29',
    '1900-02-29',
    '2026-13-01',
    '2026-00-01',
    '2026-01-00',
    '2026-01-32',
    'not a date',
  ])('rejects the impossible date %s without throwing', (draft) => {
    expect(fromDraft(field(f.date()), draft, undefined)).toEqual({
      ok: false,
      problem: { code: 'date' },
    });
  });

  it.each(['2024-02-29', '2000-02-29', '2026-12-31'])('accepts the calendar date %s', (draft) => {
    expect(fromDraft(field(f.date()), draft, undefined)).toEqual({ ok: true, value: draft });
  });

  it('respects decimal precision as well as scale and normalizes redundant zeros', () => {
    const decimal = field(f.decimal({ digits: [5, 2] }));
    expect(fromDraft(decimal, '00012,3400', undefined)).toEqual({ ok: true, value: '12.34' });
    expect(fromDraft(decimal, '-0.000', undefined)).toEqual({ ok: true, value: '0' });
    expect(fromDraft(decimal, '1000.00', undefined)).toEqual({
      ok: false,
      problem: { code: 'number' },
    });
    expect(fromDraft(decimal, '1.234', undefined)).toEqual({
      ok: false,
      problem: { code: 'decimals', max: 2 },
    });
    expect(fromDraft(decimal, '1e2', undefined)).toEqual({
      ok: false,
      problem: { code: 'number' },
    });
  });

  it('normalizes blank optional numbers to the actual empty ORM value', () => {
    for (const definition of [f.integer(), f.monetary()]) {
      expect(fromDraft(field(definition), '  ', EUR)).toEqual({ ok: true, value: 0 });
    }
    expect(fromDraft(field(f.date()), '', undefined)).toEqual({ ok: true, value: null });
    expect(fromDraft(field(f.boolean({ required: true })), false, undefined)).toEqual({
      ok: true,
      value: false,
    });
    expect(fromDraft(field(f.integer({ required: true })), '0', undefined)).toEqual({
      ok: true,
      value: 0,
    });
    expect(fromDraft(field(f.integer({ required: true })), '', undefined)).toEqual({
      ok: false,
      problem: { code: 'required' },
    });
  });

  it('preserves prose exactly but refuses whitespace-only required text', () => {
    const draft = '  First line\nSecond line  ';
    expect(fromDraft(field(f.text()), draft, undefined)).toEqual({ ok: true, value: draft });
    expect(fromDraft(field(f.char()), '  ', undefined)).toEqual({ ok: true, value: '  ' });
    expect(fromDraft(field(f.char({ required: true })), '  ', undefined)).toEqual({
      ok: false,
      problem: { code: 'required' },
    });
    expect(fromDraft(field(f.char({ size: 3 })), 'abcd', undefined)).toEqual({
      ok: false,
      problem: { code: 'invalid' },
    });
  });

  it('checks selections and draft types while retaining opaque data-source relation IDs', () => {
    const selection = field(f.selection([['draft', 'Draft']]));
    expect(fromDraft(selection, 'done', undefined)).toEqual({
      ok: false,
      problem: { code: 'invalid' },
    });
    expect(fromDraft(selection, 'draft', undefined)).toEqual({ ok: true, value: 'draft' });
    expect(fromDraft(field(f.many2one('res.country')), 'c-dz', undefined)).toEqual({
      ok: true,
      value: 'c-dz',
    });
    expect(fromDraft(field(f.boolean()), 'false', undefined)).toEqual({
      ok: false,
      problem: { code: 'invalid' },
    });
    expect(fromDraft(field(f.char()), true, undefined)).toEqual({
      ok: false,
      problem: { code: 'invalid' },
    });
  });
});

describe('form changes', () => {
  it('sends only semantic changes, preserving unchanged whitespace, empty text and decimals', () => {
    const fields = [
      field(f.text(), 'note'),
      field(f.char(), 'name'),
      field(f.decimal(), 'rate'),
      field(f.integer(), 'count'),
      field(f.monetary(), 'amount'),
    ];
    expect(
      changesOf(
        fields,
        { note: '  note  ', name: '', rate: '-001.2000', count: 0, amount: 0 },
        { note: '  note  ', name: '', rate: '-1,20', count: '', amount: '' },
        () => EUR,
      ),
    ).toEqual({ values: {}, problems: {} });
    expect(
      changesOf(fields, { name: 'old', count: 2 }, { name: 'new', count: '' }, () => EUR),
    ).toEqual({ values: { name: 'new', count: 0 }, problems: {} });
  });

  it('does not serialize protected fields even if a draft was supplied', () => {
    const fields = [
      field(f.char({ readonly: true }), 'readonly'),
      field(f.integer({ compute: 'total', store: true }), 'computed'),
      field(f.char({ sensitive: true }), 'secret'),
      { ...field(f.char(), 'viewReadonly'), readonly: true },
    ];
    expect(
      changesOf(
        fields,
        {},
        { readonly: 'new', computed: '42', secret: 'new', viewReadonly: 'new' },
        () => EUR,
      ),
    ).toEqual({ values: {}, problems: {} });
  });

  it('returns per-field errors without losing other valid changes or including absent drafts', () => {
    const fields = [
      field(f.char(), 'name'),
      field(f.date(), 'date'),
      field(f.integer(), 'count'),
      field(f.char(), 'untouched'),
    ];
    expect(
      changesOf(
        fields,
        { name: 'old', untouched: 'keep' },
        { name: 'new', date: '2026-13-01', count: '9007199254740992' },
        () => undefined,
      ),
    ).toEqual({
      values: { name: 'new' },
      problems: { date: { code: 'date' }, count: { code: 'integer' } },
    });
  });
});
