// SPDX-License-Identifier: LGPL-3.0-only
import {
  field,
  form,
  group,
  list,
  type FieldMetadata,
  type ModelCatalog,
  type ModelMetadata,
} from '@socle/framework';
import { UiProvider } from '@socle/ui';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ViewEngineProvider } from './context.js';
import { fromDraft, isEditable } from './editing.js';
import { FormInput } from './form-input.js';
import { layoutOf, type FormField } from './form-model.js';
import { FormView } from './form-view.js';
import { ListView } from './list-view.js';
import { createMemoryDataSource } from './memory-data-source.js';
import type { ViewContext } from './types.js';

const item: ModelMetadata = {
  name: 'test.item',
  abstract: false,
  order: [],
  fields: new Map<string, FieldMetadata>([
    ['label', { type: 'char', label: { fr: 'Nom' }, required: true, stored: true }],
    ['total', { type: 'integer', label: { fr: 'Total' }, readonly: true, stored: true }],
    [
      'liveLabel',
      { type: 'char', label: { fr: 'Calcul en direct' }, readonly: true, stored: false },
    ],
    [
      'categoryId',
      { type: 'many2one', label: { fr: 'Catégorie' }, comodel: 'test.category', stored: true },
    ],
  ]),
};

const category: ModelMetadata = {
  name: 'test.category',
  abstract: false,
  order: [],
  fields: new Map<string, FieldMetadata>([
    ['name', { type: 'char', readonly: true, stored: false }],
    ['code', { type: 'char', stored: true }],
  ]),
};

// Deliberately no ORM class, methods, security policy or executable model definitions.
const models = new Map([item, category].map((model) => [model.name, model]));
const registry: ModelCatalog = {
  has: (name) => models.has(name),
  get: (name) => {
    const model = models.get(name);
    if (!model) throw new Error('Unknown test model');
    return model;
  },
  names: () => [...models.keys()],
  field: (model, name) => models.get(model)?.fields.get(name),
};

const fields = [field('label'), field('total'), field('liveLabel')];
const formArch = form([group({ label: { fr: 'Fiche' } }, fields)]);

function fixture() {
  const data = createMemoryDataSource({
    'test.item': [
      { id: 'item-1', label: 'Alice', total: 42, liveLabel: 'Computed Alice', categoryId: null },
    ],
    'test.category': [{ id: 'category-1', name: 'France', code: 'FR' }],
  });
  const context: ViewContext = {
    registry,
    data,
    language: 'fr',
    timeZone: 'UTC',
    density: 'comfortable',
  };
  return { data, context };
}

function show(context: ViewContext, children: React.ReactNode) {
  return render(
    <UiProvider>
      <ViewEngineProvider context={context}>{children}</ViewEngineProvider>
    </UiProvider>,
  );
}

describe('presentation metadata without an ORM registry', () => {
  it('renders stored computed fields as sortable and non-stored fields without a sort control', async () => {
    const { context } = fixture();
    show(
      context,
      <ListView model="test.item" arch={list(fields)} label="Éléments" viewportHeight={400} />,
    );
    expect(await screen.findByText('Alice')).toBeVisible();
    expect(screen.getByText('Computed Alice')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Trier par Total' })).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Trier par Calcul en direct' }),
    ).not.toBeInTheDocument();
  });

  it('edits a plain catalogue field while keeping projected computed fields read-only', async () => {
    const user = userEvent.setup();
    const { context, data } = fixture();
    const write = vi.spyOn(data, 'write');
    show(context, <FormView model="test.item" id="item-1" arch={formArch} />);
    expect(await screen.findByText('Alice')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Modifier : Fiche' }));
    const input = screen.getByRole('textbox', { name: 'Nom' });
    expect(screen.queryByRole('textbox', { name: 'Total' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Calcul en direct' })).not.toBeInTheDocument();
    expect(screen.getByText('42')).toBeVisible();
    await user.clear(input);
    await user.type(input, 'Updated');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByText('Updated')).toBeVisible();
    expect(write).toHaveBeenCalledExactlyOnceWith('test.item', 'item-1', { label: 'Updated' });
  });

  it('refuses an input for a non-stored field even if its readonly flag is missing', () => {
    const projected: FormField = {
      name: 'virtual',
      definition: { type: 'char', stored: false },
      label: 'Virtual',
      sensitive: false,
      widget: undefined,
      tones: undefined,
    };
    expect(isEditable(projected, undefined)).toBe(false);
    expect(fromDraft(projected, 'Changed', undefined)).toEqual({
      ok: false,
      problem: { code: 'invalid' },
    });
  });

  it('uses a stored fallback field for relation search instead of a non-stored name', async () => {
    const user = userEvent.setup();
    const { context, data } = fixture();
    const search = vi.spyOn(data, 'search');
    const relationArch = form([field('categoryId')]);
    const block = layoutOf(relationArch, item, 'fr').blocks[0];
    if (block?.kind !== 'card' || !block.fields[0]) throw new Error('Expected a relation field');
    show(
      context,
      <FormInput
        field={block.fields[0]}
        value=""
        currency={undefined}
        displayName={undefined}
        error={undefined}
        disabled={false}
        onChange={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Catégorie' })).toBeEnabled();
    });
    await user.type(screen.getByRole('searchbox', { name: 'Rechercher : Catégorie' }), 'FR');
    await waitFor(() => {
      expect(search).toHaveBeenLastCalledWith(
        'test.category',
        expect.objectContaining({ domain: [['code', 'ilike', 'FR']] }),
      );
    });
    expect(await screen.findByRole('option', { name: 'France' })).toBeInTheDocument();
  });
});
