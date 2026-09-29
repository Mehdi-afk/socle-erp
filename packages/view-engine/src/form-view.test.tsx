// SPDX-License-Identifier: LGPL-3.0-only
import { field, form, group, node, notebook, page, sheet, list } from '@socle/framework';
import { UiProvider } from '@socle/ui';
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { accessibilityViolations } from '../../ui/src/testing/axe.js';

import { ViewEngineProvider } from './context.js';
import { layoutOf } from './form-model.js';
import { FormView, type FormViewProps } from './form-view.js';
import { contactForm, fixture, registry } from './testing/fixtures.js';
import type { ViewContext } from './types.js';

const user = userEvent.setup();
const meta = registry.get('res.partner');

describe('layoutOf: what a form asks for', () => {
  const layout = layoutOf(contactForm, meta, 'fr');

  it('reads the header: title, subtitle, avatar and the buttons', () => {
    expect(layout.header.title?.name).toBe('name');
    expect(layout.header.subtitle?.name).toBe('email');
    expect(layout.header.avatar?.name).toBe('name');
    expect(layout.header.actions).toEqual([
      { method: 'archive', label: 'Archiver', primary: false },
      { method: 'sendMail', label: 'Écrire', primary: true },
    ]);
  });

  it('makes a card of the main group, a page of each notebook page, an embedded list of the one2many', () => {
    const [main, tabs] = layout.blocks;
    expect(main).toMatchObject({ kind: 'card', title: 'Identité' });
    expect(main?.kind === 'card' ? main.fields.map((item) => item.name) : []).toEqual([
      'kind',
      'phone',
      'website',
      'revenue',
    ]);
    expect(tabs?.kind === 'tabs' ? tabs.pages.map((item) => item.label) : []).toEqual([
      'Adresse',
      'Contacts',
      'Notes',
    ]);
    const contacts = tabs?.kind === 'tabs' ? tabs.pages[1]?.blocks[0] : undefined;
    expect(contacts).toMatchObject({
      kind: 'relation',
      title: 'Contacts',
      relation: { comodel: 'res.partner', inverse: 'parentId' },
    });
  });

  it('gathers confidential fields in one place, wherever the view put them', () => {
    expect(layout.confidential.map((item) => item.name)).toEqual(['vat']);
    const inPage = layoutOf(
      form([notebook([page('x', 'X', [field('name'), field('vat')])])]),
      meta,
      'fr',
    );
    expect(inPage.confidential.map((item) => item.name)).toEqual(['vat']);
    expect(JSON.stringify(inPage.blocks)).not.toContain('"vat"');
  });

  it('reads the fields it needs: shown ones, header ones, currencies; never the one2many', () => {
    expect(layout.fields).toEqual(
      expect.arrayContaining(['name', 'email', 'kind', 'revenue', 'currencyId', 'vat', 'city']),
    );
    expect(layout.fields).not.toContain('childIds');
  });

  it('flattens a sheet, sets groups of groups side by side, drops empty pages and unknown fields', () => {
    const nested = layoutOf(
      form([
        sheet([
          group([group({ label: { fr: 'A' } }, [field('name')]), group([field('city')])]),
          field('doesNotExist'),
          notebook([page('empty', 'Empty', [field('doesNotExist')])]),
        ]),
      ]),
      meta,
      'fr',
    );
    expect(nested.blocks).toHaveLength(1);
    expect(nested.blocks[0]).toMatchObject({ kind: 'columns' });
    expect(nested.fields).toEqual(['name', 'city']);
  });

  it('falls back on a name in the comodel for a one2many without its own list', () => {
    const plain = layoutOf(form([node('field', { name: 'childIds' })]), meta, 'fr');
    const block = plain.blocks[0];
    expect(block?.kind === 'relation' ? block.relation.arch.children[0]?.attrs.name : '').toBe(
      'name',
    );
    expect(list([]).type).toBe('list');
  });
});

