// SPDX-License-Identifier: LGPL-3.0-only
//
// What the page needs from the user's preferences: the theme, the density, the language and its
// direction. The choices live as attributes on the root element; `tokens.css` reads them. The user's
// preference wins over the operating system's.
import type { ThemeName } from './tokens.js';

export type Density = 'comfortable' | 'compact';

/** Languages written from right to left that the client supports. */
const RTL_LANGUAGES: ReadonlySet<string> = new Set(['ar', 'he', 'fa', 'ur']);

/** `rtl` for Arabic (and other right-to-left languages), `ltr` otherwise. */
export function directionOf(language: string): 'ltr' | 'rtl' {
  const base = language.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return RTL_LANGUAGES.has(base) ? 'rtl' : 'ltr';
}

export interface Preferences {
  readonly theme: ThemeName;
  readonly density: Density;
  /** BCP 47 tag, e.g. `fr`, `en`, `ar`, `ar-DZ`. */
  readonly language: string;
}

/** Puts the preferences on the root element: `data-theme`, `data-density`, `lang`, `dir`. */
export function applyPreferences(root: HTMLElement, preferences: Preferences): void {
  root.dataset.theme = preferences.theme;
  root.dataset.density = preferences.density;
  root.lang = preferences.language;
  root.dir = directionOf(preferences.language);
}

/** The text of a counter, capped: `120` becomes `99+`. */
export function formatCount(count: number, max = 99): string {
  if (!Number.isFinite(count) || count < 0) return '0';
  return count > max ? `${String(max)}+` : String(Math.trunc(count));
}

/** Up to two capital letters from a name: "Amel Benali" → "AB", "amel" → "A". */
export function initialsOf(name: string): string {
  const words = name
    .normalize('NFC')
    .split(/[\s\-_.]+/)
    .filter((word) => word !== '');
  const first = Array.from(words[0] ?? '')[0] ?? '';
  const last = words.length > 1 ? (Array.from(words[words.length - 1] ?? '')[0] ?? '') : '';
  return `${first}${last}`.toLocaleUpperCase();
}

/**
 * A stable category (1 to 8) for a name, so that the same person always gets the same colour. The
 * colour only distinguishes people from each other: it never carries meaning.
 */
export function categoryOf(name: string, count = 8): number {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  return (hash % count) + 1;
}
