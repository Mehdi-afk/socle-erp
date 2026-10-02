// SPDX-License-Identifier: LGPL-3.0-only
import { hydrateRegistrySnapshot } from '@socle/framework';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WebApp, type WebRuntime } from './app.js';
import type { AuthClient } from './auth-client.js';
import type { RpcDataSource, WebClient } from './rpc-data-source.js';
import { RpcDataError } from './rpc-errors.js';
import type Workspace from './workspace.js';

type WorkspaceProps = React.ComponentProps<typeof Workspace>;

// Keep the real authentication screen and app state machine, while exposing the lazy workspace
// boundary without involving the view engine's independent rendering and editing tests.
vi.mock('./workspace.js', async () => {
  const { useMemo, useState } = await import('react');
  const { PreferenceControls } = await import('./preferences.js');
  const { watchSession } = await import('./session-data.js');
  return {
    default: function WorkspaceBoundary({
      client,
      preferences,
      onPreferences,
      onExpired,
      onLogout,
    }: WorkspaceProps): React.ReactElement {
      const data = useMemo(() => watchSession(client.data, onExpired), [client, onExpired]);
      const [failure, setFailure] = useState(false);
      return (
        <section aria-label="Workspace">
          <h1>{client.userId}</h1>
          <ul>
            {client.registry.names().map((model) => (
              <li key={model}>{model}</li>
            ))}
          </ul>
          <PreferenceControls value={preferences} onChange={onPreferences} />
          <button
            type="button"
            onClick={() => {
              void data
                .read('test.partner', ['a0000000-0000-4000-8000-000000000001'], ['name'])
                .catch(() => undefined);
            }}
          >
            Load record
          </button>
          <button
            type="button"
            onClick={() => {
              setFailure(false);
              void onLogout().catch(() => {
                setFailure(true);
              });
            }}
          >
            Sign out
          </button>
          {failure ? <p role="alert">Sign-out failed</p> : null}
        </section>
      );
    },
  };
});

function makeAuth() {
  return {
    login: vi.fn<AuthClient['login']>().mockResolvedValue({ kind: 'authenticated' }),
    verify: vi.fn<AuthClient['verify']>().mockResolvedValue(undefined),
    setupTotp: vi.fn<AuthClient['setupTotp']>(),
    confirmTotp: vi.fn<AuthClient['confirmTotp']>(),
    sendEmail: vi.fn<AuthClient['sendEmail']>().mockResolvedValue(undefined),
    enableEmail: vi.fn<AuthClient['enableEmail']>().mockResolvedValue(undefined),
    confirmEmail: vi.fn<AuthClient['confirmEmail']>().mockResolvedValue(undefined),
    passkey: vi.fn<AuthClient['passkey']>().mockResolvedValue(undefined),
    providers: vi.fn<AuthClient['providers']>().mockResolvedValue([]),
    logout: vi.fn<AuthClient['logout']>().mockResolvedValue(undefined),
    dispose: vi.fn<AuthClient['dispose']>(),
  } satisfies AuthClient;
}

function makeClient(userId = 'alice') {
  const catalog = hydrateRegistrySnapshot({
    version: 1,
    userId,
    companyId: null,
    models: [
      {
        name: 'test.partner',
        description: { fr: 'Contacts' },
        permissions: { create: false, write: false, unlink: false },
        fields: [
          { name: 'id', type: 'char', stored: true, readonly: true, required: true },
          { name: 'name', type: 'char', stored: true, readonly: true },
        ],
        order: [{ field: 'id', direction: 'asc' }],
      },
    ],
    views: [
      {
        id: 'test.partner_list',
        model: 'test.partner',
        type: 'list',
        priority: 16,
        arch: {
          type: 'list',
          attrs: {},
          children: [{ type: 'field', attrs: { name: 'name' }, children: [] }],
        },
      },
    ],
  });
  const data = {
    userId,
    read: vi.fn<RpcDataSource['read']>().mockResolvedValue([]),
    search: vi.fn<RpcDataSource['search']>().mockResolvedValue({ records: [], total: 0 }),
    displayNames: vi.fn<RpcDataSource['displayNames']>().mockResolvedValue(new Map()),
    write: vi.fn<RpcDataSource['write']>().mockResolvedValue(undefined),
    dispose: vi.fn<RpcDataSource['dispose']>(),
  } satisfies RpcDataSource;
  return {
    ...catalog,
    data,
    dispose: vi.fn(() => {
      data.dispose();
    }),
  } satisfies WebClient;
}

