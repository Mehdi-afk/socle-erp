// SPDX-License-Identifier: LGPL-3.0-only
import { f, type FieldDefinition } from '@socle/framework';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { formatValue, minorToDecimal, type FormatContext } from './format.js';
import { humanize, resolveText } from './text.js';
import { windowOf } from './virtual.js';

describe('labels', () => {
  const text = { fr: 'Téléphone', en: 'Phone', ar: 'الهاتف' };

  it('come in the language of the user, then English, then French', () => {
    expect(resolveText(text, 'ar')).toBe('الهاتف');
    expect(resolveText(text, 'ar-DZ')).toBe('الهاتف');
    expect(resolveText(text, 'AR_dz')).toBe('الهاتف');
    expect(resolveText(text, 'en-GB')).toBe('Phone');
    expect(resolveText({ fr: 'Nom' }, 'ar')).toBe('Nom');
    expect(resolveText({ fr: 'Nom', en: 'Name' }, 'de')).toBe('Name');
    expect(resolveText({ fr: 'Nom', en: '' }, 'en')).toBe('Nom');
    expect(resolveText(undefined, 'fr', 'fallback')).toBe('fallback');
    expect(resolveText(undefined, 'fr')).toBe('');
    // A language tag that is a property of Object must not find one.
    expect(resolveText({ fr: 'Nom' }, 'constructor')).toBe('Nom');
    expect(resolveText({ fr: 'Nom' }, '__proto__')).toBe('Nom');
  });

  it('are made from a technical name when there is none', () => {
    expect(humanize('name')).toBe('Name');
    expect(humanize('stateId')).toBe('State');
    expect(humanize('categoryIds')).toBe('Category');
    expect(humanize('companyRegistry')).toBe('Company registry');
    expect(humanize('street2')).toBe('Street 2');
    expect(humanize('res_partner_id')).toBe('Res partner');
    expect(humanize('id')).toBe('Id');
    expect(humanize('')).toBe('');
  });
});

describe('amounts', () => {
  it('move the decimal point of an integer amount without any floating-point division', () => {
    expect(minorToDecimal(12345, 2)).toBe('123.45');
    expect(minorToDecimal(5, 2)).toBe('0.05');
    expect(minorToDecimal(-5, 2)).toBe('-0.05');
    expect(minorToDecimal(0, 2)).toBe('0.00');
    expect(minorToDecimal(7, 0)).toBe('7');
    expect(minorToDecimal(1234, 3)).toBe('1.234');
    expect(minorToDecimal('9007199254740993', 2)).toBe('90071992547409.93');
    expect(minorToDecimal(10n ** 20n, 2)).toBe('1000000000000000000.00');
    expect(() => minorToDecimal(1.5, 2)).toThrow(RangeError);
    expect(() => minorToDecimal('abc', 2)).toThrow(RangeError);
  });

  it('read back to the same integer (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 18n), max: 10n ** 18n }),
        fc.integer({ min: 0, max: 4 }),
        (minor, decimals) => {
          const text = minorToDecimal(minor, decimals);
          const [whole = '', fraction = ''] = text.replace('-', '').split('.');
          const back = BigInt(`${whole}${fraction}`) * (text.startsWith('-') ? -1n : 1n);
          expect(back).toBe(minor);
          expect(fraction).toHaveLength(decimals);
        },
      ),
    );
  });
});

