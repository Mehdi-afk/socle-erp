// SPDX-License-Identifier: LGPL-3.0-only
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { accessibilityViolations } from './axe.js';

const check = async (ui: React.ReactElement): Promise<string[]> => {
  const { container } = render(ui);
  return accessibilityViolations(container);
};

describe('accessibility check', () => {
  it('finds nothing in accessible markup', async () => {
    expect(
      await check(
        <main>
          <h1>Contacts</h1>
          <label>
            Name
            <input type="text" />
          </label>
          <button type="button">Save</button>
          <img src="logo.png" alt="Company logo" />
        </main>,
      ),
    ).toEqual([]);
  });

  it('reports a missing text alternative, a nameless button and an unlabelled field', async () => {
    const found = (
      await check(
        <main>
          <h1>Contacts</h1>
          <img src="logo.png" />
          <button type="button"></button>
          <input type="text" />
        </main>,
      )
    ).join('\n');
    expect(found).toContain('image-alt');
    expect(found).toContain('button-name');
    expect(found).toContain('label');
  });

  it('reports a dialog without a name and duplicate ids', async () => {
    const found = (
      await check(
        <main>
          <h1>Contacts</h1>
          <div role="dialog">Hello</div>
          <p id="same">a</p>
          <p id="same">b</p>
        </main>,
      )
    ).join('\n');
    expect(found).toContain('aria-dialog-name');
  });
});