function fixture(userId = 'alice') {
  const auth = makeAuth();
  const client = makeClient(userId);
  const runtime = {
    auth: vi.fn<WebRuntime['auth']>().mockReturnValue(auth),
    connect: vi.fn<WebRuntime['connect']>().mockResolvedValue(client),
  } satisfies WebRuntime;
  return { auth, client, runtime };
}

async function signIn(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  // Session transitions are under test here; AuthScreens and Chromium also exercise input.
  await user.click(await screen.findByRole('textbox', { name: 'Identifiant' }));
  await user.paste('alice@example.test');
  await user.click(screen.getByLabelText(/Mot de passe/));
  await user.paste('example-password');
  await user.click(screen.getByRole('button', { name: 'Se connecter' }));
}

afterEach(() => {
  for (const attribute of ['lang', 'dir', 'data-theme', 'data-density']) {
    document.documentElement.removeAttribute(attribute);
  }
});

describe('WebApp: authentication and restore', () => {
  it('shows sign-in after a 401 restore and opens a fresh client after authentication', async () => {
    const user = userEvent.setup();
    const { auth, runtime } = fixture();
    runtime.connect.mockRejectedValueOnce(new RpcDataError('unauthenticated', 'fr', 401));
    render(<WebApp runtime={runtime} />);
    await signIn(user);
    expect(await screen.findByRole('heading', { name: 'alice' })).toBeVisible();
    expect(auth.login).toHaveBeenCalledExactlyOnceWith('alice@example.test', 'example-password');
    expect(runtime.connect).toHaveBeenCalledTimes(2);
    expect(runtime.connect.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    expect(runtime.connect.mock.calls[1]?.[0].signal?.aborted).toBe(false);
    expect(screen.queryByLabelText(/Mot de passe/)).not.toBeInTheDocument();
  });

  it('mounts the restored catalogue and closes its source and auth client on unmount', async () => {
    const { runtime, auth, client } = fixture();
    const rendered = render(<WebApp runtime={runtime} />);
    const workspace = await screen.findByRole('region', { name: 'Workspace' });
    expect(within(workspace).getByRole('heading', { name: 'alice' })).toBeVisible();
    expect(within(workspace).getByText('test.partner')).toBeVisible();
    expect(runtime.connect).toHaveBeenCalledTimes(1);
    expect(runtime.connect.mock.calls[0]?.[0].language).toBe('fr');
    expect(runtime.connect.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    expect(runtime.auth).toHaveBeenCalledTimes(1);
    expect(auth.login).not.toHaveBeenCalled();
    rendered.unmount();
    expect(client.dispose).toHaveBeenCalledTimes(1);
    expect(auth.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.connect.mock.calls[0]?.[0].signal?.aborted).toBe(true);
  });

  it('disposes a late connect result after unmount even when the runtime ignores abort', async () => {
    const { runtime, auth, client } = fixture();
    const pending = Promise.withResolvers<WebClient>();
    runtime.connect.mockReturnValueOnce(pending.promise);
    const rendered = render(<WebApp runtime={runtime} />);
    rendered.unmount();
    expect(runtime.connect.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    expect(auth.dispose).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve(client);
      await pending.promise;
    });
    expect(client.dispose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('region', { name: 'Workspace' })).not.toBeInTheDocument();
  });

  it('ignores an earlier runtime response after a replacement client has connected', async () => {
    const first = fixture();
    const second = fixture('bob');
    const stale = Promise.withResolvers<WebClient>();
    first.runtime.connect.mockReturnValueOnce(stale.promise);
    const rendered = render(<WebApp runtime={first.runtime} />);
    rendered.rerender(<WebApp runtime={second.runtime} />);
    expect(await screen.findByRole('heading', { name: 'bob' })).toBeVisible();
    expect(first.auth.dispose).toHaveBeenCalledTimes(1);
    expect(first.runtime.connect.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    await act(async () => {
      stale.resolve(first.client);
      await stale.promise;
    });
    expect(first.client.dispose).toHaveBeenCalledTimes(1);
    expect(second.client.dispose).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'alice' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'bob' })).toBeVisible();
  });

  it('uses an OIDC challenge directly and restores only after its factor succeeds', async () => {
    const user = userEvent.setup();
    const { runtime, auth } = fixture();
    const challenge = 'x'.repeat(43);
    render(
      <WebApp
        runtime={runtime}
        callback={{ kind: 'challenge', challenge, mfa: 'verify', methods: ['totp'] }}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Vérifiez votre identité' })).toBeVisible();
    expect(runtime.connect).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Identifiant' })).not.toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Code de vérification' }), '123456');
    await user.click(screen.getByRole('button', { name: 'Vérifier' }));
    expect(await screen.findByRole('heading', { name: 'alice' })).toBeVisible();
    expect(auth.verify).toHaveBeenCalledExactlyOnceWith(challenge, { code: '123456' });
    expect(auth.login).not.toHaveBeenCalled();
    expect(runtime.connect).toHaveBeenCalledTimes(1);
  });

  it('shows a failed OIDC callback without silently restoring another existing session', async () => {
    const { runtime } = fixture();
    render(<WebApp runtime={runtime} callback={{ kind: 'failed' }} />);
    expect(await screen.findByRole('textbox', { name: 'Identifiant' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('La connexion externe a échoué.');
    expect(runtime.connect).not.toHaveBeenCalled();
  });

  it('updates language, direction, theme and density without reconnecting or recreating auth', async () => {
    const user = userEvent.setup();
    const { runtime, client } = fixture();
    render(<WebApp runtime={runtime} />);
    await screen.findByRole('heading', { name: 'alice' });
    await user.click(screen.getByText('Préférences'));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Langue' }), 'en');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Theme' }), 'dark');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Density' }), 'compact');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'ar');
    expect(document.documentElement).toHaveAttribute('lang', 'ar');
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(document.documentElement).toHaveAttribute('data-density', 'compact');
    expect(runtime.connect).toHaveBeenCalledTimes(1);
    expect(runtime.auth).toHaveBeenCalledTimes(1);
    expect(client.dispose).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'alice' })).toBeVisible();
  });
});

