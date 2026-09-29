// SPDX-License-Identifier: LGPL-3.0-only
//
// Colour maths for the design system: WCAG 2.2 contrast, mixing, and the choice of the text colour
// to put on a background. Pure functions on `#RRGGBB` strings, so the same code checks the design
// tokens in the tests and a company's custom accent at run time.

export type Rgb = readonly [number, number, number];

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** True for `#RGB` or `#RRGGBB`. */
export const isHexColor = (value: string): boolean => HEX.test(value);

/**
 * The channels of a `#RGB` or `#RRGGBB` colour.
 * @throws {RangeError} for anything else
 */
export function parseHex(hex: string): Rgb {
  const match = HEX.exec(hex);
  const digits = match?.[1];
  if (digits === undefined) throw new RangeError(`Not a hex colour: "${hex}".`);
  const full =
    digits.length === 3
      ? `${digits.charAt(0)}${digits.charAt(0)}${digits.charAt(1)}${digits.charAt(1)}${digits.charAt(2)}${digits.charAt(2)}`
      : digits;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

/** `#RRGGBB`, upper case. */
export function toHex(rgb: Rgb): string {
  return `#${rgb
    .map((channel) =>
      Math.max(0, Math.min(255, Math.round(channel)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase()}`;
}

const linear = (channel: number): number => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance, from 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio of two colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [la, lb] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `from` moved towards `to` by `weight` (0 to 1), channel by channel. */
export function mix(from: string, to: string, weight: number): string {
  const [a, b] = [parseHex(from), parseHex(to)];
  const w = Math.max(0, Math.min(1, weight));
  return toHex([a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w]);
}

/**
 * Of `candidates`, the colour with the best contrast on `background`, and that contrast. The first
 * candidate wins a tie, so the order expresses a preference.
 */
export function bestOn(
  background: string,
  candidates: readonly string[],
): { readonly color: string; readonly ratio: number } {
  let best = { color: candidates[0] ?? '#000000', ratio: 0 };
  for (const color of candidates) {
    const ratio = contrastRatio(color, background);
    if (ratio > best.ratio) best = { color, ratio };
  }
  return best;
}

/** WCAG AA thresholds used by the design system. */
export const CONTRAST = Object.freeze({
  /** Normal text. */
  text: 4.5,
  /** Non-text elements that carry meaning (icons, focus rings, chart marks). */
  graphic: 3,
  /** Text on the category pastels: comfortably above AA. */
  category: 7,
});
