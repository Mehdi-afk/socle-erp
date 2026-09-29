// SPDX-License-Identifier: LGPL-3.0-only
//
// Design tokens (docs/design/direction-visuelle.md §2). Every component reads CSS variables built
// from these values; no colour is written anywhere else (stylelint enforces it). A test computes
// the contrast of every pair in `contrastPairs` for each theme, so a value that stops being
// readable fails the build.
import { DEFAULT_ACCENT, deriveAccent } from './accent.js';
import { CONTRAST, mix } from './color.js';

/** `hybrid`: dark shell, light content (default). `dark`: everything dark. `light`: everything light. */
export type ThemeName = 'hybrid' | 'dark' | 'light';
export const THEME_NAMES: readonly ThemeName[] = ['hybrid', 'dark', 'light'];

export const CATEGORY_COUNT = 8;
export type CategoryToken = `category${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;

const SEMANTIC = ['success', 'warning', 'danger', 'info'] as const;
export type SemanticName = (typeof SEMANTIC)[number];
type SemanticToken = SemanticName | `${SemanticName}Soft` | `${SemanticName}Text`;

export type ColorToken =
  | 'canvas'
  | 'shell'
  | 'shellText'
  | 'shellMuted'
  | 'surface'
  | 'surfaceSunken'
  | 'ink'
  | 'label'
  | 'line'
  | 'accent'
  | 'onAccent'
  | 'accentSoft'
  | 'navActive'
  | 'onNavActive'
  | 'link'
  | 'focusOuter'
  | 'focusInner'
  | 'onCategory'
  | CategoryToken
  | SemanticToken;

export type ThemeColors = Readonly<Record<ColorToken, string>>;

const INK = '#1B1B1D';
const accent = deriveAccent(DEFAULT_ACCENT);
if (!accent.ok) throw new Error('The default accent is not valid.');
const ACCENT = accent.tokens;

/** Pastel backgrounds for categories (activity types, labels, chart series). */
const PASTELS = [
  '#FEE3AA', // peach
  '#CEE5FF', // blue
  '#FCCCE7', // pink
  '#CDEFD9', // mint
  '#DDD6FB', // lavender
  '#FFD2C4', // coral
  '#C5EBEF', // sky
  '#D9DFE8', // slate
] as const;

const categories = (transform: (pastel: string) => string): Record<CategoryToken, string> =>
  Object.fromEntries(
    PASTELS.map((pastel, index) => [`category${String(index + 1)}`, transform(pastel)]),
  ) as Record<CategoryToken, string>;

/** Light content theme: the values of the "hybrid" cards and of the "light" page. */
const lightSemantic: Record<SemanticToken, string> = {
  success: '#2E8B57',
  successSoft: '#E1F4E8',
  successText: '#1B6B3A',
  warning: '#B77900',
  warningSoft: '#FFF1CF',
  warningText: '#8A5300',
  danger: '#D64040',
  dangerSoft: '#FDE3E1',
  dangerText: '#B3261E',
  info: '#3B7DDD',
  infoSoft: '#E1ECFC',
  infoText: '#1F5FBF',
};

const hybrid: ThemeColors = {
  canvas: '#212025',
  shell: '#2B2B2D',
  shellText: '#FFFFFF',
  shellMuted: '#A1A1A6',
  surface: '#FFFFFF',
  surfaceSunken: '#F6F6F4',
  ink: INK,
  label: '#6B6E72',
  line: '#EFEFEF',
  accent: ACCENT.accent,
  onAccent: ACCENT.onAccent,
  accentSoft: '#EFFCAA',
  navActive: '#4C458A',
  onNavActive: '#FFFFFF',
  link: '#2F55C8',
  focusOuter: INK,
  focusInner: '#FFFFFF',
  onCategory: INK,
  ...categories((pastel) => pastel),
  ...lightSemantic,
};

const dark: ThemeColors = {
  ...hybrid,
  surface: '#2B2B2D',
  surfaceSunken: '#252528',
  ink: '#F2F2F3',
  label: '#A1A1A6',
  line: '#3A3A3E',
  accentSoft: '#2F340F',
  link: '#9DB4FF',
  focusOuter: '#FFFFFF',
  focusInner: INK,
  onCategory: '#F2F2F3',
  // The pastels, darkened and desaturated so that light text reaches 7 : 1 on them.
  ...categories((pastel) => mix(pastel, INK, 0.78)),
  success: '#3FB97A',
  successSoft: '#1F3B2B',
  successText: '#7FD6A0',
  warning: '#E0A100',
  warningSoft: '#3F3010',
  warningText: '#F2C265',
  danger: '#F0645C',
  dangerSoft: '#4A1F1D',
  dangerText: '#FF9A93',
  info: '#5B9BFF',
  infoSoft: '#1D3050',
  infoText: '#8FB8FF',
};

const light: ThemeColors = {
  ...hybrid,
  canvas: '#F3F3F1',
  shell: '#FFFFFF',
  shellText: INK,
  shellMuted: '#5F6368',
  line: '#E4E4E1',
};

export const themes: Readonly<Record<ThemeName, ThemeColors>> = Object.freeze({
  hybrid,
  dark,
  light,
});

/** Everything that is not a colour: type, shape, spacing, motion, density. */
export const scale = Object.freeze({
  fontSans: "'Inter Variable', 'Noto Sans Arabic', system-ui, sans-serif",
  fontArabic: "'Noto Sans Arabic', 'Inter Variable', system-ui, sans-serif",
  titleSize: '1.875rem',
  titleWeight: '400',
  headingSize: '1.25rem',
  headingWeight: '500',
  bodySize: '0.875rem',
  labelSize: '0.8125rem',
  smallSize: '0.75rem',
  smallWeight: '500',
  radiusCard: '24px',
  radiusCardNarrow: '16px',
  radiusField: '12px',
  radiusPill: '999px',
  space: [0, 4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64],
  durationFast: '150ms',
  durationBase: '200ms',
  rowComfortable: '48px',
  rowCompact: '32px',
  cardPadding: '24px',
  cardPaddingCompact: '16px',
  /** Below this width the sidebar becomes a bottom bar and cards get the narrow radius. */
  narrowBreakpoint: '820px',
});

/**
 * The backgrounds a focus ring can appear on. The ring is double (focusOuter and
 * focusInner), so that on each of them at least one of the two reaches 3 : 1.
 */
export const FOCUS_BACKGROUNDS = [
  'canvas',
  'shell',
  'surface',
  'surfaceSunken',
  'accent',
  'navActive',
] as const satisfies readonly ColorToken[];

/** One pair of colours that appear together, and the contrast it must reach. */
export interface ContrastPair {
  readonly foreground: ColorToken;
  readonly background: ColorToken;
  readonly minimum: number;
  readonly use: string;
}

const pair = (
  foreground: ColorToken,
  background: ColorToken,
  minimum: number,
  use: string,
): ContrastPair => ({ foreground, background, minimum, use });

/**
 * Every foreground/background pair the components use, per theme. The `hybrid` theme puts the page
 * text (on the canvas) in the shell colours; `light` uses the ink.
 */
export function contrastPairs(theme: ThemeName): readonly ContrastPair[] {
  const text = CONTRAST.text;
  const pairs: ContrastPair[] = [
    pair('shellText', 'shell', text, 'sidebar text'),
    pair('shellMuted', 'shell', text, 'secondary text in the sidebar'),
    pair('ink', 'surface', text, 'card text'),
    pair('ink', 'surfaceSunken', text, 'text in a recessed area'),
    pair('label', 'surface', text, 'labels on a card'),
    pair('label', 'surfaceSunken', text, 'labels in a recessed area'),
    pair('label', 'accentSoft', text, 'labels on the confidential card'),
    pair('ink', 'accentSoft', text, 'values on the confidential card'),
    pair('onAccent', 'accent', text, 'text on the accent'),
    pair('onNavActive', 'navActive', text, 'active menu entry'),
    pair('link', 'surface', text, 'links on a card'),
    pair('link', 'surfaceSunken', text, 'links in a recessed area'),
    ...SEMANTIC.flatMap((name): ContrastPair[] => [
      pair(`${name}Text`, `${name}Soft`, text, `${name} pill text`),
      pair(`${name}Text`, 'surface', text, `${name} text on a card`),
      pair(name, 'surface', CONTRAST.graphic, `${name} dot next to its label`),
    ]),
    ...Array.from({ length: CATEGORY_COUNT }, (_, i) =>
      pair(
        'onCategory',
        `category${String(i + 1)}` as CategoryToken,
        CONTRAST.category,
        `category ${String(i + 1)}`,
      ),
    ),
  ];
  if (theme === 'hybrid' || theme === 'dark') {
    pairs.push(
      pair('shellText', 'canvas', text, 'page text on the dark canvas'),
      pair('shellMuted', 'canvas', text, 'secondary page text on the dark canvas'),
      pair('accent', 'canvas', CONTRAST.graphic, 'accent fill against the dark canvas'),
    );
  } else {
    pairs.push(
      pair('ink', 'canvas', text, 'page text on the light canvas'),
      pair('label', 'canvas', text, 'labels on the light canvas'),
      pair('shellMuted', 'canvas', text, 'secondary text on the light canvas'),
    );
  }
  return pairs;
}
