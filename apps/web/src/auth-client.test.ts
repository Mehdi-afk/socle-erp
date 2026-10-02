// SPDX-License-Identifier: LGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AuthError,
  createAuthClient,
  oidcStartPath,
  parseAuthCallback,
  type AuthAnswer,
  type AuthClient,
} from './auth-client.js';
import * as native from './passkey.js';

const challenge = 'c'.repeat(43);
const csrfToken = 's'.repeat(43);
const ceremony = 'p'.repeat(43);
const secret = 'A'.repeat(32);
const uri = `otpauth://totp/Socle%3Auser?secret=${secret}&issuer=Socle&algorithm=SHA1&digits=6&period=30`;
const session = { ok: true, csrfToken };
const codes = Array.from('ABCDEFGHIJ', (char) => `${char}AAA-AAAA-AAAA-AAAA`);
const assertion = {
  id: 'aWQ',
  rawId: 'aWQ',
  type: 'public-key' as const,
  response: { clientDataJSON: 'YQ', authenticatorData: 'Yg', signature: 'Yw' },
  clientExtensionResults: {},
};
const passkeyOptions = {
  challenge,
  rpId: 'demo.socle.test',
  timeout: 60_000,
  userVerification: 'required',
  allowCredentials: [{ id: 'aWQ', type: 'public-key' }],
};
const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const failure = async (promise: Promise<unknown>): Promise<AuthError> => {
  try {
    await promise;
  } catch (caught) {
    expect(caught).toBeInstanceOf(AuthError);
    return caught as AuthError;
  }
  throw new Error('Expected AuthError');
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('authentication transport', () => {
  it('sends the exact password and exposes no CSRF token from the session response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(session));
    const client = createAuthClient({ fetch });
    await expect(client.login('user@example.test', ' password with spaces ')).resolves.toEqual({
      kind: 'authenticated',
    });
    const [path, init] = fetch.mock.calls[0] ?? [];
    expect(path).toBe('/auth/login');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      mode: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      body: JSON.stringify({ login: 'user@example.test', password: ' password with spaces ' }),
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get('x-csrf-token')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it.each(['verify', 'enroll'] as const)(
    'returns only the server-announced %s challenge',
    async (mfa) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          json({ ok: true, challenge, mfa, methods: ['totp', 'email', 'passkey'] }),
        );
      const client = createAuthClient({ fetch });
      await expect(client.login('user', 'password')).resolves.toEqual({
        kind: 'challenge',
        challenge,
        mfa,
        methods: ['totp', 'email', 'passkey'],
      });
      client.dispose();
    },
  );

  it.each([
    {},
    { ok: false },
    { ...session, csrfToken: 'short' },
    { ...session, secret: 'extra' },
    { ok: true, challenge, mfa: 'verify', methods: [] },
    { ok: true, challenge, mfa: 'verify', methods: ['sms'] },
    { ok: true, challenge, mfa: 'verify', methods: ['totp', 'totp'] },
    { ok: true, challenge, mfa: 'enroll', methods: ['recovery'] },
    { ok: true, challenge, mfa: 'verify', methods: ['totp'], csrfToken },
  ])('rejects malformed login responses without returning their contents: %j', async (payload) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(payload));
    const client = createAuthClient({ fetch });
    expect((await failure(client.login('user', 'password'))).code).toBe('invalid_response');
    client.dispose();
  });

  it.each([{ code: '012345' }, { recovery: 'AAAA-BBBB-CCCC-DDDD' }, { emailCode: '012345' }])(
    'verifies precisely one answer: %j',
    async (answer) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(session));
      const client = createAuthClient({ fetch });
      await expect(client.verify(challenge, answer)).resolves.toBeUndefined();
      expect(fetch).toHaveBeenCalledWith(
        '/auth/mfa/verify',
        expect.objectContaining({ body: JSON.stringify({ challenge, ...answer }) }),
      );
      client.dispose();
    },
  );

  it.each([
    {},
    { code: '12345' },
    { code: '1234567' },
    { code: '123456', recovery: 'AAAA-BBBB-CCCC-DDDD' },
    { emailCode: '123456', password: 'extra' },
  ])('rejects malformed factor input before fetch: %j', async (answer) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createAuthClient({ fetch });
    expect((await failure(client.verify(challenge, answer as AuthAnswer))).code).toBe('invalid');
    expect(fetch).not.toHaveBeenCalled();
    client.dispose();
  });

  it('does not retry a refused factor, but allows an explicit subsequent attempt', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ error: 'invalid_code', message: 'RAW SECRET' }, 401))
      .mockResolvedValueOnce(json(session));
    const client = createAuthClient({ fetch });
    const error = await failure(client.verify(challenge, { code: '123456' }));
    expect(error).toMatchObject({ code: 'invalid_code', status: 401 });
    expect(error.message).not.toContain('RAW SECRET');
    expect(fetch).toHaveBeenCalledTimes(1);
    await client.verify(challenge, { code: '654321' });
    expect(fetch).toHaveBeenCalledTimes(2);
    client.dispose();
  });

  it('sets up TOTP and returns the one-time recovery codes only after confirmation', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ secret, uri }))
      .mockResolvedValueOnce(json({ ...session, recoveryCodes: codes }));
    const client = createAuthClient({ fetch });
    await expect(client.setupTotp(challenge)).resolves.toEqual({ secret, uri });
    await expect(client.confirmTotp(challenge, '012345')).resolves.toEqual(codes);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      '/auth/mfa/totp/setup',
      '/auth/mfa/totp/confirm',
    ]);
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ challenge, code: '012345' }));
    client.dispose();
  });

  it.each([
    { secret, uri: 'https://example.test/' },
    { secret, uri: 'data:text/plain,invalid' },
    { secret, uri: 'otpauth://totp/user?secret=wrong' },
    { secret, uri: `${uri}&secret=${secret}` },
    { secret: 'INVALID', uri },
  ])('rejects invalid setup secrets/URIs', async (payload) => {
    const client = createAuthClient({
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(payload)),
    });
    expect((await failure(client.setupTotp(challenge))).code).toBe('invalid_response');
    client.dispose();
  });

  it.each([
    { recoveryCodes: codes.slice(1) },
    { recoveryCodes: Array<string>(10).fill(codes[0] ?? '') },
    { recoveryCodes: [...codes.slice(1), 'RAW SECRET'] },
  ])('refuses incomplete or duplicate recovery codes', async ({ recoveryCodes }) => {
    const client = createAuthClient({
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(json({ ...session, recoveryCodes })),
    });
    expect((await failure(client.confirmTotp(challenge, '012345'))).code).toBe('invalid_response');
    client.dispose();
  });

  it('uses distinct email enrollment, delivery and confirmation routes, then logs out', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ ok: true }))
      .mockResolvedValueOnce(json({ ok: true }))
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(json({ ok: true }));
    const client = createAuthClient({ fetch });
    await client.enableEmail(challenge);
    await client.sendEmail(challenge);
    await client.confirmEmail(challenge, '012345');
    await client.logout();
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      '/auth/mfa/email/enable',
      '/auth/mfa/email/send',
      '/auth/mfa/email/confirm',
      '/auth/logout',
    ]);
    expect(fetch.mock.calls[3]?.[1]?.body).toBe('{}');
    client.dispose();
  });

  it.each([
    [401, 'invalid_credentials', 'invalid_credentials'],
    [401, 'unknown', 'unauthenticated'],
    [403, 'csrf', 'csrf'],
    [403, 'forbidden', 'forbidden'],
    [409, 'mfa_enrolled', 'mfa_enrolled'],
    [409, 'email_unavailable', 'email_unavailable'],
    [409, 'email_not_enabled', 'email_not_enabled'],
    [400, 'validation', 'invalid'],
    [404, 'not_found', 'not_found'],
    [429, 'rate_limited', 'rate_limited'],
    [500, 'internal', 'unavailable'],
  ])('maps HTTP %i %s safely to %s', async (status, serverCode, code) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json({ error: serverCode, message: 'RAW SECRET' }, status));
    const client = createAuthClient({ fetch });
    const error = await failure(client.login('user', 'password'));
    expect(error).toMatchObject({ code, status });
    expect(error.message).not.toContain('RAW SECRET');
    expect(fetch).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it.each(['fr', 'en-GB', 'ar-DZ', 'unsupported'])(
    'localizes failures safely in %s',
    async (language) => {
      const client = createAuthClient({
        language,
        fetch: vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('RAW SECRET')),
      });
      const error = await failure(client.logout());
      expect(error).toMatchObject({ code: 'unavailable', status: undefined });
      expect(error.message).toBe(new AuthError('unavailable', language).message);
      expect(error.message).not.toContain('RAW SECRET');
      client.dispose();
    },
  );

  it.each([200, 502])('handles non-JSON HTTP %i without exposing HTML', async (status) => {
    const client = createAuthClient({
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response('<b>RAW SECRET</b>', { status })),
    });
    const error = await failure(client.logout());
    expect(error.code).toBe(status === 200 ? 'invalid_response' : 'unavailable');
    expect(error.message).not.toContain('RAW SECRET');
    client.dispose();
  });

  it('aborts an uncooperative fetch promptly and ignores its late session', async () => {
    const pending = deferred<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(pending.promise);
    const client = createAuthClient({ fetch });
    const result = failure(client.login('user', 'password'));
    client.dispose();
    expect((await result).code).toBe('disposed');
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    pending.resolve(json(session));
    expect((await failure(client.logout())).code).toBe('disposed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('aborts while JSON parsing is pending and rejects late payloads', async () => {
    const parsing = deferred<unknown>();
    const entered = deferred<undefined>();
    const response = json(session);
    vi.spyOn(response, 'json').mockImplementation(() => {
      entered.resolve(undefined);
      return parsing.promise;
    });
    const controller = new AbortController();
    const client = createAuthClient({
      signal: controller.signal,
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response),
    });
    const result = failure(client.login('user', 'password'));
    await entered.promise;
    controller.abort();
    expect((await result).code).toBe('disposed');
    parsing.resolve(session);
  });

  it('does not start requests when the supplied signal was already aborted', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createAuthClient({ fetch, signal: AbortSignal.abort() });
    expect((await failure(client.login('user', 'password'))).code).toBe('disposed');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    (client: AuthClient) => client.login('', 'password'),
    (client: AuthClient) => client.login('user', ''),
    (client: AuthClient) => client.setupTotp('invalid'),
    (client: AuthClient) => client.confirmTotp(challenge, '12345'),
    (client: AuthClient) => client.sendEmail('../outside'),
    (client: AuthClient) => client.confirmEmail(challenge, '12345'),
    (client: AuthClient) => client.passkey('bad'),
  ])('validates input before making a request', async (invoke) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createAuthClient({ fetch });
    expect((await failure(invoke(client))).code).toBe('invalid');
    expect(fetch).not.toHaveBeenCalled();
    client.dispose();
  });
});

