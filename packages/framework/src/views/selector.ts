// SPDX-License-Identifier: LGPL-3.0-only
//
// View selectors (ARCHITECTURE.md §4.5): a small CSS-like language to point at a node of a
// view — `group[name='totals'] > field[name='amountUntaxed']`. Parsed by hand (no regular
// expression, no backtracking); an invalid selector is an explicit error.
import { SocleError } from '../errors.js';

/**
 * A view definition, extension or selector is invalid, or an extension cannot be applied.
 * @public
 */
export class ViewError extends SocleError {
  constructor(message: string) {
    super('views.definition', message);
  }
}

/** @public */
export interface SelectorStep {
  /** Node type, or `*` for any. */
  readonly type: string;
  /** Attribute conditions `[name='value']`. */
  readonly attributes: readonly (readonly [string, string])[];
  /** How this step relates to the previous one. */
  readonly combinator: 'descendant' | 'child';
}

const MAX_SELECTOR_LENGTH = 500;

const isNameChar = (char: string): boolean =>
  (char >= 'a' && char <= 'z') ||
  (char >= 'A' && char <= 'Z') ||
  (char >= '0' && char <= '9') ||
  char === '_' ||
  char === '-';

/**
 * Parses a selector: steps `type[attr='value']…` joined by a space (descendant) or `>`
 * (direct child). Values are quoted with `'` or `"`.
 * @throws {@link ViewError}
 * @public
 */
export function parseSelector(selector: string): SelectorStep[] {
  if (selector.length > MAX_SELECTOR_LENGTH) throw new ViewError('Selector too long.');
  const steps: SelectorStep[] = [];
  let i = 0;
  const fail = (message: string): never => {
    throw new ViewError(`Invalid selector "${selector}": ${message} (at ${String(i)}).`);
  };
  const skipSpaces = (): boolean => {
    const start = i;
    while (selector[i] === ' ') i++;
    return i > start;
  };
  const name = (): string => {
    const start = i;
    while (i < selector.length && isNameChar(selector[i] as string)) i++;
    if (i === start) fail('name expected');
    return selector.slice(start, i);
  };

  skipSpaces();
  let combinator: SelectorStep['combinator'] = 'descendant';
  while (i < selector.length) {
    let type = '*';
    if (selector[i] === '*') i++;
    else if (selector[i] !== '[') type = name();
    const attributes: [string, string][] = [];
    while (selector[i] === '[') {
      i++;
      const attribute = name();
      if (selector[i] !== '=') fail('"=" expected');
      i++;
      const quote = selector[i];
      if (quote !== "'" && quote !== '"') fail('quoted value expected');
      const end = selector.indexOf(quote as string, i + 1);
      if (end < 0) fail('unterminated value');
      attributes.push([attribute, selector.slice(i + 1, end)]);
      i = end + 1;
      if (selector[i] !== ']') fail('"]" expected');
      i++;
    }
    if (type === '*' && attributes.length === 0 && selector[i - 1] !== '*') fail('empty step');
    steps.push({ type, attributes, combinator });
    const spaced = skipSpaces();
    if (i >= selector.length) break;
    if (selector[i] === '>') {
      i++;
      skipSpaces();
      combinator = 'child';
    } else if (spaced) {
      combinator = 'descendant';
    } else {
      fail('unexpected character');
    }
    if (i >= selector.length) fail('step expected after combinator');
  }
  if (steps.length === 0) fail('empty selector');
  return steps;
}
