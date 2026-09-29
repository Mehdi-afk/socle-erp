// SPDX-License-Identifier: LGPL-3.0-only
//
// Encryption of small secrets at rest (the TOTP secrets): AES-256-GCM with a random 96-bit
// nonce per value, the key held by the server configuration and never in the database. A leaked
// database alone does not give the secrets; a value cannot be moved to another purpose or user
// because `context` (e.g. the user id) is authenticated with it.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

/** True for a usable key: exactly 32 bytes. */
export const isSecretKey = (key: Uint8Array): boolean => key.length === 32;

/** `v1.<nonce>.<tag>.<ciphertext>` (base64url). */
export function seal(key: Uint8Array, plaintext: Uint8Array, context: string): string {
  if (!isSecretKey(key)) throw new RangeError('The encryption key must be 32 bytes.');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [
    VERSION,
    nonce.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    body.toString('base64url'),
  ].join('.');
}

/**
 * The plaintext of a sealed value, or undefined when it was altered, sealed for another
 * context or with another key.
 */
export function open(key: Uint8Array, sealed: string, context: string): Uint8Array | undefined {
  if (!isSecretKey(key)) throw new RangeError('The encryption key must be 32 bytes.');
  const [version, nonce, tag, body] = sealed.split('.');
  if (version !== VERSION || !nonce || !tag || body === undefined) return undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Uint8Array.from(
      Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]),
    );
  } catch {
    return undefined;
  }
}