describe('WebApp: expiration and logout', () => {
  it.each(['unauthenticated', 'csrf'] as const)(
    'closes expired data (%s) and returns to sign-in without retrying',
    async (code) => {
      const user = userEvent.setup();
      const { runtime, client } = fixture();
      client.data.read.mockRejectedValueOnce(
        new RpcDataError(code, 'fr', code === 'csrf' ? 403 : 401),
      );
      render(<WebApp runtime={runtime} />);
      await user.click(await screen.findByRole('button', { name: 'Load record' }));
      expect(await screen.findByRole('textbox', { name: 'Identifiant' })).toBeVisible();
      expect(screen.getByRole('status')).toHaveTextContent('Votre session a expiré ou a changé.');
      expect(client.dispose).toHaveBeenCalledTimes(1);
      expect(runtime.connect).toHaveBeenCalledTimes(1);
      expect(client.data.read).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('region', { name: 'Workspace' })).not.toBeInTheDocument();
    },
  );

  it('waits for logout before allowing reauthentication, including concurrent data expiration', async () => {
    const user = userEvent.setup();
    const { runtime, client, auth } = fixture();
    const next = makeClient('bob');
    const logout = Promise.withResolvers<undefined>();
    const read = Promise.withResolvers<Awaited<ReturnType<RpcDataSource['read']>>>();
    auth.logout.mockReturnValueOnce(logout.promise);
    client.data.read.mockReturnValueOnce(read.promise);
    runtime.connect.mockResolvedValueOnce(client).mockResolvedValueOnce(next);
    render(<WebApp runtime={runtime} />);
    await user.click(await screen.findByRole('button', { name: 'Load record' }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(auth.logout).toHaveBeenCalledTimes(1);
    await act(async () => {
      read.reject(new RpcDataError('unauthenticated', 'fr', 401));
      await read.promise.catch(() => undefined);
    });
    expect(screen.queryByRole('textbox', { name: 'Identifiant' })).not.toBeInTheDocument();
    expect(auth.login).not.toHaveBeenCalled();
    expect(runtime.connect).toHaveBeenCalledTimes(1);
    await act(async () => {
      logout.resolve(undefined);
      await logout.promise;
    });
    await signIn(user);
    expect(await screen.findByRole('heading', { name: 'bob' })).toBeVisible();
    expect(client.dispose).toHaveBeenCalledTimes(1);
    expect(next.dispose).not.toHaveBeenCalled();
  });

  it('does not close a replacement runtime when an old logout completes after disposal', async () => {
    const user = userEvent.setup();
    const first = fixture();
    const second = fixture('bob');
    const staleLogout = Promise.withResolvers<undefined>();
    first.auth.logout.mockReturnValueOnce(staleLogout.promise);
    const rendered = render(<WebApp runtime={first.runtime} />);
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(first.auth.logout).toHaveBeenCalledTimes(1);
    rendered.rerender(<WebApp runtime={second.runtime} />);
    await screen.findByRole('heading', { name: 'bob' });
    await act(async () => {
      staleLogout.resolve(undefined);
      await staleLogout.promise;
    });
    expect(screen.getByRole('heading', { name: 'bob' })).toBeVisible();
    expect(first.auth.dispose).toHaveBeenCalledTimes(1);
    expect(second.client.dispose).not.toHaveBeenCalled();
    expect(second.runtime.connect).toHaveBeenCalledTimes(1);
  });

  it('releases the logout guard after a failure so an explicit retry can complete', async () => {
    const user = userEvent.setup();
    const { runtime, auth } = fixture();
    auth.logout.mockRejectedValueOnce(new Error('Connection interrupted'));
    render(<WebApp runtime={runtime} />);
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Sign-out failed');
    });
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('textbox', { name: 'Identifiant' })).toBeVisible();
    expect(auth.logout).toHaveBeenCalledTimes(2);
    expect(runtime.connect).toHaveBeenCalledTimes(1);
  });

  it('keeps the new logout locked when an older runtime finishes its own logout', async () => {
    const user = userEvent.setup();
    const first = fixture();
    const second = fixture('bob');
    const oldLogout = Promise.withResolvers<undefined>();
    const newLogout = Promise.withResolvers<undefined>();
    const read = Promise.withResolvers<Awaited<ReturnType<RpcDataSource['read']>>>();
    first.auth.logout.mockReturnValueOnce(oldLogout.promise);
    second.auth.logout.mockReturnValueOnce(newLogout.promise);
    second.client.data.read.mockReturnValueOnce(read.promise);
    const rendered = render(<WebApp runtime={first.runtime} />);
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    rendered.rerender(<WebApp runtime={second.runtime} />);
    await screen.findByRole('heading', { name: 'bob' });
    await user.click(screen.getByRole('button', { name: 'Load record' }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(second.auth.logout).toHaveBeenCalledTimes(1);
    await act(async () => {
      oldLogout.resolve(undefined);
      await oldLogout.promise;
      read.reject(new RpcDataError('unauthenticated', 'fr', 401));
      await read.promise.catch(() => undefined);
    });
    expect(screen.queryByRole('textbox', { name: 'Identifiant' })).not.toBeInTheDocument();
    expect(second.client.dispose).not.toHaveBeenCalled();
    await act(async () => {
      newLogout.resolve(undefined);
      await newLogout.promise;
    });
    expect(await screen.findByRole('textbox', { name: 'Identifiant' })).toBeVisible();
    expect(second.client.dispose).toHaveBeenCalledTimes(1);
  });
});
