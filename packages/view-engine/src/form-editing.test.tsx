// SPDX-License-Identifier: LGPL-3.0-only
import {
  buildModelRegistry,
  defineModel,
  f,
  field,
  form,
  group,
  header,
  notebook,
  page,
  type ViewNode,
} from '@socle/framework';
import { UiProvider } from '@socle/ui';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { accessibilityViolations } from '../../ui/src/testing/axe.js';

import { ViewEngineProvider } from './context.js';
import { FormView } from './form-view.js';
import { contacts, fixture } from './testing/fixtures.js';
import { WriteFailure, type DataSource, type ViewContext } from './types.js';

type Write = NonNullable<DataSource['write']>;

const editingForm = form([
  header({ title: 'name', subtitle: 'email' }, []),
  group({ label: { fr: 'Identité', en: 'Identity', ar: 'الهوية' } }, [
    field('name'),
    field('email'),
    field('kind'),
    field('subscribed'),
  ]),
  group({ label: { fr: 'Coordonnées', en: 'Contact details' } }, [field('city'), field('phone')]),
]);

function show(
  options: {
    readonly arch?: ViewNode;
    readonly context?: Partial<ViewContext>;
    readonly readOnly?: boolean;
  } = {},
) {
  const { data, context: initialContext } = fixture(3);
  const save = data.write?.bind(data);
  if (!save) throw new Error('The editing fixture must support writes.');
  const write = vi.fn<Write>((model, id, values) => save(model, id, values));
  const read = vi.fn<DataSource['read']>((model, ids, fields) => data.read(model, ids, fields));
  const source: DataSource = {
    search: data.search.bind(data),
    read,
    displayNames: data.displayNames.bind(data),
    ...(options.readOnly === true ? {} : { write }),
  };
  const context: ViewContext = { ...initialContext, data: source, ...options.context };
  const arch = options.arch ?? editingForm;
  const contents = (id: string): React.ReactElement => (
    <UiProvider>
      <ViewEngineProvider context={context}>
        <FormView arch={arch} model="res.partner" id={id} />
      </ViewEngineProvider>
    </UiProvider>
  );
  const rendered = render(contents('p-0'));
  return {
    ...rendered,
    data,
    read,
    save,
    write,
    changeRecord: (id: string): void => {
      rendered.rerender(contents(id));
    },
  };
}

async function editIdentity(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: 'Modifier : Identité' }));
  return screen.getByRole('region', { name: 'Identité' });
}

