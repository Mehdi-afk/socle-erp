// SPDX-License-Identifier: LGPL-3.0-only
import { UiProvider } from '@socle/ui';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { accessibilityViolations } from '../../../packages/ui/src/testing/axe.js';

import { AuthError, type AuthClient, type AuthResult } from './auth-client.js';
import { AuthScreen, type AuthScreenProps } from './auth-screen.js';
import { copyFor } from './copy.js';

const copy = copyFor('fr');
const challenge = 'c'.repeat(43);
const secret = 'A'.repeat(32);
const codes = Array.from('ABCDEFGHIJ', (char) => `${char}AAA-AAAA-AAAA-AAAA`);
type Challenge = Extract<AuthResult, { kind: 'challenge' }>;
const verification = (methods: Challenge['methods'] = ['totp', 'recovery']): Challenge => ({
  kind: 'challenge',
  challenge,
  mfa: 'verify',
  methods,
});
const enrollment = (methods: Challenge['methods'] = ['totp', 'email']): Challenge => ({
  kind: 'challenge',
  challenge,
  mfa: 'enroll',
  methods,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function fixture() {
  return {
    login: vi.fn<AuthClient['login']>().mockResolvedValue({ kind: 'authenticated' }),
    verify: vi.fn<AuthClient['verify']>().mockResolvedValue(undefined),
    setupTotp: vi
      .fn<AuthClient['setupTotp']>()
      .mockResolvedValue({ secret, uri: `otpauth://totp/Socle?secret=${secret}` }),
    confirmTotp: vi.fn<AuthClient['confirmTotp']>().mockResolvedValue(codes),
    sendEmail: vi.fn<AuthClient['sendEmail']>().mockResolvedValue(undefined),
    enableEmail: vi.fn<AuthClient['enableEmail']>().mockResolvedValue(undefined),
    confirmEmail: vi.fn<AuthClient['confirmEmail']>().mockResolvedValue(undefined),
    passkey: vi.fn<AuthClient['passkey']>().mockResolvedValue(undefined),
    providers: vi.fn<AuthClient['providers']>().mockResolvedValue([]),
    logout: vi.fn<AuthClient['logout']>().mockResolvedValue(undefined),
    dispose: vi.fn<AuthClient['dispose']>(),
  };
}
function show(props: Partial<AuthScreenProps> = {}, client = fixture()) {
  const onAuthenticated = vi.fn<() => void>();
  const result = render(
    <UiProvider>
      <AuthScreen client={client} language="fr" onAuthenticated={onAuthenticated} {...props} />
    </UiProvider>,
  );
  return { ...result, client, onAuthenticated, user: userEvent.setup() };
}

describe('password sign-in screen', () => {
  it('trims the login while preserving the exact password, and opens only after success', async () => {
    const pending = deferred<AuthResult>();
    const client = fixture();
    client.login.mockReturnValue(pending.promise);
    const { user, onAuthenticated } = show({}, client);
    await user.type(screen.getByLabelText(copy.login, { exact: false }), '  member@example.test  ');
    await user.type(screen.getByLabelText(copy.password, { exact: false }), ' exact password ');
    await user.click(screen.getByRole('button', { name: copy.signIn }));
    expect(client.login).toHaveBeenCalledExactlyOnceWith('member@example.test', ' exact password ');
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(screen.getByLabelText(copy.password, { exact: false })).toBeDisabled();
    await act(async () => {
      pending.resolve({ kind: 'authenticated' });
      await pending.promise;
    });
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText(copy.password, { exact: false })).toHaveValue('');
  });

  it('renders safe localized errors and allows an explicit retry', async () => {
    const client = fixture();
    client.login.mockRejectedValueOnce(new Error('RAW PASSWORD OR SERVER DETAIL'));
    const { user, onAuthenticated } = show({}, client);
    await user.type(screen.getByLabelText(copy.login, { exact: false }), 'member');
    await user.type(screen.getByLabelText(copy.password, { exact: false }), 'password');
    await user.click(screen.getByRole('button', { name: copy.signIn }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      new AuthError('unavailable', 'fr').message,
    );
    expect(screen.queryByText(/RAW PASSWORD/)).not.toBeInTheDocument();
    expect(onAuthenticated).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: copy.signIn }));
    await waitFor(() => {
      expect(onAuthenticated).toHaveBeenCalledTimes(1);
    });
    expect(client.login).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears the password on a challenge and never opens the application prematurely', async () => {
    const client = fixture();
    client.login.mockResolvedValue(verification(['email']));
    const { user, onAuthenticated } = show({}, client);
    await user.type(screen.getByLabelText(copy.login, { exact: false }), 'member');
    await user.type(screen.getByLabelText(copy.password, { exact: false }), 'password');
    await user.click(screen.getByRole('button', { name: copy.signIn }));
    expect(await screen.findByRole('heading', { name: copy.verify })).toBeVisible();
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(copy.password, { exact: false })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.restart }));
    expect(screen.getByLabelText(copy.password, { exact: false })).toHaveValue('');
    expect(screen.getByLabelText(copy.login, { exact: false })).toHaveValue('member');
  });

  it('does not submit twice even if two submit events arrive before completion', async () => {
    const pending = deferred<AuthResult>();
    const client = fixture();
    client.login.mockReturnValue(pending.promise);
    const { user, onAuthenticated } = show({}, client);
    await user.type(screen.getByLabelText(copy.login, { exact: false }), 'member');
    await user.type(screen.getByLabelText(copy.password, { exact: false }), 'password');
    const form = screen.getByRole('button', { name: copy.signIn }).closest('form');
    expect(form).not.toBeNull();
    if (!form) throw new Error('Expected sign-in form');
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(client.login).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve({ kind: 'authenticated' });
      await pending.promise;
    });
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
  });

  it('does not call onAuthenticated when sign-in completes after the screen unmounts', async () => {
    const pending = deferred<AuthResult>();
    const client = fixture();
    client.login.mockReturnValue(pending.promise);
    const { user, onAuthenticated, unmount } = show({}, client);
    await user.type(screen.getByLabelText(copy.login, { exact: false }), 'member');
    await user.type(screen.getByLabelText(copy.password, { exact: false }), 'password');
    await user.click(screen.getByRole('button', { name: copy.signIn }));
    unmount();
    await act(async () => {
      pending.resolve({ kind: 'authenticated' });
      await pending.promise;
    });
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it('isolates a new client from a pending sign-in and provider discovery on the old client', async () => {
    const loginResult = deferred<AuthResult>();
    const oldProviders = deferred<readonly { id: string; label: string }[]>();
    const first = fixture();
    first.login.mockReturnValue(loginResult.promise);
    first.providers.mockReturnValue(oldProviders.promise);
    const second = fixture();
    second.providers.mockResolvedValue([{ id: 'new-provider', label: 'New provider' }]);
    const { user, onAuthenticated, rerender } = show({}, first);
    await user.type(screen.getByLabelText(copy.login, { exact: false }), 'first-user');
    await user.type(screen.getByLabelText(copy.password, { exact: false }), 'first-password');
    await user.click(screen.getByRole('button', { name: copy.signIn }));
    rerender(
      <UiProvider>
        <AuthScreen client={second} language="fr" onAuthenticated={onAuthenticated} />
      </UiProvider>,
    );
    expect(screen.getByLabelText(copy.login, { exact: false })).toHaveValue('');
    expect(screen.getByLabelText(copy.password, { exact: false })).toHaveValue('');
    expect(screen.getByRole('button', { name: copy.signIn })).toBeEnabled();
    expect(await screen.findByRole('link', { name: `${copy.oidc} New provider` })).toBeVisible();
    await act(async () => {
      oldProviders.resolve([{ id: 'old-provider', label: 'Old provider' }]);
      loginResult.resolve({ kind: 'authenticated' });
      await Promise.all([oldProviders.promise, loginResult.promise]);
    });
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('link', { name: `${copy.oidc} Old provider` }),
    ).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(copy.login, { exact: false }), 'second-user');
    await user.type(screen.getByLabelText(copy.password, { exact: false }), 'second-password');
    await user.click(screen.getByRole('button', { name: copy.signIn }));
    expect(second.login).toHaveBeenCalledExactlyOnceWith('second-user', 'second-password');
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
  });
});