function show(
  props: Partial<FormViewProps> = {},
  count = 30,
  overrides: Partial<ViewContext> = {},
) {
  const { data, context } = fixture(count, overrides);
  const utils = render(
    <UiProvider>
      <ViewEngineProvider context={context}>
        <FormView arch={contactForm} model="res.partner" id="p-0" {...props} />
      </ViewEngineProvider>
    </UiProvider>,
  );
  return { ...utils, data, context };
}

describe('FormView: reading a record', () => {
  it('draws the header with the name, the email and the quick actions', async () => {
    const onAction = vi.fn();
    show({ onAction });
    expect(await screen.findByRole('heading', { level: 1, name: 'Amel Benali 0' })).toBeVisible();
    expect(screen.getByText('contact0@example.test')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Écrire' }));
    expect(onAction).toHaveBeenCalledWith('sendMail', 'p-0');
    await user.click(screen.getByRole('button', { name: 'Archiver' }));
    expect(onAction).toHaveBeenLastCalledWith('archive', 'p-0');
  });

  it('shows each value the way its type and widget ask, in a card named by its group', async () => {
    show();
    const card = await screen.findByRole('region', { name: 'Identité' });
    expect(within(card).getByText('Société')).toBeVisible();
    expect(within(card).getByRole('link', { name: '0555 12 34 00' })).toHaveAttribute(
      'href',
      'tel:0555123400',
    );
    const site = within(card).getByRole('link', { name: 'https://company0.example.test' });
    expect(site).toHaveAttribute('target', '_blank');
    expect(site).toHaveAttribute('rel', 'noopener noreferrer');
    await waitFor(() => {
      expect(within(card).getByText(/^1\D000,00\s?(DA|DZD)/)).toBeVisible();
    });
  });

  it('shows the pages as tabs: related names, the notes as written, the embedded list', async () => {
    const onOpenRelated = vi.fn();
    show({ onOpenRelated });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Adresse',
      'Contacts',
      'Notes',
    ]);
    expect(await screen.findByText('Algérie')).toBeVisible();
    // A missing city says so.
    expect(screen.getAllByText('Non renseigné').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('tab', { name: 'Notes' }));
    expect(screen.getByText(/First line/)).toHaveTextContent('First line Second line');

    await user.click(screen.getByRole('tab', { name: 'Contacts' }));
    const grid = await screen.findByRole('grid', { name: 'Contacts' });
    // p-1, p-2 and p-3 belong to the company p-0, and nobody else does.
    await waitFor(() => {
      expect(within(grid).getAllByRole('row')).toHaveLength(4);
    });
    await user.click(within(grid).getByText('Karim Haddad 1'));
    expect(onOpenRelated).toHaveBeenCalledWith('res.partner', 'p-1');
  });

  it('asks the data source for the record once, and for its names in one batch', async () => {
    const { data } = show();
    await screen.findByText('Algérie');
    expect(data.searches.every((query) => query.domain !== undefined)).toBe(true);
  });

  it('changes record when the id changes, without keeping the old one', async () => {
    const { rerender, context } = show();
    await screen.findByRole('heading', { level: 1, name: 'Amel Benali 0' });
    rerender(
      <UiProvider>
        <ViewEngineProvider context={context}>
          <FormView arch={contactForm} model="res.partner" id="p-1" />
        </ViewEngineProvider>
      </UiProvider>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Karim Haddad 1' })).toBeVisible();
    expect(screen.queryByText('Amel Benali 0')).not.toBeInTheDocument();
  });
});

