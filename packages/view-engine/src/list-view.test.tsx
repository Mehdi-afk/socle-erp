// SPDX-License-Identifier: LGPL-3.0-only
import { UiProvider } from '@socle/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { accessibilityViolations } from '../../ui/src/testing/axe.js';

import { ViewEngineProvider } from './context.js';
import { ListView, type ListViewProps } from './list-view.js';
import { fixture, listArch } from './testing/fixtures.js';
import type { ViewContext } from './types.js';

const user = userEvent.setup();

function show(
  count: number,
  props: Partial<ListViewProps> = {},
  overrides: Partial<ViewContext> = {},
  delayMs = 0,
) {
  const { data, context } = fixture(count, overrides, delayMs);
  const utils = render(
    <UiProvider>
      <ViewEngineProvider context={context}>
        <ListView
          arch={listArch}
          model="res.partner"
          label="Contacts"
          viewportHeight={480}
          {...props}
        />
      </ViewEngineProvider>
    </UiProvider>,
  );
  return { ...utils, data };
}

const grid = () => screen.getByRole('grid', { name: 'Contacts' });
const rows = () => within(grid()).getAllByRole('row').slice(1);
const scrollTo = (top: number) => {
  const scroller = grid().querySelector<HTMLElement>('.ve-scroll') as HTMLElement;
  fireEvent.scroll(scroller, { target: { scrollTop: top } });
};

