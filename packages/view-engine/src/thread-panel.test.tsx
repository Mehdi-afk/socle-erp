// SPDX-License-Identifier: LGPL-3.0-only
import { UiProvider } from '@socle/ui';
import { field, form, node, notebook, page } from '@socle/framework';
import { act, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ViewEngineProvider } from './context.js';
import { FormView } from './form-view.js';
import { fixture } from './testing/fixtures.js';
import type { ThreadPage, ThreadSource } from './types.js';

const initial: ThreadPage = {
  messages: [],
  before: null,
  activities: [],
  types: [],
  following: false,
  canPost: true,
  internal: true,
};
function renderThread(thread: ThreadSource, onEditStateChange = vi.fn()) {
  const f = fixture(1);
  const context = { ...f.context, data: { ...f.data, thread } };
  const arch = form([
    field('name'),
    notebook([
      page('activity', 'Activité', [node('chatter')]),
      page('address', 'Adresse', [field('city')]),
    ]),
  ]);
  return {
    ...render(
      <UiProvider>
        <ViewEngineProvider context={context}>
          <FormView
            arch={arch}
            model="res.partner"
            id="p-0"
            onEditStateChange={onEditStateChange}
          />
        </ViewEngineProvider>
      </UiProvider>,
    ),
    onEditStateChange,
  };
}
function source(overrides: Partial<ThreadSource> = {}): ThreadSource {
  return {
    read: vi.fn(() => Promise.resolve(initial)),
    post: vi.fn(() => Promise.resolve()),
    follow: vi.fn(() => Promise.resolve()),
    schedule: vi.fn(() => Promise.resolve()),
    finish: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}
describe('generic chatter drafts', () => {
  it('keeps the message draft and dirty guard when switching notebook panels', async () => {
    const user = userEvent.setup();
    const { onEditStateChange } = renderThread(source());
    await screen.findByLabelText('Message', { exact: true });
    await user.type(screen.getByLabelText('Message', { exact: true }), 'Mon brouillon');
    await user.click(screen.getByRole('tab', { name: 'Adresse' }));
    expect(onEditStateChange).toHaveBeenLastCalledWith({ dirty: true, saving: false });
    await user.click(screen.getByRole('tab', { name: 'Activité' }));
    expect(screen.getByLabelText('Message', { exact: true })).toHaveValue('Mon brouillon');
  });
  it('prevents duplicate submissions and clears an accepted draft even if the refresh fails', async () => {
    const user = userEvent.setup();
    let accept!: () => void;
    const post = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    const read = vi.fn().mockResolvedValueOnce(initial).mockRejectedValue(new Error('Unavailable'));
    renderThread(source({ post, read }));
    await screen.findByLabelText('Message', { exact: true });
    await user.type(screen.getByLabelText('Message', { exact: true }), 'Une fois');
    await user.click(screen.getByRole('button', { name: 'Publier' }));
    expect(screen.getByRole('button', { name: 'Publier' })).toBeDisabled();
    await act(() => {
      accept();
      return Promise.resolve();
    });
    await screen.findByText('Enregistré. Actualisez pour afficher les derniers échanges.');
    expect(post).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Message', { exact: true })).toHaveValue('');
  });
  it('retains a rejected draft and renders attacker text as text', async () => {
    const user = userEvent.setup();
    const text = '<img src=x onerror=alert(1)>';
    const thread = source({
      read: vi.fn(() =>
        Promise.resolve({
          ...initial,
          messages: [
            {
              id: 'm',
              kind: 'comment' as const,
              body: text,
              authorId: 'u',
              createdAt: '2026-10-02T12:00:00Z',
              changes: null,
            },
          ],
        }),
      ),
      post: vi.fn(() => Promise.reject(new Error('Denied'))),
    });
    const rendered = renderThread(thread);
    await screen.findByText(text);
    expect(rendered.container.querySelector('.ve-thread-message img')).toBeNull();
    await user.type(screen.getByLabelText('Message', { exact: true }), 'À conserver');
    await user.click(screen.getByRole('button', { name: 'Publier' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Message', { exact: true })).toHaveValue('À conserver');
  });
});
