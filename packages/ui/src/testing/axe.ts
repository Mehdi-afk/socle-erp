// SPDX-License-Identifier: LGPL-3.0-only
//
// Accessibility check for component tests: runs axe-core on a rendered element and returns the
// violations as readable lines (an empty list means none). jsdom has no layout, so colour contrast
// cannot be measured here: it is checked on the design tokens and, on the real rendering, by the
// Playwright captures of step D.
import axe from 'axe-core';

/** WCAG 2.2 AA and best-practice rules, without the ones that need a real layout. */
export async function accessibilityViolations(element: Element): Promise<string[]> {
  const results = await axe.run(element, {
    runOnly: {
      type: 'tag',
      values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
    },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  return results.violations.map(
    (violation) => `${violation.id}: ${violation.help} (${String(violation.nodes.length)})`,
  );
}