describe('MFA verification screen', () => {
  it('stays on the challenge after a rejected code and retries that same challenge explicitly', async () => {
    const client = fixture();
    client.verify.mockRejectedValueOnce(new AuthError('invalid_code', 'fr'));
    const { user, onAuthenticated } = show({ initialChallenge: verification() }, client);
    await user.type(screen.getByLabelText(copy.code, { exact: false }), '123456');
    await user.click(screen.getByRole('button', { name: copy.confirm }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      new AuthError('invalid_code').message,
    );
    expect(screen.getByRole('heading', { name: copy.verify })).toBeVisible();
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(client.login).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText(copy.code, { exact: false }));
    await user.type(screen.getByLabelText(copy.code, { exact: false }), '654321');
    await user.click(screen.getByRole('button', { name: copy.confirm }));
    await waitFor(() => {
      expect(onAuthenticated).toHaveBeenCalledTimes(1);
    });
    expect(client.verify.mock.calls).toEqual([
      [challenge, { code: '123456' }],
      [challenge, { code: '654321' }],
    ]);
  });

  it('offers only announced methods and maps a recovery code to the recovery answer', async () => {
    const { user, client, onAuthenticated } = show({ initialChallenge: verification() });
    const select = screen.getByRole('combobox', { name: copy.method });
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([copy.totp, copy.recovery]);
    expect(screen.queryByRole('button', { name: copy.send })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(copy.code, { exact: false }), '123456');
    await user.selectOptions(select, 'recovery');
    expect(screen.getByLabelText(copy.recovery, { exact: false })).toHaveValue('');
    await user.type(screen.getByLabelText(copy.recovery, { exact: false }), 'AAAA-BBBB-CCCC-DDDD');
    await user.click(screen.getByRole('button', { name: copy.confirm }));
    expect(client.verify).toHaveBeenCalledExactlyOnceWith(challenge, {
      recovery: 'AAAA-BBBB-CCCC-DDDD',
    });
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
  });

  it('sends an email only on request and verifies its distinct answer', async () => {
    const { user, client, onAuthenticated } = show({ initialChallenge: verification(['email']) });
    expect(client.sendEmail).not.toHaveBeenCalled();
    expect(screen.queryByText(copy.sent)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.send }));
    expect(client.sendEmail).toHaveBeenCalledExactlyOnceWith(challenge);
    expect(await screen.findByRole('status')).toHaveTextContent(copy.sent);
    await user.type(screen.getByLabelText(copy.code, { exact: false }), '012345');
    await user.click(screen.getByRole('button', { name: copy.confirm }));
    expect(client.verify).toHaveBeenCalledExactlyOnceWith(challenge, { emailCode: '012345' });
    expect(client.enableEmail).not.toHaveBeenCalled();
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
  });

  it('starts the passkey ceremony only after a deliberate click and supports a passkey-only account', async () => {
    const { user, client, onAuthenticated } = show({ initialChallenge: verification(['passkey']) });
    expect(screen.queryByLabelText(copy.code, { exact: false })).not.toBeInTheDocument();
    expect(client.passkey).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: copy.passkey }));
    expect(client.passkey).toHaveBeenCalledExactlyOnceWith(challenge);
    expect(client.verify).not.toHaveBeenCalled();
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
  });

  it('keeps the challenge usable after cancellation of a native passkey prompt', async () => {
    const client = fixture();
    client.passkey.mockRejectedValueOnce(new AuthError('cancelled'));
    const { user, onAuthenticated } = show({ initialChallenge: verification(['passkey']) }, client);
    await user.click(screen.getByRole('button', { name: copy.passkey }));
    expect(await screen.findByRole('alert')).toHaveTextContent(new AuthError('cancelled').message);
    expect(onAuthenticated).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: copy.passkey }));
    expect(client.passkey).toHaveBeenCalledTimes(2);
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
  });

  it('prevents restart, method changes and duplicate verification while a request is pending', async () => {
    const pending = deferred<undefined>();
    const client = fixture();
    client.verify.mockReturnValue(pending.promise);
    const { user, onAuthenticated } = show({ initialChallenge: verification() }, client);
    await user.type(screen.getByLabelText(copy.code, { exact: false }), '123456');
    await user.click(screen.getByRole('button', { name: copy.confirm }));
    const restart = screen.getByRole('button', { name: copy.restart });
    expect(restart).toBeDisabled();
    expect(screen.getByRole('combobox', { name: copy.method })).toBeDisabled();
    await user.click(restart);
    const form = restart.closest('form');
    if (!form) throw new Error('Expected verification form');
    fireEvent.submit(form);
    expect(client.verify).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText(copy.password, { exact: false })).not.toBeInTheDocument();
    await act(async () => {
      pending.resolve(undefined);
      await pending.promise;
    });
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
  });

  it('does not authenticate after a verification finishes on an unmounted screen', async () => {
    const pending = deferred<undefined>();
    const client = fixture();
    client.passkey.mockReturnValue(pending.promise);
    const { user, onAuthenticated, unmount } = show(
      { initialChallenge: verification(['passkey']) },
      client,
    );
    await user.click(screen.getByRole('button', { name: copy.passkey }));
    unmount();
    await act(async () => {
      pending.resolve(undefined);
      await pending.promise;
    });
    expect(onAuthenticated).not.toHaveBeenCalled();
  });
});

