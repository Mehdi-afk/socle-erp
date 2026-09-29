// SPDX-License-Identifier: LGPL-3.0-only
//
// Design system of the web client (docs/design/direction-visuelle.md): tokens, colour rules and,
// as they are built, the components.
export const PACKAGE_NAME = '@socle/ui';

export { DEFAULT_ACCENT, deriveAccent } from './accent.js';
export { Avatar, AvatarStack } from './components/avatar.js';
export type { AvatarProps, AvatarStackProps } from './components/avatar.js';
export { Badge, StatusPill } from './components/badge.js';
export type { BadgeProps, StatusPillProps, StatusTone } from './components/badge.js';
export { Button, IconButton } from './components/button.js';
export type { ButtonProps, ButtonVariant, IconButtonProps } from './components/button.js';
export { Card, FieldItem, FieldList } from './components/card.js';
export type { CardProps, FieldItemProps, FieldListProps } from './components/card.js';
export { Icon } from './components/icon.js';
export type { IconProps } from './components/icon.js';
export type { AccentCheck, AccentTokens } from './accent.js';
export { bestOn, CONTRAST, contrastRatio, isHexColor, mix, relativeLuminance } from './color.js';
export { tokensCss } from './css.js';
export { applyPreferences, categoryOf, directionOf, formatCount, initialsOf } from './theme.js';
export type { Density, Preferences } from './theme.js';
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
