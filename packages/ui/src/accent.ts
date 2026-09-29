// SPDX-License-Identifier: LGPL-3.0-only
//
// The accent of a company (docs/design/direction-visuelle.md §2.1, §7): the administrator picks
// a colour; it is accepted only if the text that goes on it stays readable, and the tokens that
// depend on it are derived here. The same function runs in the tests (for the default accent) and
// in the settings screen (for a custom one), so there is one rule.
import { bestOn, CONTRAST, contrastRatio, isHexColor, mix, toHex, parseHex } from './color.js';

/** The default accent of a new company. */
export const DEFAULT_ACCENT = '#EBFF65';

/** The dark ink and the white the accent may carry as text, in order of preference. */
const INK = '#1B1B1D';
const WHITE = '#FFFFFF';
/** The application background behind the dark shell: the accent must stand out from it. */
const CANVAS = '#212025';
/** The label colour that appears on the soft variant of the accent. */
const LABEL = '#6B6E72';

/**
 * The most marked tint of `accent` (mixed with white, from half to 95 %) on which the labels stay
 * readable. A saturated accent gets a paler tint than a light one.
 */
function softTint(accent: string): string {
  let soft = mix(accent, WHITE, 0.95);
  for (let weight = 0.5; weight <= 0.95; weight += 0.05) {
    const candidate = mix(accent, WHITE, weight);
    if (contrastRatio(LABEL, candidate) >= CONTRAST.text) {
      soft = candidate;
      break;
    }
  }
  return soft;
}

/** The accent tokens that follow from one colour. */
export interface AccentTokens {
  readonly accent: string;
  /** Text and icons on the accent: dark ink or white, whichever reads best. */
  readonly onAccent: string;
  /** A pale tint for highlights and the "confidential data" card. */
  readonly accentSoft: string;
}

export type AccentCheck =
  | {
      readonly ok: true;
      readonly tokens: AccentTokens;
      readonly ratios: Readonly<Record<string, number>>;
    }
  | { readonly ok: false; readonly reasons: readonly string[] };

/**
 * Checks a company accent and derives its tokens. Refused when the text on it would reach less
 * than 4.5 : 1, when it would not stand out from the dark background (3 : 1), or when its soft
 * tint would make the labels unreadable.
 */
export function deriveAccent(input: string): AccentCheck {
  const value = input.trim();
  if (!isHexColor(value))
    return { ok: false, reasons: ['The accent must be a hex colour such as #EBFF65.'] };
  const accent = toHex(parseHex(value));
  const on = bestOn(accent, [INK, WHITE]);
  const soft = softTint(accent);
  const ratios = {
    onAccent: on.ratio,
    againstCanvas: contrastRatio(accent, CANVAS),
    labelOnSoft: contrastRatio(LABEL, soft),
    inkOnSoft: contrastRatio(INK, soft),
  };
  const reasons: string[] = [];
  if (ratios.onAccent < CONTRAST.text) {
    reasons.push(
      `Text on this accent reaches only ${ratios.onAccent.toFixed(1)} : 1 (4.5 : 1 is required).`,
    );
  }
  if (ratios.againstCanvas < CONTRAST.graphic) {
    reasons.push(
      `This accent is too close to the dark background (${ratios.againstCanvas.toFixed(1)} : 1, 3 : 1 is required).`,
    );
  }
  if (ratios.labelOnSoft < CONTRAST.text) {
    reasons.push('Labels would not be readable on the soft tint of this accent.');
  }
  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, tokens: { accent, onAccent: on.color, accentSoft: soft }, ratios };
}
