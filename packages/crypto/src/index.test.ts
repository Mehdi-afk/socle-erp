// SPDX-License-Identifier: LGPL-3.0-only
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  bytesEqual,
  canonicalJson,
  exportPrivateKey,
  exportPublicKey,
  fromBase64Url,
  fromUtf8,
  generateSigningKeyPair,
  importPrivateKey,
  importPublicKey,
  randomBytes,
  sha256,
  sign,
  toBase64Url,
  utf8,
  verify,
} from './index.js';

describe('base64url', () => {
  it.each([
    ['', ''],
    ['f', 'Zg'],
    ['fo', 'Zm8'],
    ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg'],
    ['fooba', 'Zm9vYmE'],
    ['foobar', 'Zm9vYmFy'],
  ])('encodes the RFC 4648 vector %j', (plain, encoded) => {
    expect(toBase64Url(utf8(plain))).toBe(encoded);
    expect(fromUtf8(fromBase64Url(encoded))).toBe(plain);
  });

  it('uses the URL-safe alphabet', () => {
    expect(toBase64Url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
  });

  it('round-trips any bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
        expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
      }),
    );
  });

  it.each(['Zg==', 'Z g', 'Zm9v+', 'Z', 'Zh'])('rejects invalid or non-canonical %j', (text) => {
    expect(() => fromBase64Url(text)).toThrow();
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every level and drops undefined properties', () => {
    expect(canonicalJson({ b: 1, a: { d: [true, null], c: 'x' }, z: undefined })).toBe(
      '{"a":{"c":"x","d":[true,null]},"b":1}',
    );
  });

  it('is independent of property insertion order', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.integer()), (record) => {
        const reversed = Object.fromEntries(Object.entries(record).reverse());
        expect(canonicalJson(reversed)).toBe(canonicalJson(record));
      }),
    );
  });

  it.each([
    ['NaN', { n: Number.NaN }],
    ['Infinity', [Number.POSITIVE_INFINITY]],
    ['a Date', { d: new Date(0) }],
    ['undefined in an array', [undefined]],
  ])('rejects %s', (_case, value) => {
    expect(() => canonicalJson(value as never)).toThrow(TypeError);
  });

  it('rejects cycles', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic as never)).toThrow(TypeError);
  });
});

describe('sha256', () => {
  it('matches the FIPS 180-2 "abc" vector', async () => {
    expect(await sha256(utf8('abc'))).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
  });
});

describe('Ed25519', () => {
  it('signs and verifies', async () => {
    const { publicKey, privateKey } = await generateSigningKeyPair();
    const signature = await sign(privateKey, utf8('payload'));
    expect(await verify(publicKey, signature, utf8('payload'))).toBe(true);
  });

  it('rejects tampered data, another key and malformed signatures', async () => {
    const a = await generateSigningKeyPair();
    const b = await generateSigningKeyPair();
    const signature = await sign(a.privateKey, utf8('payload'));
    expect(await verify(a.publicKey, signature, utf8('payload!'))).toBe(false);
    expect(await verify(b.publicKey, signature, utf8('payload'))).toBe(false);
    expect(await verify(a.publicKey, 'not base64!', utf8('payload'))).toBe(false);
    expect(await verify(a.publicKey, signature.slice(0, 40), utf8('payload'))).toBe(false);
  });

  it('round-trips public and private keys', async () => {
    const pair = await generateSigningKeyPair({ extractable: true });
    const publicKey = await importPublicKey(await exportPublicKey(pair.publicKey));
    const privateKey = await importPrivateKey(await exportPrivateKey(pair.privateKey));
    const signature = await sign(privateKey, utf8('x'));
    expect(await verify(publicKey, signature, utf8('x'))).toBe(true);
    expect(fromBase64Url(await exportPublicKey(publicKey))).toHaveLength(32);
  });

  it('refuses to export a non-extractable private key', async () => {
    const pair = await generateSigningKeyPair();
    await expect(exportPrivateKey(pair.privateKey)).rejects.toThrow();
  });

  it('refuses a forged key object', async () => {
    const forged = { kind: 'ed25519-private' } as const;
    await expect(sign(forged, utf8('x'))).rejects.toThrow(TypeError);
  });

  it('rejects a public key of the wrong size', async () => {
    await expect(importPublicKey(toBase64Url(new Uint8Array(31)))).rejects.toThrow();
  });
});

describe('helpers', () => {
  it('compares bytes', () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });

  it('produces random bytes', () => {
    expect(randomBytes(16)).toHaveLength(16);
    expect(toBase64Url(randomBytes(16))).not.toBe(toBase64Url(randomBytes(16)));
  });

  it('rejects invalid UTF-8', () => {
    expect(() => fromUtf8(new Uint8Array([0xff]))).toThrow();
  });
});
