// SPDX-License-Identifier: LGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';

import { passkeyOptionsSchema, requestPasskey } from './passkey.js';

const options = passkeyOptionsSchema.parse({
  challenge: 'c'.repeat(43),
  rpId: 'demo.socle.test',
  timeout: 60_000,
  userVerification: 'required',
  allowCredentials: [{ id: 'aWQ', type: 'public-key', transports: ['internal'] }],
});
const assertion = {
  id: 'aWQ',
  rawId: 'aWQ',
  type: 'public-key',
  authenticatorAttachment: 'platform',
  response: { clientDataJSON: 'YQ', authenticatorData: 'Yg', signature: 'Yw', userHandle: 'ZA' },
  clientExtensionResults: {},
};
const signal = (): AbortSignal => new AbortController().signal;
const install = (result: unknown = assertion) => {
  class NativeCredential {
    static parseRequestOptionsFromJSON = vi
      .fn<(value: PublicKeyCredentialRequestOptionsJSON) => PublicKeyCredentialRequestOptions>()
      .mockReturnValue({ challenge: Uint8Array.of(1, 2, 3) });
    toJSON(): unknown {
      return result;
    }
  }
  const get = vi
    .fn<(value: CredentialRequestOptions) => Promise<NativeCredential | null>>()
    .mockResolvedValue(new NativeCredential());
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('PublicKeyCredential', NativeCredential);
  vi.stubGlobal('navigator', { credentials: { get } });
  return { NativeCredential, get };
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('native WebAuthn adapter', () => {
  it('uses native JSON conversions and passes the cancellation signal', async () => {
    const { NativeCredential, get } = install();
    const abortSignal = signal();
    await expect(requestPasskey(options, abortSignal)).resolves.toEqual(assertion);
    expect(NativeCredential.parseRequestOptionsFromJSON).toHaveBeenCalledWith(options);
    expect(get).toHaveBeenCalledWith({
      publicKey: { challenge: Uint8Array.of(1, 2, 3) },
      signal: abortSignal,
    });
  });

  it.each(['insecure', 'missing-class', 'missing-parser', 'missing-json', 'missing-credentials'])(
    'reports unsupported environments before a prompt: %s',
    async (kind) => {
      const { NativeCredential, get } = install();
      if (kind === 'insecure') vi.stubGlobal('isSecureContext', false);
      if (kind === 'missing-class') vi.stubGlobal('PublicKeyCredential', undefined);
      if (kind === 'missing-parser')
        Object.defineProperty(NativeCredential, 'parseRequestOptionsFromJSON', {
          value: undefined,
        });
      if (kind === 'missing-json')
        Object.defineProperty(NativeCredential.prototype, 'toJSON', { value: undefined });
      if (kind === 'missing-credentials') vi.stubGlobal('navigator', {});
      await expect(requestPasskey(options, signal())).rejects.toMatchObject({
        code: 'browser_unsupported',
      });
      expect(get).not.toHaveBeenCalled();
    },
  );

  it.each(['NotAllowedError', 'AbortError', 'SecurityError'])(
    'maps %s without leaking native exception text',
    async (name) => {
      const { get } = install();
      get.mockRejectedValue(new DOMException('RAW SECRET', name));
      await expect(requestPasskey(options, signal())).rejects.toMatchObject({
        code: name === 'SecurityError' ? 'unavailable' : 'cancelled',
      });
      await expect(requestPasskey(options, signal())).rejects.not.toThrow('RAW SECRET');
    },
  );

  it('treats an empty selection as cancellation', async () => {
    const { get } = install();
    get.mockResolvedValue(null);
    await expect(requestPasskey(options, signal())).rejects.toMatchObject({ code: 'cancelled' });
  });

  it.each([
    { ...assertion, id: 'different' },
    { ...assertion, type: 'password' },
    { ...assertion, response: { ...assertion.response, signature: 'not base64!' } },
    { ...assertion, clientExtensionResults: { unexpected: 'secret' } },
    { ...assertion, injected: true },
  ])('rejects malformed native JSON before it can reach the server', async (result) => {
    install(result);
    await expect(requestPasskey(options, signal())).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('rejects a non-public-key credential', async () => {
    const { get } = install();
    get.mockResolvedValue({ toJSON: () => assertion });
    await expect(requestPasskey(options, signal())).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('does not return a credential if its prompt resolves after cancellation', async () => {
    const { get, NativeCredential } = install();
    const controller = new AbortController();
    get.mockImplementation(() => {
      controller.abort();
      return Promise.resolve(new NativeCredential());
    });
    await expect(requestPasskey(options, controller.signal)).rejects.toMatchObject({
      code: 'cancelled',
    });
  });
});