describe('MFA passkey orchestration', () => {
  it('uses the announced ceremony and native assertion on the fixed MFA routes', async () => {
    const get = vi.spyOn(native, 'requestPasskey').mockResolvedValue(assertion);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ ceremony, options: passkeyOptions }))
      .mockResolvedValueOnce(json(session));
    const client = createAuthClient({ fetch });
    await expect(client.passkey(challenge)).resolves.toBeUndefined();
    expect(get).toHaveBeenCalledWith(passkeyOptions, expect.any(AbortSignal));
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      '/auth/mfa/passkey/options',
      '/auth/mfa/passkey/verify',
    ]);
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ challenge, ceremony, response: assertion }),
    );
    client.dispose();
  });

  it('never invokes the browser for malformed server options', async () => {
    const get = vi.spyOn(native, 'requestPasskey');
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        json({ ceremony, options: { ...passkeyOptions, userVerification: 'discouraged' } }),
      );
    const client = createAuthClient({ fetch });
    expect((await failure(client.passkey(challenge))).code).toBe('invalid_response');
    expect(get).not.toHaveBeenCalled();
    client.dispose();
  });

  it('reports a cancelled native prompt without posting an assertion', async () => {
    vi.spyOn(native, 'requestPasskey').mockRejectedValue(new native.PasskeyFailure('cancelled'));
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json({ ceremony, options: passkeyOptions }));
    const client = createAuthClient({ fetch });
    expect((await failure(client.passkey(challenge))).code).toBe('cancelled');
    expect(fetch).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it('discards a late native assertion after disposal', async () => {
    const pending = deferred<typeof assertion>();
    const entered = deferred<undefined>();
    vi.spyOn(native, 'requestPasskey').mockImplementation(() => {
      entered.resolve(undefined);
      return pending.promise;
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json({ ceremony, options: passkeyOptions }));
    const client = createAuthClient({ fetch });
    const result = failure(client.passkey(challenge));
    await entered.promise;
    client.dispose();
    expect((await result).code).toBe('disposed');
    pending.resolve(assertion);
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('OIDC discovery and callback', () => {
  it('returns configured providers and treats only HTTP 404 as absent configuration', async () => {
    const providers = [{ id: 'corporate-sso', label: 'Corporate' }];
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ providers }))
      .mockResolvedValueOnce(json({ error: 'not_found' }, 404))
      .mockResolvedValueOnce(json({ error: 'internal', message: 'RAW SECRET' }, 500));
    const client = createAuthClient({ fetch });
    await expect(client.providers()).resolves.toEqual(providers);
    await expect(client.providers()).resolves.toEqual([]);
    expect((await failure(client.providers())).code).toBe('unavailable');
    expect(fetch.mock.calls[0]?.[0]).toBe('/auth/oidc/providers');
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('GET');
    client.dispose();
  });

  it.each([
    { providers: [{ id: 'https://evil.test', label: 'Evil' }] },
    { providers: [{ id: 'corp', label: '' }] },
    { providers: [{ id: 'corp', label: 'Corp', clientSecret: 'RAW SECRET' }] },
    {
      providers: [
        { id: 'corp', label: 'Corp' },
        { id: 'corp', label: 'Again' },
      ],
    },
  ])('rejects unsafe or duplicate provider configuration', async ({ providers }) => {
    const client = createAuthClient({
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ providers })),
    });
    expect((await failure(client.providers())).code).toBe('invalid_response');
    client.dispose();
  });

  it('builds only the local provider start path', () => {
    expect(oidcStartPath('corporate-sso')).toBe('/auth/oidc/corporate-sso/start');
  });
  it.each([
    '',
    '../logout',
    'a/b',
    '//evil.test',
    'https://evil.test',
    'a?x=y',
    'UPPER',
    'a'.repeat(32),
  ])('rejects provider path injection %s', (id) => {
    expect(() => oidcStartPath(id)).toThrow(AuthError);
  });

  it('accepts only a complete known callback and retains no CSRF field', () => {
    expect(
      parseAuthCallback(
        `#mfa=verify&methods=totp%2Crecovery%2Cemail%2Cpasskey&challenge=${challenge}`,
      ),
    ).toEqual({
      kind: 'challenge',
      mfa: 'verify',
      methods: ['totp', 'recovery', 'email', 'passkey'],
      challenge,
    });
    expect(parseAuthCallback('')).toBeUndefined();
    expect(parseAuthCallback('#')).toBeUndefined();
    expect(parseAuthCallback('#error=oidc_failed')).toEqual({ kind: 'failed' });
  });

  it.each([
    '#unrelated=1',
    '#error=unknown',
    '#error=oidc_failed&error=oidc_failed',
    `#mfa=verify&methods=totp&challenge=${challenge}&redirect=https://evil.test`,
    `#mfa=verify&methods=sms&challenge=${challenge}`,
    `#mfa=verify&methods=totp,totp&challenge=${challenge}`,
    `#mfa=enroll&methods=recovery&challenge=${challenge}`,
    '#mfa=verify&methods=totp&challenge=short',
    '#mfa=verify&methods=totp',
    `#${'a'.repeat(1024)}`,
  ])('fails closed on invalid callback fragments: %s', (fragment) => {
    expect(parseAuthCallback(fragment)).toEqual({ kind: 'failed' });
  });
});
