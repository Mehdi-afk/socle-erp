// SPDX-License-Identifier: LGPL-3.0-only
//
// Minimal typed access to the Web APIs shared by Node >= 24, browsers and Web Workers.
// The package deliberately has no Node or DOM type dependency: only what is used is typed here.

/** Opaque WebCrypto key handle. */
export interface WebCryptoKey {
  readonly type: string;
  readonly extractable: boolean;
  readonly algorithm: { readonly name: string };
}

interface WebCryptoKeyPair {
  readonly publicKey: WebCryptoKey;
  readonly privateKey: WebCryptoKey;
}

type Algorithm = { readonly name: string };
type KeyUsage = 'sign' | 'verify';

interface SubtleCryptoLike {
  generateKey(
    algorithm: Algorithm,
    extractable: boolean,
    usages: KeyUsage[],
  ): Promise<WebCryptoKeyPair>;
  importKey(
    format: 'raw' | 'pkcs8',
    data: Uint8Array,
    algorithm: Algorithm,
    extractable: boolean,
    usages: KeyUsage[],
  ): Promise<WebCryptoKey>;
  exportKey(format: 'raw' | 'pkcs8', key: WebCryptoKey): Promise<ArrayBuffer>;
  sign(algorithm: Algorithm, key: WebCryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
  verify(
    algorithm: Algorithm,
    key: WebCryptoKey,
    signature: Uint8Array,
    data: Uint8Array,
  ): Promise<boolean>;
  digest(algorithm: Algorithm, data: Uint8Array): Promise<ArrayBuffer>;
}

interface Platform {
  readonly subtle: SubtleCryptoLike;
  getRandomValues(array: Uint8Array): Uint8Array;
  encodeUtf8(text: string): Uint8Array;
  decodeUtf8(bytes: Uint8Array): string;
}

interface Globals {
  crypto?: { subtle?: SubtleCryptoLike; getRandomValues?(array: Uint8Array): Uint8Array };
  TextEncoder?: new () => { encode(text: string): Uint8Array };
  TextDecoder?: new (
    label: string,
    options: { fatal: boolean },
  ) => {
    decode(bytes: Uint8Array): string;
  };
}

let cached: Platform | undefined;

/** Returns the Web platform APIs, or throws if the runtime does not provide them. */
export function platform(): Platform {
  if (cached) return cached;
  const g = globalThis as Globals;
  const webCrypto = g.crypto;
  const subtle = webCrypto?.subtle;
  const getRandomValues = webCrypto?.getRandomValues?.bind(webCrypto);
  if (!subtle || !getRandomValues || !g.TextEncoder || !g.TextDecoder) {
    throw new Error('@socle/crypto requires WebCrypto, TextEncoder and TextDecoder.');
  }
  const encoder = new g.TextEncoder();
  const decoder = new g.TextDecoder('utf-8', { fatal: true });
  cached = {
    subtle,
    getRandomValues,
    encodeUtf8: (text) => encoder.encode(text),
    decodeUtf8: (bytes) => decoder.decode(bytes),
  };
  return cached;
}
