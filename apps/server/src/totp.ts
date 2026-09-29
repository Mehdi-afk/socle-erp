// SPDX-License-Identifier: LGPL-3.0-only
//
// Time-based one-time passwords (RFC 6238, over RFC 4226 HOTP with HMAC-SHA1, the algorithm every
// authenticator app supports): 6 digits, 30-second steps. Pure functions: the clock and the last
// accepted step are arguments. A code is accepted one step before or after the current one
// (clock drift) and never twice (the caller stores the step returned).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

/** RFC 4648 base32, without padding. */
export function base32Encode(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET.charAt((value << (5 - bits)) & 31);
  return out;
}

/** Decodes base32 (case, spaces and padding ignored); undefined for any other character. */
export function base32Decode(text: string): Uint8Array | undefined {
  const clean = text.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) return undefined;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** A new random secret: 160 bits, the size RFC 4226 recommends. */
export function newTotpSecret(): Uint8Array {
  return Uint8Array.from(randomBytes(20));
}

/** The code of time step `step` (RFC 4226 dynamic truncation). */
export function hotp(secret: Uint8Array, step: number, digits = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = (mac[mac.length - 1] as number) & 15;
  const binary =
    (((mac[offset] as number) & 0x7f) << 24) |
    ((mac[offset + 1] as number) << 16) |
    ((mac[offset + 2] as number) << 8) |
    (mac[offset + 3] as number);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The time step of an instant. */
export const totpStep = (now: Date): number => Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);

/**
 * The step `code` matches (current one, or one before or after), or undefined. A step not above
 * `lastStep` is refused: a code already used, or older, never works again.
 */
export function verifyTotp(
  secret: Uint8Array,
  code: string,
  now: Date,
  lastStep = 0,
): number | undefined {
  if (!/^\d{6}$/.test(code)) return undefined;
  const given = Buffer.from(code);
  const current = totpStep(now);
  let matched: number | undefined;
  // Every candidate is compared, so the time taken does not tell which step matched.
  for (const step of [current - 1, current, current + 1]) {
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(given, expected) && step > lastStep) matched = step;
  }
  return matched;
}

/** The `otpauth://` URI an authenticator app reads from a QR code. */
export function otpauthUri(secret: Uint8Array, issuer: string, account: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