describe('required MFA enrollment', () => {
  it('creates the TOTP secret only after a deliberate request and requires recovery-code acknowledgement', async () => {
    const { user, client, onAuthenticated } = show({ initialChallenge: enrollment() });
    expect(client.setupTotp).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(copy.secret, { exact: false })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.confirm })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: copy.setup }));
    expect(client.setupTotp).toHaveBeenCalledExactlyOnceWith(challenge);
    const key = await screen.findByLabelText(copy.secret, { exact: false });
    expect(key).toHaveValue(secret);
    expect(key).toHaveAttribute('readonly');
    await user.type(screen.getByLabelText(copy.code, { exact: false }), '012345');
    await user.click(screen.getByRole('button', { name: copy.confirm }));
    expect(client.confirmTotp).toHaveBeenCalledExactlyOnceWith(challenge, '012345');
    expect(await screen.findByRole('heading', { name: copy.codes })).toBeVisible();
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(copy.secret, { exact: false })).not.toBeInTheDocument();
    for (const code of codes) expect(screen.getByText(code)).toBeVisible();
    await user.click(screen.getByRole('button', { name: copy.savedCodes }));
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
  });

  it('enrolls email with enable/confirm without calling the sign-in email-send route', async () => {
    const { user, client, onAuthenticated } = show({
      initialChallenge: enrollment(['totp', 'email', 'passkey']),
    });
    const select = screen.getByRole('combobox', { name: copy.method });
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([copy.totp, copy.email]);
    await user.selectOptions(select, 'email');
    await user.click(screen.getByRole('button', { name: copy.send }));
    expect(client.enableEmail).toHaveBeenCalledExactlyOnceWith(challenge);
    expect(client.sendEmail).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText(copy.code, { exact: false }), '012345');
    await user.click(screen.getByRole('button', { name: copy.confirm }));
    expect(client.confirmEmail).toHaveBeenCalledExactlyOnceWith(challenge, '012345');
    expect(client.verify).not.toHaveBeenCalled();
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
  });

  it('clears setup keys and entered codes when restarting enrollment', async () => {
    const { user } = show({ initialChallenge: enrollment() });
    await user.click(screen.getByRole('button', { name: copy.setup }));
    await screen.findByLabelText(copy.secret, { exact: false });
    await user.type(screen.getByLabelText(copy.code, { exact: false }), '012345');
    await user.click(screen.getByRole('button', { name: copy.restart }));
    expect(screen.getByLabelText(copy.password, { exact: false })).toHaveValue('');
    expect(screen.queryByLabelText(copy.secret, { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(copy.code, { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
  });
});

describe('provider discovery and accessibility', () => {
  it('renders only providers actually returned by the server, using local start URLs', async () => {
    const pending = deferred<readonly { id: string; label: string }[]>();
    const client = fixture();
    client.providers.mockReturnValue(pending.promise);
    show({}, client);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    await act(async () => {
      pending.resolve([{ id: 'corporate', label: 'Corporate SSO' }]);
      await pending.promise;
    });
    const link = screen.getByRole('link', { name: `${copy.oidc} Corporate SSO` });
    expect(link).toHaveAttribute('href', '/auth/oidc/corporate/start');
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('does not advertise a provider when discovery fails and leaves password sign-in available', async () => {
    const client = fixture();
    client.providers.mockRejectedValue(new AuthError('unavailable'));
    show({}, client);
    await waitFor(() => {
      expect(client.providers).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.signIn })).toBeEnabled();
  });

  it('prevents an SSO navigation while password sign-in is pending', async () => {
    const pending = deferred<AuthResult>();
    const client = fixture();
    client.providers.mockResolvedValue([{ id: 'corporate', label: 'Corporate' }]);
    client.login.mockReturnValue(pending.promise);
    const { user } = show({}, client);
    const link = await screen.findByRole('link', { name: `${copy.oidc} Corporate` });
    await user.type(screen.getByLabelText(copy.login, { exact: false }), 'member');
    await user.type(screen.getByLabelText(copy.password, { exact: false }), 'password');
    await user.click(screen.getByRole('button', { name: copy.signIn }));
    expect(link).toHaveAttribute('aria-disabled', 'true');
    expect(fireEvent.click(link)).toBe(false);
    await act(async () => {
      pending.resolve({ kind: 'authenticated' });
      await pending.promise;
    });
  });

  it.each(['fr', 'en', 'ar'])(
    'provides accessible labels and error feedback in %s',
    async (language) => {
      const labels = copyFor(language);
      const client = fixture();
      client.login.mockRejectedValue(new AuthError('invalid_credentials', 'fr'));
      const { user, container } = show({ language }, client);
      await user.type(screen.getByLabelText(labels.login, { exact: false }), 'member');
      await user.type(screen.getByLabelText(labels.password, { exact: false }), 'password');
      await user.click(screen.getByRole('button', { name: labels.signIn }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        new AuthError('invalid_credentials', language).message,
      );
      expect(await accessibilityViolations(container)).toEqual([]);
    },
  );
});