describe('FormView: editing one card', () => {
  it('edits only the chosen card and saves only changed fields, updating the header too', async () => {
    const user = userEvent.setup();
    const { write } = show();
    const card = await editIdentity(user);
    const name = within(card).getByRole('textbox', { name: 'Nom' });
    expect(name).toHaveValue('Amel Benali 0');
    expect(name).toHaveFocus();
    expect(within(card).getByRole('textbox', { name: 'E-mail' })).toHaveValue(
      'contact0@example.test',
    );
    const other = screen.getByRole('region', { name: 'Coordonnées' });
    expect(within(other).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(other).getByRole('button', { name: 'Modifier : Coordonnées' })).toBeEnabled();

    await user.clear(name);
    await user.type(name, 'Amel modifiée');
    await user.click(within(card).getByRole('button', { name: 'Enregistrer' }));

    expect(write).toHaveBeenCalledExactlyOnceWith('res.partner', 'p-0', { name: 'Amel modifiée' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Amel modifiée' })).toBeVisible();
    expect(within(card).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Modifier : Identité' })).toHaveFocus();
  });

  it('discards a draft when cancelling and starts the next edit with the saved values', async () => {
    const user = userEvent.setup();
    const { write } = show();
    const card = await editIdentity(user);
    const name = within(card).getByRole('textbox', { name: 'Nom' });
    await user.clear(name);
    await user.type(name, 'Brouillon abandonné');
    await user.click(within(card).getByRole('button', { name: 'Annuler' }));

    expect(write).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { level: 1, name: 'Amel Benali 0' })).toBeVisible();
    expect(screen.queryByText('Brouillon abandonné')).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Modifier : Identité' })).toHaveFocus();
    await editIdentity(user);
    expect(within(card).getByRole('textbox', { name: 'Nom' })).toHaveValue('Amel Benali 0');
  });

  it('leaves editing without a write when every value is unchanged', async () => {
    const user = userEvent.setup();
    const { write } = show();
    const card = await editIdentity(user);
    await user.click(within(card).getByRole('button', { name: 'Enregistrer' }));

    expect(write).not.toHaveBeenCalled();
    expect(within(card).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Modifier : Identité' })).toBeVisible();
  });

  it('sends selection keys and boolean values, never their display labels', async () => {
    const user = userEvent.setup();
    const { write } = show();
    const card = await editIdentity(user);
    await user.selectOptions(within(card).getByRole('combobox', { name: 'Type' }), 'person');
    await user.click(within(card).getByRole('checkbox', { name: 'Abonné' }));
    await user.click(within(card).getByRole('button', { name: 'Enregistrer' }));

    expect(write).toHaveBeenCalledExactlyOnceWith('res.partner', 'p-0', {
      kind: 'person',
      subscribed: false,
    });
    expect(await within(card).findByText('Personne')).toBeVisible();
  });

  it('keeps a draft when its notebook page is hidden and restored', async () => {
    const user = userEvent.setup();
    const { write } = show({
      arch: form([
        notebook([
          page('identity', { fr: 'Fiche' }, [
            group({ label: { fr: 'Identité' } }, [field('name'), field('email')]),
          ]),
          page('notes', { fr: 'Notes' }, [group({ label: { fr: 'Remarques' } }, [field('notes')])]),
        ]),
      ]),
    });
    const card = await editIdentity(user);
    const name = within(card).getByRole('textbox', { name: 'Nom' });
    await user.clear(name);
    await user.type(name, 'Brouillon conservé');
    await user.click(screen.getByRole('tab', { name: 'Notes' }));
    expect(screen.queryByRole('textbox', { name: 'Nom' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Fiche' }));
    expect(screen.getByRole('textbox', { name: 'Nom' })).toHaveValue('Brouillon conservé');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(write).toHaveBeenCalledExactlyOnceWith('res.partner', 'p-0', {
      name: 'Brouillon conservé',
    });
  });
});

describe('FormView: validation and failed writes', () => {
  it('shows the saved record returned by the source, including normalized and computed values', async () => {
    const user = userEvent.setup();
    const { write, read } = show({
      arch: form([
        ...editingForm.children,
        group({ label: { fr: 'Valeurs calculées' } }, [field('displayLabel')]),
      ]),
    });
    const card = await editIdentity(user);
    const name = within(card).getByRole('textbox', { name: 'Nom' });
    await user.clear(name);
    await user.type(name, 'amel modifiée');
    read.mockResolvedValueOnce([
      {
        ...contacts(1)[0],
        id: 'p-0',
        name: 'Amel normalisée',
        displayLabel: 'Nom recalculé côté serveur',
      },
    ]);
    await user.click(within(card).getByRole('button', { name: 'Enregistrer' }));

    expect(write).toHaveBeenCalledExactlyOnceWith('res.partner', 'p-0', { name: 'amel modifiée' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Amel normalisée' })).toBeVisible();
    expect(screen.getByText('Nom recalculé côté serveur')).toBeVisible();
    expect(within(card).queryByText('amel modifiée')).not.toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reports a successful save separately from a failed refresh and retries only the read', async () => {
    const user = userEvent.setup();
    const { write, read } = show();
    const card = await editIdentity(user);
    const name = within(card).getByRole('textbox', { name: 'Nom' });
    await user.clear(name);
    await user.type(name, 'Enregistré malgré la coupure');
    read.mockRejectedValueOnce(new Error('Refresh transport details'));
    await user.click(within(card).getByRole('button', { name: 'Enregistrer' }));

    expect(
      await screen.findByText(
        'Modifications enregistrées, mais la fiche n’a pas pu être actualisée.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Modifications enregistrées, mais la fiche n’a pas pu être actualisée.',
    );
    expect(
      screen.queryByText('Les modifications n’ont pas pu être enregistrées. Réessayez.'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Refresh transport details')).not.toBeInTheDocument();
    expect(write).toHaveBeenCalledExactlyOnceWith('res.partner', 'p-0', {
      name: 'Enregistré malgré la coupure',
    });
    expect(read).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole('button', { name: 'Réessayer' }));
    await waitFor(() => {
      expect(
        screen.queryByText('Modifications enregistrées, mais la fiche n’a pas pu être actualisée.'),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole('heading', { level: 1, name: 'Enregistré malgré la coupure' }),
    ).toBeVisible();
    expect(read).toHaveBeenCalledTimes(3);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('associates the required error with its field, focuses it and never sends an invalid draft', async () => {
    const user = userEvent.setup();
    const { write, container } = show();
    const card = await editIdentity(user);
    const name = within(card).getByRole('textbox', { name: 'Nom' });
    await user.clear(name);
    await user.click(within(card).getByRole('button', { name: 'Enregistrer' }));

    expect(write).not.toHaveBeenCalled();
    expect(name).toBeInvalid();
    expect(name).toHaveAccessibleDescription('Le champ « Nom » est obligatoire.');
    await waitFor(() => {
      expect(name).toHaveFocus();
    });
    expect(within(card).getByRole('textbox', { name: 'E-mail' })).toHaveValue(
      'contact0@example.test',
    );
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.type(name, 'Nom corrigé');
    await user.click(within(card).getByRole('button', { name: 'Enregistrer' }));
    expect(write).toHaveBeenCalledExactlyOnceWith('res.partner', 'p-0', { name: 'Nom corrigé' });
  });

  it('shows a server refusal and field error without losing the draft, then retries the corrected value', async () => {
    const user = userEvent.setup();
    const { write } = show();
    write.mockRejectedValueOnce(
      new WriteFailure('Cette modification est refusée.', { email: 'Cette adresse existe déjà.' }),
    );
    const card = await editIdentity(user);
    const email = within(card).getByRole('textbox', { name: 'E-mail' });
    await user.clear(email);
    await user.type(email, 'duplicate@example.test');
    await user.click(within(card).getByRole('button', { name: 'Enregistrer' }));

    expect(await within(card).findByText('Cette modification est refusée.')).toBeVisible();
    expect(email).toHaveValue('duplicate@example.test');
    expect(email).toBeInvalid();
    expect(email).toHaveAccessibleDescription('Cette adresse existe déjà.');
    await waitFor(() => {
      expect(email).toHaveFocus();
    });
    expect(within(card).getByRole('button', { name: 'Annuler' })).toBeEnabled();

    await user.clear(email);
    await user.type(email, 'available@example.test');
    await user.click(within(card).getByRole('button', { name: 'Enregistrer' }));
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith('res.partner', 'p-0', {
      email: 'available@example.test',
    });
    expect(await within(card).findByRole('button', { name: 'Modifier : Identité' })).toBeVisible();
    expect(screen.queryByText('Cette adresse existe déjà.')).not.toBeInTheDocument();
  });

  it('uses a safe generic error for a connection failure and retries the same preserved draft', async () => {
    const user = userEvent.setup();
    const { write } = show();
    write.mockRejectedValueOnce(new Error('Internal transport details'));
    const card = await editIdentity(user);
    const name = within(card).getByRole('textbox', { name: 'Nom' });
    await user.clear(name);
    await user.type(name, 'À réessayer');
    await user.click(within(card).getByRole('button', { name: 'Enregistrer' }));

    expect(await within(card).findByRole('alert')).toHaveTextContent(
      'Les modifications n’ont pas pu être enregistrées. Réessayez.',
    );
    expect(screen.queryByText('Internal transport details')).not.toBeInTheDocument();
    expect(name).toHaveValue('À réessayer');
    expect(within(card).getByRole('button', { name: 'Enregistrer' })).toBeEnabled();
    await user.click(within(card).getByRole('button', { name: 'Enregistrer' }));
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenNthCalledWith(1, 'res.partner', 'p-0', { name: 'À réessayer' });
    expect(write).toHaveBeenNthCalledWith(2, 'res.partner', 'p-0', { name: 'À réessayer' });
    expect(await screen.findByRole('heading', { level: 1, name: 'À réessayer' })).toBeVisible();
  });
});

describe('FormView: read-only fields and sources', () => {
  it('never offers an input for a model- or view-readonly, computed or confidential field', async () => {
    const user = userEvent.setup();
    const registry = buildModelRegistry(
      [
        {
          module: 'test',
          models: [
            defineModel({
              name: 'res.partner',
              fields: {
                name: f.char({ label: { fr: 'Nom' } }),
                email: f.char({ readonly: true, label: { fr: 'E-mail' } }),
                phone: f.char({ label: { fr: 'Téléphone' } }),
                displayLabel: f.char({
                  compute: 'computeLabel',
                  depends: ['name'],
                  store: true,
                  label: { fr: 'Calculé' },
                }),
                vat: f.char({ sensitive: true, label: { fr: 'Identifiant fiscal' } }),
              },
              methods: (Base) =>
                class extends Base {
                  computeLabel(): void {
                    /* Only the server computes this field. */
                  }
                },
            }),
          ],
        },
      ],
      { side: 'client' },
    );
    const { write } = show({
      context: { registry },
      arch: form([
        group({ label: { fr: 'Identité' } }, [
          field('name'),
          field('email'),
          field('phone', { readonly: true }),
          field('displayLabel'),
          field('vat'),
        ]),
        group({ label: { fr: 'Lecture seule' } }, [field('email')]),
      ]),
    });
    const card = await editIdentity(user);
    expect(within(card).getAllByRole('textbox')).toHaveLength(1);
    expect(within(card).getByRole('textbox', { name: 'Nom' })).toBeVisible();
    expect(within(card).getByText('contact0@example.test')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Modifier : Lecture seule' }),
    ).not.toBeInTheDocument();
    const confidential = screen.getByRole('region', { name: 'Données confidentielles' });
    expect(within(confidential).queryByRole('textbox')).not.toBeInTheDocument();
    expect(
      within(confidential).queryByRole('button', { name: /Modifier/ }),
    ).not.toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Enregistrer' }));
    expect(write).not.toHaveBeenCalled();
  });

  it('offers no editing when the data source has no write method', async () => {
    const { write } = show({ readOnly: true });
    expect(await screen.findByRole('heading', { level: 1, name: 'Amel Benali 0' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /Modifier/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(write).not.toHaveBeenCalled();
  });
});

describe('FormView: pending writes and record changes', () => {
  it('starts the next record with no draft from the previous record', async () => {
    const user = userEvent.setup();
    const { changeRecord, write } = show();
    const card = await editIdentity(user);
    const name = within(card).getByRole('textbox', { name: 'Nom' });
    await user.clear(name);
    await user.type(name, 'Ancien brouillon');
    changeRecord('p-1');
    await screen.findByRole('heading', { level: 1, name: 'Karim Haddad 1' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    await editIdentity(user);
    expect(screen.getByRole('textbox', { name: 'Nom' })).toHaveValue('Karim Haddad 1');
    expect(write).not.toHaveBeenCalled();
  });

  it('does not apply a late successful write to the record opened meanwhile', async () => {
    const user = userEvent.setup();
    const { changeRecord, write, save } = show();
    const pending = Promise.withResolvers<undefined>();
    write.mockImplementationOnce(async (model, id, values) => {
      await pending.promise;
      await save(model, id, values);
    });
    const card = await editIdentity(user);
    const name = within(card).getByRole('textbox', { name: 'Nom' });
    await user.clear(name);
    await user.type(name, 'Ancien enregistrement');
    await user.click(within(card).getByRole('button', { name: 'Enregistrer' }));
    expect(write).toHaveBeenCalledExactlyOnceWith('res.partner', 'p-0', {
      name: 'Ancien enregistrement',
    });

    changeRecord('p-1');
    await screen.findByRole('heading', { level: 1, name: 'Karim Haddad 1' });
    await act(async () => {
      pending.resolve(undefined);
      await pending.promise;
    });
    expect(screen.getByRole('heading', { level: 1, name: 'Karim Haddad 1' })).toBeVisible();
    expect(screen.queryByText('Ancien enregistrement')).not.toBeInTheDocument();
    await editIdentity(user);
    expect(screen.getByRole('textbox', { name: 'Nom' })).toHaveValue('Karim Haddad 1');
  });

  it('locks a pending draft and prevents repeated mouse or keyboard submissions', async () => {
    const user = userEvent.setup();
    const { write, save } = show();
    const pending = Promise.withResolvers<undefined>();
    write.mockImplementationOnce(async (model, id, values) => {
      await pending.promise;
      await save(model, id, values);
    });
    const card = await editIdentity(user);
    const name = within(card).getByRole('textbox', { name: 'Nom' });
    await user.clear(name);
    await user.type(name, 'Une seule écriture');
    await user.dblClick(within(card).getByRole('button', { name: 'Enregistrer' }));
    expect(name).toBeDisabled();
    expect(within(card).getByRole('button', { name: 'Annuler' })).toBeDisabled();
    expect(within(card).getByRole('button', { name: /Enregistrement/ })).toBeDisabled();
    await user.keyboard('{Control>}s{/Control}');
    expect(write).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(undefined);
      await pending.promise;
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Une seule écriture' }),
    ).toBeVisible();
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('FormView: accessible editing', () => {
  it('supports escape and control-save with focus restored to the card edit action', async () => {
    const user = userEvent.setup();
    const { write, container } = show();
    const card = await editIdentity(user);
    expect(await accessibilityViolations(container)).toEqual([]);
    await user.keyboard('{Escape}');
    expect(within(card).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Modifier : Identité' })).toHaveFocus();
    expect(write).not.toHaveBeenCalled();

    await user.keyboard('{Enter}');
    const name = within(card).getByRole('textbox', { name: 'Nom' });
    expect(name).toHaveFocus();
    await user.clear(name);
    await user.type(name, 'Enregistré au clavier');
    await user.keyboard('{Control>}s{/Control}');
    expect(write).toHaveBeenCalledExactlyOnceWith('res.partner', 'p-0', {
      name: 'Enregistré au clavier',
    });
    await waitFor(() => {
      expect(within(card).getByRole('button', { name: 'Modifier : Identité' })).toHaveFocus();
    });
  });

  it('labels editing in Arabic and preserves accessible field names', async () => {
    const user = userEvent.setup();
    const { container, write } = show({ context: { language: 'ar' } });
    const card = await screen.findByRole('region', { name: 'الهوية' });
    const action = within(card).getByRole('button');
    expect(action).toHaveAccessibleName(/الهوية/);
    expect(action).not.toHaveAccessibleName(/Modifier|Edit/);
    await user.click(action);
    const name = within(card).getByRole('textbox', { name: 'الاسم' });
    expect(name).toHaveValue('Amel Benali 0');
    expect(within(card).getByRole('textbox', { name: 'البريد' })).toHaveValue(
      'contact0@example.test',
    );
    expect(within(card).queryByRole('button', { name: 'Enregistrer' })).not.toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);
    await user.keyboard('{Escape}');
    expect(write).not.toHaveBeenCalled();
  });
});
