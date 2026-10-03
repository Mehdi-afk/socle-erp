// SPDX-License-Identifier: LGPL-3.0-only
import { field, list } from '@socle/framework';
import { UiProvider } from '@socle/ui';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { accessibilityViolations } from '../../ui/src/testing/axe.js';
import { ViewEngineProvider } from './context.js';
import { ListView, type ListViewProps } from './list-view.js';
import { fixture, listArch } from './testing/fixtures.js';
import { WriteFailure, type DataSource, type ViewContext } from './types.js';

const user = userEvent.setup();
function show(props: Partial<ListViewProps> = {}, overrides: Partial<ViewContext> = {}) {
  const f = fixture(250, overrides);
  const draw = (context = f.context) => (
    <UiProvider>
      <ViewEngineProvider context={context}>
        <ListView
          arch={listArch}
          model="res.partner"
          label="Contacts"
          viewportHeight={480}
          editable
          {...props}
        />
      </ViewEngineProvider>
    </UiProvider>
  );
  return { ...render(draw()), ...f, draw };
}
async function begin() {
  const row = await screen.findByRole('row', { name: /Amel Benali 0/ });
  await user.click(within(row).getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: 'Modifier la ligne' }));
  return screen.getByRole('textbox', { name: 'Nom' });
}

describe('inline list editing', () => {
  it('writes only changed scalar values, converts money exactly and preserves keyboard focus', async () => {
    const { data, container } = show();
    await screen.findAllByText('Algérie');
    const name = await begin();
    expect(name).toHaveFocus();
    expect(screen.queryByRole('combobox', { name: 'Pays' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Display label' })).not.toBeInTheDocument();
    await user.clear(name);
    await user.type(name, 'Atlas');
    const amount = screen.getByRole('textbox', { name: 'Chiffre d’affaires' });
    await user.clear(amount);
    await user.type(amount, '12,34');
    expect(await accessibilityViolations(container)).toEqual([]);
    await user.keyboard('{Control>}s{/Control}');
    await screen.findByText('Atlas');
    expect(data.writes).toEqual([
      { model: 'res.partner', id: 'p-0', values: { name: 'Atlas', revenue: 1234 } },
    ]);
    expect(screen.getByText('Modifications enregistrées.')).toBeVisible();
  });
  it('validates required fields, keeps invalid drafts dirty, and cancels without writing', async () => {
    const report = vi.fn();
    const onOpen = vi.fn();
    const { data, container } = show({ onEditStateChange: report, onOpen });
    const name = await begin();
    await user.clear(name);
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('obligatoire');
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveFocus();
    expect(report).toHaveBeenLastCalledWith({ dirty: true, saving: false });
    expect(data.writes).toEqual([]);
    expect(await accessibilityViolations(container)).toEqual([]);
    act(() => {
      screen.getByRole('button', { name: 'Annuler' }).focus();
    });
    await user.keyboard('{Escape}');
    expect(report).toHaveBeenLastCalledWith({ dirty: false, saving: false });
    expect(screen.queryByRole('textbox', { name: 'Nom' })).not.toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();
  });
  it('blocks sorting and selection while saving, rejects duplicate saves and clears accepted drafts before a failed refresh', async () => {
    const { data } = show();
    const name = await begin();
    await user.clear(name);
    await user.type(name, 'Saved once');
    const gate = Promise.withResolvers<undefined>();
    const write = data.write?.bind(data);
    if (!write) throw new Error('Missing writable fixture.');
    vi.spyOn(data, 'write').mockImplementation(async (...args) => {
      await gate.promise;
      await write(...args);
    });
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(screen.getByRole('button', { name: 'Trier par Nom' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Annuler' })).toBeDisabled();
    fireEvent.keyDown(name, { key: 's', ctrlKey: true });
    vi.spyOn(data, 'search').mockRejectedValueOnce(new Error('refresh offline'));
    await act(async () => {
      gate.resolve(undefined);
      await gate.promise;
    });
    await screen.findByRole('alert');
    expect(data.writes).toHaveLength(1);
    expect(screen.getByText('Modifications enregistrées.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Enregistrer' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Réessayer' }));
    await screen.findByText('Saved once');
    expect(data.writes).toHaveLength(1);
  });
  it('keeps a refused draft and focuses the server-rejected field', async () => {
    const { data } = show();
    const name = await begin();
    await user.type(name, ' modified');
    vi.spyOn(data, 'write').mockRejectedValueOnce(
      new WriteFailure('Droit retiré.', { name: 'Nom refusé.' }),
    );
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Droit retiré.');
    expect(name).toHaveValue('Amel Benali 0 modified');
    expect(name).toHaveFocus();
    expect(data.writes).toHaveLength(0);
  });
  it('retains the draft when its virtual row leaves the viewport', async () => {
    const { data } = show();
    const name = await begin();
    await user.type(name, ' draft');
    const scroller = screen.getByRole('grid').querySelector('.ve-scroll') as HTMLElement;
    fireEvent.scroll(scroller, { target: { scrollTop: 200 * 48 } });
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Nom' })).not.toBeInTheDocument(),
    );
    fireEvent.scroll(scroller, { target: { scrollTop: 0 } });
    expect(await screen.findByRole('textbox', { name: 'Nom' })).toHaveValue('Amel Benali 0 draft');
    await user.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(data.writes).toHaveLength(0);
  });
  it('clears a changed source immediately and ignores an old save response', async () => {
    const report = vi.fn();
    const f = show({ onEditStateChange: report });
    const name = await begin();
    await user.type(name, ' stale');
    const gate = Promise.withResolvers<undefined>();
    vi.spyOn(f.data, 'write').mockImplementation(() => gate.promise);
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    const next = fixture(1);
    f.rerender(f.draw(next.context));
    await screen.findByText('1 enregistrement');
    expect(screen.queryByRole('textbox', { name: 'Nom' })).not.toBeInTheDocument();
    await act(async () => {
      gate.resolve(undefined);
      await gate.promise;
    });
    expect(screen.queryByText('Modifications enregistrées.')).not.toBeInTheDocument();
    expect(next.data.writes).toHaveLength(0);
    expect(report).toHaveBeenLastCalledWith({ dirty: false, saving: false });
  });
  it('requeries domain membership after a save and avoids writes for unchanged inputs', async () => {
    const { data } = show({ domain: [['name', 'ilike', 'Amel']] });
    const name = await begin();
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(data.writes).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Modifier la ligne' }));
    const input = screen.getByRole('textbox', { name: 'Nom' });
    await user.clear(input);
    await user.type(input, 'Moved out of the filter');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await screen.findByText('24 enregistrements');
    expect(screen.queryByText('Moved out of the filter')).not.toBeInTheDocument();
    expect(name).not.toBeInTheDocument();
  });
  it('supports F2 and respects view readonly and read-only data sources', async () => {
    const f = show({
      arch: list([
        field('name', { readonly: true }),
        field('displayLabel'),
        field('vat'),
        field('countryId'),
      ]),
    });
    const row = await screen.findByRole('row', { name: /Amel Benali 0/ });
    await user.click(within(row).getByRole('checkbox'));
    expect(screen.queryByRole('button', { name: 'Modifier la ligne' })).not.toBeInTheDocument();
    f.unmount();
    const base = fixture(2);
    const readonly: DataSource = {
      search: base.data.search.bind(base.data),
      read: base.data.read.bind(base.data),
      displayNames: base.data.displayNames.bind(base.data),
    };
    const next = show({}, { data: readonly });
    const first = await screen.findByRole('row', { name: /Amel Benali 0/ });
    act(() => {
      first.focus();
    });
    await user.keyboard('{F2}');
    expect(screen.queryByRole('textbox', { name: 'Nom' })).not.toBeInTheDocument();
    next.unmount();
    show();
    const editable = await screen.findByRole('row', { name: /Amel Benali 0/ });
    act(() => {
      editable.focus();
    });
    await user.keyboard('{F2}');
    expect(screen.getByRole('textbox', { name: 'Nom' })).toHaveFocus();
  });
});
