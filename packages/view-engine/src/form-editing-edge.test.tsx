// SPDX-License-Identifier: LGPL-3.0-only
import { field, form, group, header, type ViewNode } from '@socle/framework';
import { act, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ViewEngineProvider } from './context.js';
import { FormView } from './form-view.js';
import { contacts, fixture } from './testing/fixtures.js';
import type { RecordValues, ViewContext } from './types.js';

const identity = form([
  header({ title: 'name' }, []),
  group({ label: { fr: 'Identité', en: 'Identity' } }, [field('name')]),
]);

function contents(context: ViewContext, arch: ViewNode = identity): React.ReactElement {
  return (
    <ViewEngineProvider context={context}>
      <FormView arch={arch} model="res.partner" id="p-0" />
    </ViewEngineProvider>
  );
}

describe('FormView: overlapping reloads and edit sessions', () => {
  it('does not replace a freshly saved record with an earlier language reload', async () => {
    const user = userEvent.setup();
    const { context, data } = fixture(1);
    const read = vi.spyOn(data, 'read');
    const rendered = render(contents(context));
    await screen.findByRole('heading', { name: 'Amel Benali 0' });

    const stale = Promise.withResolvers<RecordValues[]>();
    read.mockImplementationOnce(() => stale.promise);
    rendered.rerender(contents({ ...context, language: 'en' }));
    await waitFor(() => {
      expect(read).toHaveBeenCalledTimes(2);
    });
    await user.click(screen.getByRole('button', { name: 'Edit: Identity' }));
    const input = screen.getByRole('textbox', { name: 'Name' });
    await user.clear(input);
    await user.type(input, 'Saved after reload started');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('heading', { name: 'Saved after reload started' });
    await waitFor(() => {
      expect(read).toHaveBeenCalledTimes(3);
    });

    await act(async () => {
      stale.resolve([{ id: 'p-0', name: 'Amel Benali 0' }]);
      await stale.promise;
    });
    expect(screen.getByRole('heading', { name: 'Saved after reload started' })).toBeVisible();
  });

  it('preserves a new draft when an old save finishes after leaving and returning to its source', async () => {
    const user = userEvent.setup();
    const first = fixture(1);
    const second = fixture(1);
    second.data.set('res.partner', [{ ...contacts(1)[0], id: 'p-0', name: 'Second source' }]);
    const originalWrite = first.data.write?.bind(first.data);
    if (!originalWrite) throw new Error('The fixture must support writes.');
    const pending = Promise.withResolvers<undefined>();
    const write = vi
      .spyOn(first.data, 'write')
      .mockImplementationOnce(async (model, id, values) => {
        await pending.promise;
        await originalWrite(model, id, values);
      });
    const rendered = render(contents(first.context));
    await user.click(await screen.findByRole('button', { name: 'Modifier : Identité' }));
    await user.clear(screen.getByRole('textbox', { name: 'Nom' }));
    await user.type(screen.getByRole('textbox', { name: 'Nom' }), 'Old pending save');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => {
      expect(write).toHaveBeenCalledTimes(1);
    });

    rendered.rerender(contents(second.context));
    await screen.findByRole('heading', { name: 'Second source' });
    rendered.rerender(contents(first.context));
    await screen.findByRole('heading', { name: 'Amel Benali 0' });
    await user.click(screen.getByRole('button', { name: 'Modifier : Identité' }));
    await user.clear(screen.getByRole('textbox', { name: 'Nom' }));
    await user.type(screen.getByRole('textbox', { name: 'Nom' }), 'New draft after returning');

    await act(async () => {
      pending.resolve(undefined);
      await pending.promise;
    });
    expect(screen.getByRole('textbox', { name: 'Nom' })).toHaveValue('New draft after returning');
  });

  it('loads a newly selected currency before converting the amount in the same card', async () => {
    const user = userEvent.setup();
    const { context, data } = fixture(1);
    data.set('res.currency', [
      { id: 'cur-dzd', name: 'Dinar', code: 'DZD', decimals: 2 },
      { id: 'cur-jpy', name: 'Yen', code: 'JPY', decimals: 0 },
    ]);
    const write = vi.spyOn(data, 'write');
    const arch = form([
      header({ title: 'name' }, []),
      group({ label: { fr: 'Finances' } }, [field('currencyId'), field('revenue')]),
    ]);
    render(contents(context, arch));
    await user.click(await screen.findByRole('button', { name: 'Modifier : Finances' }));
    const select = screen.getByRole('combobox', { name: 'Currency' });
    await waitFor(() => {
      expect(select).toBeEnabled();
    });
    await user.selectOptions(select, 'cur-jpy');
    const amount = screen.getByRole('textbox', { name: 'Chiffre d’affaires' });
    await user.clear(amount);
    await user.type(amount, '12');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() => {
      expect(write).toHaveBeenCalledExactlyOnceWith('res.partner', 'p-0', {
        currencyId: 'cur-jpy',
        revenue: 12,
      });
    });
    await screen.findByRole('button', { name: 'Modifier : Finances' });
  });
});