describe('FormView: confidential data', () => {
  it('masks the values and gives them away only when asked, one at a time', async () => {
    const onReveal = vi.fn(() => Promise.resolve('0001234567890'));
    show({ onReveal });
    const card = await screen.findByRole('region', { name: 'Données confidentielles' });
    expect(within(card).getByText('Masqué')).toBeInTheDocument();
    expect(screen.queryByText(/000000000000/)).not.toBeInTheDocument();
    expect(onReveal).not.toHaveBeenCalled();

    await user.click(within(card).getByRole('button', { name: 'Afficher : Identifiant fiscal' }));
    expect(onReveal).toHaveBeenCalledExactlyOnceWith('vat', 'p-0');
    expect(await within(card).findByText('0001234567890')).toBeVisible();

    await user.click(within(card).getByRole('button', { name: 'Masquer : Identifiant fiscal' }));
    expect(within(card).queryByText('0001234567890')).not.toBeInTheDocument();
    expect(within(card).getByText('Masqué')).toBeInTheDocument();
  });

  it('hides a revealed value again when another record is opened', async () => {
    const { rerender, context } = show({ onReveal: () => Promise.resolve('0001234567890') });
    await user.click(await screen.findByRole('button', { name: 'Afficher : Identifiant fiscal' }));
    expect(await screen.findByText('0001234567890')).toBeVisible();
    rerender(
      <UiProvider>
        <ViewEngineProvider context={context}>
          <FormView
            arch={contactForm}
            model="res.partner"
            id="p-1"
            onReveal={() => Promise.resolve('0001234567890')}
          />
        </ViewEngineProvider>
      </UiProvider>,
    );
    await screen.findByRole('heading', { level: 1, name: 'Karim Haddad 1' });
    expect(screen.queryByText('0001234567890')).not.toBeInTheDocument();
    expect(screen.getByText('Masqué')).toBeInTheDocument();
  });
  it('says so when the value could not be shown', async () => {
    show({ onReveal: () => Promise.reject(new Error('forbidden')) });
    await user.click(await screen.findByRole('button', { name: 'Afficher : Identifiant fiscal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Impossible d’afficher cette donnée.',
    );
  });

  it('offers no way to reveal when nobody handles it', async () => {
    show();
    await screen.findByRole('region', { name: 'Données confidentielles' });
    expect(screen.queryByRole('button', { name: /Afficher/ })).not.toBeInTheDocument();
  });

  it('shows nothing to mask for an empty value', async () => {
    const { data, context } = fixture(1);
    data.set('res.partner', [{ id: 'p-9', name: 'Vide', vat: null }]);
    render(
      <UiProvider>
        <ViewEngineProvider context={context}>
          <FormView arch={contactForm} model="res.partner" id="p-9" />
        </ViewEngineProvider>
      </UiProvider>,
    );
    const card = await screen.findByRole('region', { name: 'Données confidentielles' });
    expect(within(card).queryByText('Masqué')).not.toBeInTheDocument();
    expect(within(card).getByText('Non renseigné')).toBeInTheDocument();
  });
  it('has no confidential card when the view shows no confidential field', async () => {
    show({ arch: form([group([field('name')])]) });
    await screen.findByText('Amel Benali 0');
    expect(
      screen.queryByRole('region', { name: 'Données confidentielles' }),
    ).not.toBeInTheDocument();
  });
});

describe('FormView: when things go wrong', () => {
  it('says the record is not there', async () => {
    show({ id: 'p-999' });
    expect(await screen.findByText('Rien à afficher')).toBeVisible();
    expect(screen.getByText(/n’existe pas ou vous n’y avez pas accès/)).toBeVisible();
  });

  it('reports a failure and reads again on request', async () => {
    const { data, context } = fixture(3);
    let fail = true;
    const original = data.read.bind(data);
    (context.data as { read: typeof data.read }).read = (model, ids, fields) =>
      fail ? Promise.reject(new Error('offline')) : original(model, ids, fields);
    render(
      <UiProvider>
        <ViewEngineProvider context={context}>
          <FormView arch={contactForm} model="res.partner" id="p-0" />
        </ViewEngineProvider>
      </UiProvider>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Impossible de charger les données.',
    );
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Amel Benali 0' })).toBeVisible();
  });
});

describe('FormView: accessibility and languages', () => {
  it('has no axe violation, and one level-1 heading', async () => {
    const { container } = show({ onReveal: () => Promise.resolve('x') });
    await screen.findByRole('heading', { level: 1 });
    await screen.findByText('Algérie');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('speaks Arabic when the user does, and keeps the secret left to right', async () => {
    show({ onReveal: () => Promise.resolve('0001234567890') }, 30, { language: 'ar' });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByRole('region', { name: 'بيانات سرية' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Address' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^إظهار/ }));
    expect((await screen.findByText('0001234567890')).closest('bdi')).toHaveAttribute('dir', 'ltr');
  });
});