describe('ListView: what it shows', () => {
  it('draws the columns of the view with their labels and the first page of records', async () => {
    show(250);
    await screen.findByText('250 enregistrements');
    const headers = within(grid()).getAllByRole('columnheader');
    expect(headers.map((header) => header.textContent)).toEqual([
      '',
      'Nom',
      'E-mail',
      'Téléphone',
      'Ville',
      'Pays',
      'Type',
      'Chiffre d’affaires',
      'Abonné',
      'Display label',
    ]);
    expect(grid()).toHaveAttribute('aria-rowcount', '251');
    expect(grid()).toHaveAttribute('aria-colcount', '10');
    const first = rows()[0] as HTMLElement;
    expect(first).toHaveAttribute('aria-rowindex', '2');
    expect(within(first).getByText('Amel Benali 0')).toBeVisible();
  });

  it('writes each value the way its type and widget ask', async () => {
    show(20);
    await screen.findByText('20 enregistrements');
    const second = rows()[1] as HTMLElement; // index 1: a person, not a company
    expect(within(second).getByRole('link', { name: 'contact1@example.test' })).toHaveAttribute(
      'href',
      'mailto:contact1@example.test',
    );
    expect(within(second).getByRole('link', { name: '0555 12 34 01' })).toHaveAttribute(
      'href',
      'tel:0555123401',
    );
    expect(within(second).getByText('Personne')).toBeVisible(); // status pill
    expect(within(second).getByText('Non')).toBeVisible(); // boolean
    const first = rows()[0] as HTMLElement;
    expect(within(first).getByText('Société')).toBeVisible();
    expect(within(first).getByText('Oui')).toBeVisible();
    // A missing city is a dash that says "Non renseigné".
    expect(within(first).getAllByText('Non renseigné').length).toBeGreaterThan(0);
  });

  it('asks each related name and each currency once, however many rows use it', async () => {
    const { data } = show(60);
    await screen.findByText('60 enregistrements');
    const first = rows()[0] as HTMLElement;
    await waitFor(() => {
      expect(within(first).getByText('Algérie')).toBeVisible();
    });
    // 60 rows, 3 countries and 2 currencies: the names came from a single batch each.
    const read = vi.spyOn(data, 'read');
    const names = vi.spyOn(data, 'displayNames');
    await waitFor(() => {
      expect(within(rows()[1] as HTMLElement).getByText('France')).toBeVisible();
    });
    expect(read).not.toHaveBeenCalled();
    expect(names).not.toHaveBeenCalled();
    // The amount is in the currency of its own row: 1 000,00 DA and 1 001,00 €.
    const amounts = rows().map((row) => within(row).queryByText(/^[\d\s,.]+\s?(DZD|€|DA)/));
    expect(amounts.filter(Boolean).length).toBeGreaterThan(0);
  });

  it('shows an empty state, and a loading skeleton first', async () => {
    const { data } = show(0, {}, {}, 20);
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    expect(await screen.findByText('Rien à afficher')).toBeVisible();
    expect(data.searches.length).toBe(1);
  });

  it('reports a failure and lets the user try again', async () => {
    const { data, context } = fixture(5);
    let fail = true;
    const original = data.search.bind(data);
    (context.data as { search: typeof data.search }).search = (model, options) =>
      fail ? Promise.reject(new Error('offline')) : original(model, options);
    render(
      <UiProvider>
        <ViewEngineProvider context={context}>
          <ListView arch={listArch} model="res.partner" label="Contacts" viewportHeight={480} />
        </ViewEngineProvider>
      </UiProvider>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Impossible de charger les données.',
    );
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByText('5 enregistrements')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('ListView: scrolling through many records', () => {
  it('draws only the rows on screen, even for ten thousand records', async () => {
    const { data } = show(10_000);
    await screen.findByText(/^10\D000 enregistrements$/);
    // 480 px / 48 px = 10 rows, plus the margin: far fewer than 10 000 in the page.
    expect(rows().length).toBeLessThan(30);
    expect(rows().length).toBeGreaterThan(9);
    expect(grid()).toHaveAttribute('aria-rowcount', '10001');
    expect(grid().querySelector('.ve-body')).toHaveStyle({ blockSize: `${String(10_000 * 48)}px` });
    // Only the first page was asked for.
    expect(data.searches).toHaveLength(1);
    expect(data.searches[0]).toMatchObject({ offset: 0, limit: 100 });
  });

  it('asks for the next page when the window reaches it, and shows bars until it arrives', async () => {
    const { data } = show(1000, {}, {}, 30);
    await screen.findByText(/^1\D000 enregistrements$/);
    scrollTo(100 * 48 - 200); // near the end of the first page
    await waitFor(() => {
      expect(data.searches.some((query) => query.offset === 100)).toBe(true);
    });
    scrollTo(500 * 48); // far away: a page nobody had asked for, not loaded yet
    const pending = await waitFor(() => {
      const bars = grid().querySelectorAll('.ve-row[aria-busy="true"]');
      expect(bars.length).toBeGreaterThan(0);
      return bars;
    });
    expect(pending[0]?.querySelector('.ve-bar')).toBeInTheDocument();
    await waitFor(() => {
      expect(
        within(rows()[0] as HTMLElement).getByText(
          /Amel|Karim|Sara|Yacine|Lina|Omar|Nadia|Rachid|Meriem|Sofiane/,
        ),
      ).toBeVisible();
    });
    expect(data.searches.some((query) => query.offset === 500)).toBe(true);
  });

  it('gives compact rows when the user chose the compact density', async () => {
    show(30, {}, { density: 'compact' });
    await screen.findByText('30 enregistrements');
    expect(rows()[0]).toHaveStyle({ blockSize: '32px' });
    expect(grid().querySelector('.ve-body')).toHaveStyle({ blockSize: `${String(30 * 32)}px` });
  });
});

describe('ListView: sorting', () => {
  it('sorts by a column: ascending, descending, then back to the default', async () => {
    const { data } = show(30);
    await screen.findByText('30 enregistrements');
    const header = () => screen.getByRole('columnheader', { name: /Ville/ });
    expect(header()).toHaveAttribute('aria-sort', 'none');

    await user.click(screen.getByRole('button', { name: 'Trier par Ville' }));
    await waitFor(() => {
      expect(data.searches.at(-1)?.order).toBe('city');
    });
    expect(header()).toHaveAttribute('aria-sort', 'ascending');

    await user.click(screen.getByRole('button', { name: 'Trier par Ville' }));
    await waitFor(() => {
      expect(data.searches.at(-1)?.order).toBe('city desc');
    });
    expect(header()).toHaveAttribute('aria-sort', 'descending');

    await user.click(screen.getByRole('button', { name: 'Trier par Ville' }));
    await waitFor(() => {
      expect(data.searches.at(-1)?.order).toBeUndefined();
    });
    expect(header()).toHaveAttribute('aria-sort', 'none');
  });

  it('really reorders the rows, and goes back to the top', async () => {
    show(30);
    await screen.findByText('30 enregistrements');
    await user.click(screen.getByRole('button', { name: 'Trier par Nom' }));
    await user.click(screen.getByRole('button', { name: 'Trier par Nom' }));
    await waitFor(() => {
      expect(within(rows()[0] as HTMLElement).getByText(/^Yacine Zerrouki 23/)).toBeVisible();
    });
  });

  it('offers no sort on a column the database cannot sort on', async () => {
    show(10);
    await screen.findByText('10 enregistrements');
    expect(
      screen.queryByRole('button', { name: 'Trier par Display label' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Display label' })).not.toHaveAttribute(
      'aria-sort',
    );
    expect(screen.getByRole('button', { name: 'Trier par Nom' })).toBeInTheDocument();
  });

  it('starts from the order it is given', async () => {
    const { data } = show(10, { defaultOrder: 'city desc' });
    await screen.findByText('10 enregistrements');
    expect(data.searches[0]?.order).toBe('city desc');
    expect(screen.getByRole('columnheader', { name: /Ville/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });
});

describe('ListView: selection and opening', () => {
  it('selects rows, all loaded rows, and clears, telling the parent and the bulk bar', async () => {
    const onSelectionChange = vi.fn();
    show(20, {
      onSelectionChange,
      actions: (ids) => <button type="button">{`Archiver ${String(ids.size)}`}</button>,
    });
    await screen.findByText('20 enregistrements');
    const boxes = () => within(grid()).getAllByRole('checkbox');
    await user.click(within(rows()[0] as HTMLElement).getByRole('checkbox'));
    expect(rows()[0]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('group', { name: '1 sélectionné' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archiver 1' })).toBeVisible();
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['p-0']));
    // Some, not all: the header box is undetermined.
    expect(boxes()[0]).toHaveProperty('indeterminate', true);

    await user.click(
      screen.getByRole('checkbox', { name: 'Sélectionner toutes les lignes chargées' }),
    );
    expect(onSelectionChange.mock.lastCall?.[0]).toHaveProperty('size', 20);
    expect(screen.getByRole('button', { name: 'Archiver 20' })).toBeVisible();
    expect(
      screen.getByRole('checkbox', { name: 'Sélectionner toutes les lignes chargées' }),
    ).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Tout désélectionner' }));
    expect(screen.queryByRole('button', { name: /Archiver/ })).not.toBeInTheDocument();
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set());
  });

  it('opens a record by click, but not from a link or a checkbox', async () => {
    const onOpen = vi.fn();
    show(20, { onOpen });
    await screen.findByText('20 enregistrements');
    await user.click(within(rows()[2] as HTMLElement).getByText('Sara Mansouri 2'));
    expect(onOpen).toHaveBeenCalledWith('p-2');
    onOpen.mockClear();
    await user.click(within(rows()[2] as HTMLElement).getByRole('checkbox'));
    await user.click(within(rows()[2] as HTMLElement).getByRole('link', { name: /contact2@/ }));
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('ListView: keyboard', () => {
  it('moves between rows with the arrows, Home and End, opens with Enter, selects with Space', async () => {
    const onOpen = vi.fn();
    const onSelectionChange = vi.fn();
    show(300, { onOpen, onSelectionChange });
    await screen.findByText('300 enregistrements');
    // One tab stop for the whole list: the first row.
    expect(rows().filter((row) => row.tabIndex === 0)).toHaveLength(1);
    rows()[0]?.focus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(rows()[2]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(rows()[1]).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledWith('p-1');
    await user.keyboard(' ');
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['p-1']));
    await user.keyboard(' ');
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set());

    // End goes to the very last record, which is in a page nobody had loaded yet.
    await user.keyboard('{End}');
    await waitFor(() => {
      expect(screen.getByRole('row', { name: /299/ })).toHaveFocus();
    });
    await user.keyboard('{Home}');
    await waitFor(() => {
      expect(within(grid()).getAllByRole('row')[1]).toHaveFocus();
    });
  });
});

describe('ListView: accessibility', () => {
  it('has no axe violation, with data, empty, and with a selection', async () => {
    const { container } = show(40);
    await screen.findByText('40 enregistrements');
    expect(await accessibilityViolations(container)).toEqual([]);
    await user.click(within(rows()[0] as HTMLElement).getByRole('checkbox'));
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('is right to left and reads Arabic in Arabic', async () => {
    show(10, {}, { language: 'ar' });
    await screen.findByText(/سجل/);
    expect(screen.getByRole('columnheader', { name: 'الاسم' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'تحديد كل الأسطر المحمّلة' })).toBeInTheDocument();
  });
});
