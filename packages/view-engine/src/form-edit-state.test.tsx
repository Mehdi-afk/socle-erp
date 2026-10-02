// SPDX-License-Identifier: LGPL-3.0-only
import { field, form, group, notebook, page, type ViewNode } from '@socle/framework';
import { UiProvider } from '@socle/ui';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ViewEngineProvider } from './context.js';
import { FormView, type FormEditState } from './form-view.js';
import { fixture } from './testing/fixtures.js';
import { WriteFailure, type ViewContext } from './types.js';

const identity = form([group({ label: { fr: 'Identité' } }, [field('name')])]);
const clean: FormEditState = { dirty: false, saving: false };
const dirty: FormEditState = { dirty: true, saving: false };
const saving: FormEditState = { dirty: true, saving: true };

function contents(
  context: ViewContext,
  onEditStateChange: (state: FormEditState) => void,
  id = 'p-0',
  arch: ViewNode = identity,
): React.ReactElement {
  return (
    <UiProvider>
      <ViewEngineProvider context={context}>
        <FormView arch={arch} model="res.partner" id={id} onEditStateChange={onEditStateChange} />
      </ViewEngineProvider>
    </UiProvider>
  );
}

async function begin(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: 'Modifier : Identité' }));
  return screen.getByRole('textbox', { name: 'Nom' });
}

describe('FormView: public edit state', () => {
  it('distinguishes an unchanged open card, changed or invalid drafts, reverting, and cancelling', async () => {
    const user = userEvent.setup();
    const { context } = fixture(1);
    const changed = vi.fn<(state: FormEditState) => void>();
    render(contents(context, changed));
    const input = await begin(user);
    expect(changed).toHaveBeenCalledExactlyOnceWith(clean);

    // An empty required name is still a draft that would be lost when navigating away.
    await user.clear(input);
    expect(changed).toHaveBeenLastCalledWith(dirty);
    await user.type(input, 'Amel Benali 0');
    expect(changed).toHaveBeenLastCalledWith(clean);
    await user.type(input, ' modifiée');
    expect(changed).toHaveBeenLastCalledWith(dirty);
    await user.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(changed).toHaveBeenLastCalledWith(clean);
  });

  it('aggregates drafts across hidden notebook pages and clears only after every draft is gone', async () => {
    const user = userEvent.setup();
    const { context } = fixture(1);
    const changed = vi.fn<(state: FormEditState) => void>();
    const arch = form([
      notebook([
        page('identity', { fr: 'Fiche' }, [group({ label: { fr: 'Identité' } }, [field('name')])]),
        page('details', { fr: 'Détails' }, [
          group({ label: { fr: 'Coordonnées' } }, [field('city')]),
        ]),
      ]),
    ]);
    render(contents(context, changed, 'p-0', arch));
    await user.type(await begin(user), ' modifiée');
    await user.click(screen.getByRole('tab', { name: 'Détails' }));
    expect(changed).toHaveBeenLastCalledWith(dirty);
    await user.click(screen.getByRole('button', { name: 'Modifier : Coordonnées' }));
    await user.type(screen.getByRole('textbox', { name: 'Ville' }), 'Alger');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await screen.findByRole('button', { name: 'Modifier : Coordonnées' });
    expect(changed).toHaveBeenLastCalledWith(dirty);
    await user.click(screen.getByRole('tab', { name: 'Fiche' }));
    expect(screen.getByRole('textbox', { name: 'Nom' })).toHaveValue('Amel Benali 0 modifiée');
    await user.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(changed).toHaveBeenLastCalledWith(clean);
  });

  it.each(['resolve', 'reject'] as const)(
    'reports a pending submission until it %ss and retains a rejected draft',
    async (outcome) => {
      const user = userEvent.setup();
      const { context, data } = fixture(1);
      const pending = Promise.withResolvers<undefined>();
      const write = vi.spyOn(data, 'write').mockReturnValueOnce(pending.promise);
      const changed = vi.fn<(state: FormEditState) => void>();
      render(contents(context, changed));
      await user.type(await begin(user), ' modifiée');
      await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
      await waitFor(() => {
        expect(write).toHaveBeenCalledTimes(1);
      });
      expect(changed).toHaveBeenLastCalledWith(saving);
      expect(screen.getByRole('button', { name: 'Annuler' })).toBeDisabled();

      await act(async () => {
        if (outcome === 'resolve') pending.resolve(undefined);
        else pending.reject(new WriteFailure('Écriture refusée'));
        await pending.promise.catch(() => undefined);
      });
      expect(changed).toHaveBeenLastCalledWith(outcome === 'resolve' ? clean : dirty);
      if (outcome === 'reject') {
        expect(screen.getByRole('textbox', { name: 'Nom' })).toHaveValue('Amel Benali 0 modifiée');
        expect(screen.getByRole('alert')).toHaveTextContent('Écriture refusée');
      }
    },
  );

  it.each(['record', 'source', 'unmount'] as const)(
    'clears on %s changes and ignores an earlier save finishing afterwards',
    async (change) => {
      const user = userEvent.setup();
      const { context, data } = fixture(2);
      const pending = Promise.withResolvers<undefined>();
      const write = vi.spyOn(data, 'write').mockReturnValueOnce(pending.promise);
      const changed = vi.fn<(state: FormEditState) => void>();
      const rendered = render(contents(context, changed));
      await user.type(await begin(user), ' ancien brouillon');
      await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
      await waitFor(() => {
        expect(write).toHaveBeenCalledTimes(1);
      });
      expect(changed).toHaveBeenLastCalledWith(saving);

      if (change === 'unmount') rendered.unmount();
      else {
        rendered.rerender(
          contents(
            change === 'source' ? fixture(2).context : context,
            changed,
            change === 'record' ? 'p-1' : 'p-0',
          ),
        );
        expect(changed).toHaveBeenLastCalledWith(clean);
        await user.type(await begin(user), ' nouveau brouillon');
        expect(changed).toHaveBeenLastCalledWith(dirty);
      }
      const notifications = changed.mock.calls.length;
      await act(async () => {
        pending.resolve(undefined);
        await pending.promise;
      });
      expect(changed).toHaveBeenCalledTimes(notifications);
      expect(changed).toHaveBeenLastCalledWith(change === 'unmount' ? clean : dirty);
    },
  );

  it('notifies outside render without looping when the parent uses an inline callback', async () => {
    const user = userEvent.setup();
    const { context } = fixture(1);
    const changed = vi.fn<(state: FormEditState) => void>();
    function Shell(): React.ReactElement {
      const [state, setState] = useState(clean);
      return (
        <>
          <output aria-label="État">{state.dirty ? 'modifié' : 'initial'}</output>
          {contents(context, (value) => {
            changed(value);
            setState(value);
          })}
        </>
      );
    }
    const rendered = render(<Shell />);
    await user.type(await begin(user), ' modifiée');
    expect(within(screen.getByLabelText('État')).getByText('modifié')).toBeVisible();
    expect(changed.mock.calls).toEqual([[clean], [dirty]]);
    rendered.unmount();
    expect(changed).toHaveBeenLastCalledWith(clean);
  });
});
