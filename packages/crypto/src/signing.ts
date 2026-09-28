// SPDX-License-Identifier: LGPL-3.0-only
import { fromBase64Url, toBase64Url } from './encoding.js';
import { platform, type WebCryptoKey } from './platform.js';

const ED25519 = { name: 'Ed25519' } as const;
const SHA256 = { name: 'SHA-256' } as const;

/**
 * An opaque Ed25519 public key (raw 32 bytes, base64url-encoded in transport).
 * @public
 */
export interface SigningPublicKey {
  readonly kind: 'ed25519-public';
}

/**
 * An opaque Ed25519 private key. Non-extractable unless generated with `extractable: true`.
 * @public
 */
export interface SigningPrivateKey {
  readonly kind: 'ed25519-private';
}

// The WebCrypto handles never leave this module: key objects are opaque tokens, so they
// cannot be forged or inspected from outside.
const handles = new WeakMap<SigningPublicKey | SigningPrivateKey, WebCryptoKey>();

function wrapPublic(handle: WebCryptoKey): SigningPublicKey {
  const key: SigningPublicKey = Object.freeze({ kind: 'ed25519-public' });
  handles.set(key, handle);
  return key;
}

function wrapPrivate(handle: WebCryptoKey): SigningPrivateKey {
  const key: SigningPrivateKey = Object.freeze({ kind: 'ed25519-private' });
  handles.set(key, handle);
  return key;
}

function unwrap(key: SigningPublicKey | SigningPrivateKey): WebCryptoKey {
  const handle = handles.get(key);
  if (!handle) throw new TypeError('Unknown key: keys must come from @socle/crypto.');
  return handle;
}

/** @public */
export interface SigningKeyPair {
  readonly publicKey: SigningPublicKey;
  readonly privateKey: SigningPrivateKey;
}

/**
 * Generates an Ed25519 key pair. Keep `extractable` false (default) unless the private key
 * must be exported (e.g. offline storage of a signing key by a tool).
 * @public
 */
export async function generateSigningKeyPair(
  options: { extractable?: boolean } = {},
): Promise<SigningKeyPair> {
  const pair = await platform().subtle.generateKey(ED25519, options.extractable ?? false, [
    'sign',
    'verify',
  ]);
  return {
    publicKey: wrapPublic(pair.publicKey),
    privateKey: wrapPrivate(pair.privateKey),
  };
}

/**
 * Exports a public key as base64url (raw 32 bytes).
 * @public
 */
export async function exportPublicKey(key: SigningPublicKey): Promise<string> {
  return toBase64Url(new Uint8Array(await platform().subtle.exportKey('raw', unwrap(key))));
}

/**
 * Imports a base64url public key.
 * @throws when the key is malformed.
 * @public
 */
export async function importPublicKey(encoded: string): Promise<SigningPublicKey> {
  const raw = fromBase64Url(encoded);
  if (raw.length !== 32) throw new Error('Ed25519 public key must be 32 bytes.');
  const handle = await platform().subtle.importKey('raw', raw, ED25519, true, ['verify']);
  return wrapPublic(handle);
}

/**
 * Exports an extractable private key as base64url PKCS#8. Never log or persist it in clear.
 * @public
 */
export async function exportPrivateKey(key: SigningPrivateKey): Promise<string> {
  return toBase64Url(new Uint8Array(await platform().subtle.exportKey('pkcs8', unwrap(key))));
}

/**
 * Imports a base64url PKCS#8 private key as a non-extractable key.
 * @public
 */
export async function importPrivateKey(encoded: string): Promise<SigningPrivateKey> {
  const handle = await platform().subtle.importKey(
    'pkcs8',
    fromBase64Url(encoded),
    ED25519,
    false,
    ['sign'],
  );
  return wrapPrivate(handle);
}

/**
 * Signs bytes with Ed25519; returns the base64url signature (64 bytes).
 * @public
 */
export async function sign(key: SigningPrivateKey, data: Uint8Array): Promise<string> {
  return toBase64Url(new Uint8Array(await platform().subtle.sign(ED25519, unwrap(key), data)));
}

/**
 * Verifies an Ed25519 signature. Returns false (never throws) for a malformed signature.
 * @public
 */
export async function verify(
  key: SigningPublicKey,
  signature: string,
  data: Uint8Array,
): Promise<boolean> {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(signature);
  } catch {
    return false;
  }
  if (bytes.length !== 64) return false;
  return platform().subtle.verify(ED25519, unwrap(key), bytes, data);
}

/**
 * SHA-256 digest, base64url-encoded.
 * @public
 */
export async function sha256(data: Uint8Array): Promise<string> {
  return toBase64Url(new Uint8Array(await platform().subtle.digest(SHA256, data)));
}

/**
 * Cryptographically secure random bytes.
 * @public
 */
export function randomBytes(length: number): Uint8Array {
  return platform().getRandomValues(new Uint8Array(length));
}
