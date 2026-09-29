// SPDX-License-Identifier: LGPL-3.0-only
//
// The CSS rules of the design system (stylelint.config.js): colours only from the tokens, and no
// physical direction. The last test runs the real rules on the real CSS files of the package.
import { join } from 'node:path';

import stylelint from 'stylelint';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const configFile = join(ROOT, 'stylelint.config.js');

/** The rules broken by `css`, as if it were the file `name` of the package. */
async function broken(css: string, name = 'component.css'): Promise<string[]> {
  const result = await stylelint.lint({
    code: css,
    codeFilename: join(ROOT, 'packages', 'ui', 'src', name),
    configFile,
  });
  return result.results.flatMap((entry) => entry.warnings.map((warning) => warning.rule));
}

const rule = (declaration: string): string => `.card {\n  ${declaration}\n}\n`;

describe('CSS colours', () => {
  it('accept only tokens', async () => {
    expect(await broken(rule('color: var(--color-ink);'))).toEqual([]);
    expect(await broken(rule('background: var(--color-surface);'))).toEqual([]);
  });

  it('refuse hex, functions and names in a component', async () => {
    expect(await broken(rule('color: #ebff65;'))).toContain('color-no-hex');
    expect(await broken(rule('color: #fff;'))).toContain('color-no-hex');
    expect(await broken(rule('color: rgb(0 0 0);'))).toContain('function-disallowed-list');
    expect(await broken(rule('color: rgba(0, 0, 0, 0.5);'))).toContain('function-disallowed-list');
    expect(await broken(rule('color: hsl(60 100% 70%);'))).toContain('function-disallowed-list');
    expect(await broken(rule('color: oklch(90% 0.2 110);'))).toContain('function-disallowed-list');
    expect(await broken(rule('color: red;'))).toContain('color-named');
    expect(await broken(rule('border: 1px solid black;'))).toContain('color-named');
  });

  it('allow hex only in the token file', async () => {
    expect(await broken(':root {\n  --color-x: #ebff65;\n}\n', 'tokens.css')).toEqual([]);
    expect(await broken(':root {\n  --color-x: #ebff65;\n}\n', 'button.css')).toContain(
      'color-no-hex',
    );
  });
});

describe('CSS direction', () => {
  it('accept logical properties', async () => {
    for (const declaration of [
      'margin-inline-start: var(--space-4);',
      'padding-inline: var(--space-4);',
      'inset-inline-end: 0;',
      'border-inline-start: 1px solid var(--color-line);',
      'border-start-start-radius: var(--radius-card);',
      'text-align: start;',
      'float: inline-start;',
    ]) {
      expect(await broken(rule(declaration)), declaration).toEqual([]);
    }
  });

  it('refuse physical properties and values', async () => {
    for (const declaration of [
      'margin-left: 4px;',
      'margin-right: 4px;',
      'padding-left: 4px;',
      'padding-right: 4px;',
      'left: 0;',
      'right: 0;',
      'border-left: 1px solid var(--color-line);',
      'border-right-width: 1px;',
      'border-top-left-radius: 4px;',
      'border-bottom-right-radius: 4px;',
      'scroll-margin-left: 4px;',
    ]) {
      expect(await broken(rule(declaration)), declaration).toContain('property-disallowed-list');
    }
    for (const declaration of [
      'text-align: left;',
      'text-align: right;',
      'float: left;',
      'clear: right;',
    ]) {
      expect(await broken(rule(declaration)), declaration).toContain(
        'declaration-property-value-disallowed-list',
      );
    }
  });

  it('still refuses physical properties in the token file', async () => {
    expect(await broken(':root {\n  margin-left: 4px;\n}\n', 'tokens.css')).toContain(
      'property-disallowed-list',
    );
  });
});

describe('the package stylesheets', () => {
  it('follow the rules', async () => {
    const result = await stylelint.lint({
      files: [join(ROOT, 'packages', 'ui', 'src', '**', '*.css').replaceAll('\\', '/')],
      configFile,
    });
    const problems = result.results.flatMap((entry) =>
      entry.warnings.map(
        (warning) => `${entry.source ?? ''}: ${warning.rule} at ${String(warning.line)}`,
      ),
    );
    expect(problems).toEqual([]);
    expect(result.results.length).toBeGreaterThanOrEqual(2);
  });
});
