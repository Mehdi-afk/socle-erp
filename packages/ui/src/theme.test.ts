// SPDX-License-Identifier: LGPL-3.0-only
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { applyPreferences, categoryOf, directionOf, formatCount, initialsOf } from './theme.js';

describe('direction', () => {
  it('is right to left for Arabic and the other right-to-left languages only', () => {
    for (const tag of ['ar', 'ar-DZ', 'AR', 'ar_dz', ' ar ', 'he', 'fa-IR', 'ur']) {
      expect(directionOf(tag), tag).toBe('rtl');
    }
    for (const tag of ['fr', 'fr-FR', 'en', 'en-GB', 'de', '', 'arm', 'zh-Hans']) {
      expect(directionOf(tag), tag).toBe('ltr');
    }
  });
});

describe('preferences', () => {
  it('are put on the root element', () => {
    const root = document.createElement('html');
    applyPreferences(root, { theme: 'dark', density: 'compact', language: 'ar-DZ' });
    expect(root.dataset.theme).toBe('dark');
    expect(root.dataset.density).toBe('compact');
    expect(root.lang).toBe('ar-DZ');
    expect(root.dir).toBe('rtl');
    applyPreferences(root, { theme: 'hybrid', density: 'comfortable', language: 'fr' });
    expect([root.dataset.theme, root.dataset.density, root.lang, root.dir]).toEqual([
      'hybrid',
      'comfortable',
      'fr',
      'ltr',
    ]);
  });
});

describe('counters', () => {
  it('cap at the maximum', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(7)).toBe('7');
    expect(formatCount(99)).toBe('99');
    expect(formatCount(100)).toBe('99+');
    expect(formatCount(1000, 9)).toBe('9+');
    expect(formatCount(3.9)).toBe('3');
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(formatCount(bad)).toBe('0');
  });
});

describe('initials and colours of people', () => {
  it('take the first letters of the first and last words', () => {
    expect(initialsOf('Amel Benali')).toBe('AB');
    expect(initialsOf('amel')).toBe('A');
    expect(initialsOf('  ')).toBe('');
    expect(initialsOf('jean-pierre  dupont')).toBe('JD');
    expect(initialsOf('عمر خالد')).toBe('عخ');
    expect(initialsOf('Élodie Émile')).toBe('ÉÉ');
    // A letter outside the basic plane counts as one character.
    expect(initialsOf('𝒜lice')).toHaveLength(2);
  });

  it('give the same person the same category, between 1 and 8, and use them all', () => {
    expect(categoryOf('Amel Benali')).toBe(categoryOf('Amel Benali'));
    fc.assert(
      fc.property(fc.string(), (name) => {
        const category = categoryOf(name);
        expect(Number.isInteger(category) && category >= 1 && category <= 8).toBe(true);
      }),
    );
    const seen = new Set(Array.from({ length: 400 }, (_, i) => categoryOf(`Person ${String(i)}`)));
    expect(seen.size).toBe(8);
  });
});
