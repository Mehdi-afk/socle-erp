// SPDX-License-Identifier: LGPL-3.0-only
import { platform } from './platform.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOOKUP = new Map<string, number>(ALPHABET.split('').map((char, index) => [char, index]));

/**
 * Encodes bytes as unpadded base64url (RFC 4648 §5).
 * @public
 */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += ALPHABET.charAt(n >> 18) + ALPHABET.charAt((n >> 12) & 63);
    out += ALPHABET.charAt((n >> 6) & 63) + ALPHABET.charAt(n & 63);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16;
    out += ALPHABET.charAt(n >> 18) + ALPHABET.charAt((n >> 12) & 63);
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += ALPHABET.charAt(n >> 18) + ALPHABET.charAt((n >> 12) & 63);
    out += ALPHABET.charAt((n >> 6) & 63);
  }
  return out;
}

/**
 * Decodes unpadded base64url. Rejects any other character, padding, or a non-canonical tail.
 * @public
 */
export function fromBase64Url(text: string): Uint8Array {
  if (text.length % 4 === 1) throw new Error('Invalid base64url length.');
  const values: number[] = [];
  for (const char of text) {
    const value = LOOKUP.get(char);
    if (value === undefined) throw new Error('Invalid base64url character.');
    values.push(value);
  }
  const bytes = new Uint8Array(Math.floor((values.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const value of values) {
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (buffer >> bits) & 0xff;
    }
  }
  // Leftover bits must be zero, otherwise two strings would decode to the same bytes.
  if ((buffer & ((1 << bits) - 1)) !== 0) throw new Error('Non-canonical base64url.');
  return bytes;
}

/**
 * UTF-8 encoding helpers.
 * @public
 */
export function utf8(text: string): Uint8Array {
  return platform().encodeUtf8(text);
}

/**
 * Strict UTF-8 decoding (invalid sequences throw).
 * @public
 */
export function fromUtf8(bytes: Uint8Array): string {
  return platform().decodeUtf8(bytes);
}

/**
 * Constant-time comparison of two byte arrays of the same length.
 * @public
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