describe('values on screen', () => {
  const fr: FormatContext = { language: 'fr', timeZone: 'Africa/Algiers', yes: 'Oui', no: 'Non' };
  const en: FormatContext = { language: 'en', timeZone: 'UTC', yes: 'Yes', no: 'No' };
  const show = (
    definition: FieldDefinition,
    value: unknown,
    context = fr,
    extras?: Parameters<typeof formatValue>[3],
  ) => formatValue(definition, value, context, extras);
  const nbsp = (text: string) => text.replace(/[\u00a0\u202f]/g, ' ');

  it('write text as it is and nothing for a missing value', () => {
    expect(show(f.char(), 'Amel')).toBe('Amel');
    expect(show(f.text(), 'a\nb')).toBe('a\nb');
    for (const type of [f.char(), f.integer(), f.date(), f.datetime(), f.selection([['a', 'A']])]) {
      expect(show(type, null)).toBe('');
      expect(show(type, undefined)).toBe('');
      expect(show(type, '')).toBe('');
    }
  });

  it('write booleans in words, and keep false apart from missing', () => {
    expect(show(f.boolean(), true)).toBe('Oui');
    expect(show(f.boolean(), false)).toBe('Non');
    expect(show(f.boolean(), false, en)).toBe('No');
    expect(show(f.boolean(), null)).toBe('');
  });

  it('group the digits of numbers the way the language does', () => {
    expect(nbsp(show(f.integer(), 1234567))).toBe('1 234 567');
    expect(show(f.integer(), 1234567, en)).toBe('1,234,567');
    expect(show(f.integer(), 0)).toBe('0');
    expect(nbsp(show(f.decimal({ digits: [12, 3] }), '1234.5'))).toBe('1 234,500');
    expect(show(f.decimal({ digits: [12, 2] }), '0.1', en)).toBe('0.10');
    // A decimal keeps its exact value: no float in between.
    expect(show(f.decimal({ digits: [20, 2] }), '12345678901234567.89', en)).toBe(
      '12,345,678,901,234,567.89',
    );
  });

  it('write money from minor units with the decimals of its currency', () => {
    const eur = { code: 'EUR', decimals: 2 };
    expect(nbsp(show(f.monetary(), 123456, fr, { currency: eur }))).toBe('1 234,56 €');
    expect(show(f.monetary(), 123456, en, { currency: eur })).toBe('€1,234.56');
    expect(nbsp(show(f.monetary(), 1234, en, { currency: { code: 'TND', decimals: 3 } }))).toBe(
      'TND 1.234',
    );
    expect(show(f.monetary(), 500, en, { currency: { code: 'JPY', decimals: 0 } })).toBe('¥500');
    expect(show(f.monetary(), -5, en, { currency: eur })).toBe('-€0.05');
    // An unknown currency code still shows the amount; no currency shows the raw number.
    expect(show(f.monetary(), 1234, en, { currency: { code: '???', decimals: 2 } })).toContain(
      '12.34',
    );
    expect(show(f.monetary(), 1234)).toBe('1234');
  });

  it('write a date as it is and a moment in the time zone of the user', () => {
    expect(show(f.date(), '2026-03-01')).toBe('1 mars 2026');
    expect(show(f.date(), '2026-03-01', en)).toBe('Mar 1, 2026');
    // 23:30 UTC on 28 February is already 1 March in Algiers (UTC+1); a date does not move.
    expect(nbsp(show(f.datetime(), '2026-02-28T23:30:00.000Z'))).toContain('1 mars 2026');
    expect(show(f.datetime(), '2026-02-28T23:30:00.000Z', en)).toContain('Feb 28, 2026');
    expect(show(f.date(), 'not a date')).toBe('not a date');
    expect(show(f.datetime(), 'not a date')).toBe('not a date');
    // An unknown time zone falls back to UTC instead of failing.
    expect(
      formatValue(f.datetime(), '2026-02-28T23:30:00.000Z', { ...en, timeZone: 'Not/AZone' }),
    ).toContain('Feb 28, 2026');
  });

  it('write the label of a selection, the name of a relation and the size of a list', () => {
    const kind = f.selection([
      ['person', 'Personne'],
      ['company', 'Société'],
    ]);
    expect(show(kind, 'company')).toBe('Société');
    expect(show(kind, 'unknown')).toBe('unknown');
    expect(show(f.many2one('res.country'), 'id', fr, { displayName: 'Algérie' })).toBe('Algérie');
    expect(show(f.many2one('res.country'), null)).toBe('');
    expect(show(f.many2many('res.groups', { relation: 'x' }), ['1', '2', '3'])).toBe('3');
    expect(show(f.json(), { a: 1 })).toBe('{"a":1}');
    expect(show(f.binary(), 'data')).toBe('');
  });
});

describe('virtual scrolling', () => {
  it('draws the top of a long list and stays inside it', () => {
    expect(windowOf({ scrollTop: 0, viewportHeight: 480, rowHeight: 48, total: 10_000 })).toEqual({
      start: 0,
      end: 17,
      offset: 0,
      height: 480_000,
    });
    const bottom = windowOf({
      scrollTop: 479_520,
      viewportHeight: 480,
      rowHeight: 48,
      total: 10_000,
    });
    expect(bottom.end).toBe(10_000);
    expect(bottom.height).toBe(480_000);
  });

  it('handles an empty list, a tiny list and a strange input', () => {
    expect(windowOf({ scrollTop: 0, viewportHeight: 480, rowHeight: 48, total: 0 })).toEqual({
      start: 0,
      end: 0,
      offset: 0,
      height: 0,
    });
    expect(
      windowOf({ scrollTop: 900, viewportHeight: 480, rowHeight: 48, total: 3 }),
    ).toMatchObject({
      start: 0,
      end: 3,
    });
    expect(windowOf({ scrollTop: -50, viewportHeight: -1, rowHeight: 48, total: 5 }).start).toBe(0);
    expect(windowOf({ scrollTop: 0, viewportHeight: 480, rowHeight: 0, total: 5 }).end).toBe(0);
  });

  it('always covers every visible row and never draws more than a screenful (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20_000 }),
        fc.constantFrom(32, 48),
        fc.integer({ min: 100, max: 1200 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (total, rowHeight, viewportHeight, ratio) => {
          const height = total * rowHeight;
          const scrollTop = Math.floor(ratio * Math.max(0, height - viewportHeight));
          const window = windowOf({ scrollTop, viewportHeight, rowHeight, total });
          expect(window.start).toBeGreaterThanOrEqual(0);
          expect(window.end).toBeLessThanOrEqual(total);
          expect(window.start).toBeLessThan(window.end);
          expect(window.offset).toBe(window.start * rowHeight);
          // Every row that is at least partly on screen is drawn.
          const firstVisible = Math.floor(scrollTop / rowHeight);
          const lastVisible = Math.min(
            total - 1,
            Math.floor((scrollTop + viewportHeight - 1) / rowHeight),
          );
          expect(window.start).toBeLessThanOrEqual(firstVisible);
          expect(window.end).toBeGreaterThan(lastVisible);
          // Never many more rows than fit on screen.
          expect(window.end - window.start).toBeLessThanOrEqual(
            Math.ceil(viewportHeight / rowHeight) + 1 + 12,
          );
        },
      ),
    );
  });
});
