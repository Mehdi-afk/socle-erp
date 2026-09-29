// SPDX-License-Identifier: LGPL-3.0-only
//
// Design system of the web client (docs/design/direction-visuelle.md): tokens, colour rules and,
// as they are built, the components.
export const PACKAGE_NAME = '@socle/ui';

export { DEFAULT_ACCENT, deriveAccent } from './accent.js';
export type { AccentCheck, AccentTokens } from './accent.js';
export { bestOn, CONTRAST, contrastRatio, isHexColor, mix, relativeLuminance } from './color.js';
export { tokensCss } from './css.js';
export {
  CATEGORY_COUNT,
  contrastPairs,
  FOCUS_BACKGROUNDS,
  scale,
  THEME_NAMES,
  themes,
} from './tokens.js';
export type {
  CategoryToken,
  ColorToken,
  ContrastPair,
  SemanticName,
  ThemeColors,
  ThemeName,
} from './tokens.js';
