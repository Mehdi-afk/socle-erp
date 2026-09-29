// SPDX-License-Identifier: LGPL-3.0-only
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { DEFAULT_ACCENT, deriveAccent } from './accent.js';
import {
  bestOn,
  CONTRAST,
  contrastRatio,
  isHexColor,
  mix,
  parseHex,
  relativeLuminance,
  toHex,
} from './color.js';
import { tokensCss } from './css.js';
import { contrastPairs, FOCUS_BACKGROUNDS, THEME_NAMES, themes } from './tokens.js';

describe('colour maths', () => {
  it('reads and writes hex colours', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255]);
    expect(parseHex('#1b1B1d')).toEqual([27, 27, 29]);
    expect(toHex([27.4, 27, 300])).toBe('#1B1BFF');
    expect(isHexColor('#EBFF65')).toBe(true);
    for (const bad of ['EBFF65', '#EBFF6', '#GGGGGG', 'rgb(0,0,0)', '', '#12345678']) {
      expect(isHexColor(bad), bad).toBe(false);
      expect(() => parseHex(bad), bad).toThrow(RangeError);
    }
    fc.assert(
      fc.property(fc.tuple(fc.nat(255), fc.nat(255), fc.nat(255)), (rgb) => {
        expect(parseHex(toHex(rgb))).toEqual(rgb);
      }),
    );
  });

  it('computes the WCAG contrast (reference values)', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    // The classic #777 on white is 4.48 : 1, just under AA.
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 10);
    fc.assert(
      fc.property(fc.nat(0xffffff), fc.nat(0xffffff), (a, b) => {
        const [x, y] = [a, b].map((n) => `#${n.toString(16).padStart(6, '0')}`) as [string, string];
        const ratio = contrastRatio(x, y);
        expect(ratio).toBeGreaterThanOrEqual(1);
        expect(ratio).toBeLessThanOrEqual(21);
        expect(ratio).toBeCloseTo(contrastRatio(y, x), 10);
      }),
    );
  });

  it('mixes and picks the best text colour', () => {
    expect(mix('#000000', '#FFFFFF', 0.5)).toBe('#808080');
    expect(mix('#102030', '#FFFFFF', 0)).toBe('#102030');
    expect(mix('#102030', '#FFFFFF', 1)).toBe('#FFFFFF');
    expect(mix('#102030', '#FFFFFF', 7)).toBe('#FFFFFF');
    expect(bestOn('#FFFFFF', ['#777777', '#000000']).color).toBe('#000000');
    expect(bestOn('#000000', ['#777777', '#FFFFFF']).color).toBe('#FFFFFF');
    // A tie goes to the first candidate: the order expresses a preference.
    expect(bestOn('#808080', ['#FFFFFF', '#FFFFFF']).color).toBe('#FFFFFF');
  });
});

describe('design tokens', () => {
  for (const theme of THEME_NAMES) {
    it(`meet WCAG 2.2 AA in the ${theme} theme`, () => {
      const colors = themes[theme];
      const failures = contrastPairs(theme).flatMap((entry) => {
        const ratio = contrastRatio(colors[entry.foreground], colors[entry.background]);
        return ratio + 1e-9 >= entry.minimum
          ? []
          : [
              `${entry.use}: ${entry.foreground} on ${entry.background} is ${ratio.toFixed(2)} : 1, needs ${String(entry.minimum)}`,
            ];
      });
      expect(failures).toEqual([]);
    });

    it(`give the focus ring a visible ring on every background in the ${theme} theme`, () => {
      const colors = themes[theme];
      for (const background of FOCUS_BACKGROUNDS) {
        const best = Math.max(
          contrastRatio(colors.focusOuter, colors[background]),
          contrastRatio(colors.focusInner, colors[background]),
        );
        expect(best, background).toBeGreaterThanOrEqual(CONTRAST.graphic);
      }
    });

    it(`use valid, distinct colours in the ${theme} theme`, () => {
      const values = Object.values(themes[theme]);
      expect(values.every(isHexColor)).toBe(true);
      const categories = Object.entries(themes[theme])
        .filter(([name]) => name.startsWith('category'))
        .map(([, value]) => value);
      expect(categories).toHaveLength(8);
      expect(new Set(categories).size).toBe(8);
    });
  }

  it('keeps the values fixed by the visual direction for the default theme', () => {
    expect(themes.hybrid).toMatchObject({
      canvas: '#212025',
      shell: '#2B2B2D',
      surface: '#FFFFFF',
      ink: '#1B1B1D',
      label: '#6B6E72',
      accent: '#EBFF65',
      accentSoft: '#EFFCAA',
      navActive: '#4C458A',
    });
    // The accent is used as a background: the text on it is the dark ink, computed.
    expect(themes.hybrid.onAccent).toBe('#1B1B1D');
  });

  it('is not detectable through colour alone: the semantic colours differ from the accent', () => {
    const { success, warning, danger, info, accent } = themes.hybrid;
    for (const color of [success, warning, danger, info]) {
      expect(contrastRatio(color, accent)).toBeGreaterThan(1.5);
      expect(color).not.toBe(accent);
    }
  });
});

