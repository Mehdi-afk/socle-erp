// SPDX-License-Identifier: LGPL-3.0-only
import { z } from 'zod';

const base64url = z
  .string()
  .min(1)
  .max(20_000)
  .regex(/^[A-Za-z0-9_-]+$/);
const credentialId = base64url.max(1024);
const transport = z.enum(['usb', 'nfc', 'ble', 'smart-card', 'hybrid', 'internal']);

// Only options emitted by the current MFA route are accepted. No extensions are requested.
export const passkeyOptionsSchema = z.strictObject({
  challenge: base64url.max(1024),
  rpId: z.string().min(1).max(253),
  timeout: z.number().int().positive().max(300_000),
  userVerification: z.literal('required'),
  allowCredentials: z
    .array(
      z.strictObject({
        id: credentialId,
        type: z.literal('public-key'),
        transports: z.array(transport).max(8).optional(),
      }),
    )
    .min(1)
    .max(20),
});

const assertionSchema = z
  .strictObject({
    id: credentialId,
    rawId: credentialId,
    type: z.literal('public-key'),
    authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
    response: z.strictObject({
      clientDataJSON: base64url,
      authenticatorData: base64url,
      signature: base64url,
      userHandle: z
        .string()
        .max(1024)
        .regex(/^[A-Za-z0-9_-]*$/)
        .nullish(),
    }),
    clientExtensionResults: z.strictObject({}),
  })
  .refine((value) => value.id === value.rawId);

export class PasskeyFailure extends Error {
  readonly code: 'browser_unsupported' | 'cancelled' | 'invalid_response' | 'unavailable';

  constructor(code: PasskeyFailure['code']) {
    super(code);
    this.code = code;
  }
}

/** Native JSON conversion avoids custom binary conversions and additional dependencies. */
export async function requestPasskey(
  options: z.infer<typeof passkeyOptionsSchema>,
  signal: AbortSignal,
): Promise<z.infer<typeof assertionSchema>> {
  if (
    !globalThis.isSecureContext ||
    typeof PublicKeyCredential === 'undefined' ||
    typeof PublicKeyCredential.parseRequestOptionsFromJSON !== 'function' ||
    typeof PublicKeyCredential.prototype.toJSON !== 'function' ||
    typeof navigator === 'undefined' ||
    !('credentials' in navigator) ||
    typeof navigator.credentials.get !== 'function'
  )
    throw new PasskeyFailure('browser_unsupported');

  try {
    const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON({
      ...options,
      allowCredentials: options.allowCredentials.map(({ id, type, transports }) => ({
        id,
        type,
        ...(transports === undefined ? {} : { transports }),
      })),
    });
    const credential = await navigator.credentials.get({ publicKey, signal });
    if (signal.aborted) throw new PasskeyFailure('cancelled');
    if (!credential) throw new PasskeyFailure('cancelled');
    if (!(credential instanceof PublicKeyCredential)) throw new PasskeyFailure('invalid_response');
    const result = assertionSchema.safeParse(credential.toJSON());
    if (!result.success) throw new PasskeyFailure('invalid_response');
    return result.data;
  } catch (caught) {
    if (caught instanceof PasskeyFailure) throw caught;
    if (caught instanceof DOMException && ['NotAllowedError', 'AbortError'].includes(caught.name))
      throw new PasskeyFailure('cancelled');
    throw new PasskeyFailure('unavailable');
  }
}