describe('company accent', () => {
  it('accepts the default accent and derives its tokens', () => {
    const result = deriveAccent(DEFAULT_ACCENT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tokens).toMatchObject({ accent: '#EBFF65', onAccent: '#1B1B1D' });
    expect(result.ratios.onAccent).toBeGreaterThan(15);
    // The tint is lighter than the accent and keeps the labels readable.
    expect(contrastRatio('#6B6E72', result.tokens.accentSoft)).toBeGreaterThanOrEqual(4.5);
    expect(relativeLuminance(result.tokens.accentSoft)).toBeGreaterThan(
      relativeLuminance(result.tokens.accent) - 0.2,
    );
  });

  it('chooses white text on a dark accent and refuses a mid-tone that suits neither', () => {
    // White text reads well on this teal (6.1 : 1) but it hardly stands out from the dark shell.
    const teal = deriveAccent('#0B6E63');
    expect(teal).toMatchObject({ ok: false });
    if (!teal.ok) expect(teal.reasons.join(' ')).toContain('too close to the dark background');
    // A mid blue: white text (4.6 : 1) is the better choice, chosen automatically.
    const blue = deriveAccent('#2F6FEB');
    expect(blue.ok && blue.tokens.onAccent).toBe('#FFFFFF');
    // A bright orange takes the dark ink.
    const orange = deriveAccent('#F59E0B');
    expect(orange.ok && orange.tokens.onAccent).toBe('#1B1B1D');
    // Neither the ink (4.47 : 1) nor white (3.85 : 1) reaches 4.5 : 1 on this blue.
    expect(deriveAccent('#3A7BFF')).toMatchObject({ ok: false });
    // A mid-grey has less than 4.5 : 1 with both the ink and white.
    const grey = deriveAccent('#777777');
    expect(grey).toMatchObject({ ok: false });
    if (!grey.ok) expect(grey.reasons.join(' ')).toContain('4.5');
  });

  it('refuses text that is not a hex colour, normalises the accepted ones', () => {
    for (const bad of ['', 'yellow', '#12', 'rgb(1,2,3)', '#GGGGGG']) {
      const result = deriveAccent(bad);
      expect(result.ok, bad).toBe(false);
    }
    const lower = deriveAccent('  #ebff65 ');
    expect(lower.ok && lower.tokens.accent).toBe('#EBFF65');
    const short = deriveAccent('#ff6');
    expect(short.ok && short.tokens.accent).toBe('#FFFF66');
  });

  it('never accepts an accent whose text falls below 4.5 : 1 (property)', () => {
    fc.assert(
      fc.property(fc.nat(0xffffff), (n) => {
        const hex = `#${n.toString(16).padStart(6, '0')}`;
        const result = deriveAccent(hex);
        if (!result.ok) return;
        expect(contrastRatio(result.tokens.onAccent, result.tokens.accent)).toBeGreaterThanOrEqual(
          4.5,
        );
        expect(contrastRatio(result.tokens.accent, '#212025')).toBeGreaterThanOrEqual(3);
        expect(contrastRatio('#6B6E72', result.tokens.accentSoft)).toBeGreaterThanOrEqual(4.5);
      }),
      { numRuns: 500 },
    );
  });
});

describe('generated stylesheet', () => {
  const css = tokensCss();

  it('is the committed tokens.css', () => {
    const committed = readFileSync(join(import.meta.dirname, 'tokens.css'), 'utf8');
    expect(committed).toBe(css);
  });

  it('defines every colour token in every theme, in kebab-case', () => {
    for (const theme of THEME_NAMES) {
      const block = css.split(`:root[data-theme='${theme}']`)[1] ?? css.split(':root,')[1] ?? '';
      for (const token of [
        'canvas',
        'shell-text',
        'surface-sunken',
        'nav-active',
        'category-1',
        'category-8',
        'success-soft',
        'danger-text',
      ]) {
        expect(block, `${theme} ${token}`).toContain(`--color-${token}:`);
      }
    }
    expect(css).toContain('--color-accent: #EBFF65;');
    expect(css).toContain('--radius-card: 24px;');
  });

  it('respects reduced motion, compact density, the narrow layout and Arabic', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('--duration-base: 0ms;');
    expect(css).toContain(":root[data-density='compact']");
    expect(css).toContain('--density-row: 32px;');
    expect(css).toContain('@media (width < 820px)');
    expect(css).toContain(':lang(ar)');
  });

  it('has no physical direction and no colour outside the variables', () => {
    expect(css).not.toMatch(/\b(left|right)\s*:/);
    expect(css).not.toMatch(/margin-(left|right)|padding-(left|right)|border-(left|right)/);
    // Colours are only ever defined as `--color-*: #hex;` (and the light theme's shadow).
    const stray = css
      .split('\n')
      .filter((line) => /#[0-9a-f]{6}/i.test(line) && !line.trimStart().startsWith('--color-'));
    expect(stray).toEqual([]);
  });
});
