// SPDX-License-Identifier: LGPL-3.0-only
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  base32Decode,
  base32Encode,
  hotp,
  newTotpSecret,
  otpauthUri,
  totpStep,
  verifyTotp,
} from './totp.js';

// RFC 6238 appendix B, SHA-1 secret "12345678901234567890"; the 8-digit codes of the RFC end
// with the 6-digit ones checked here.
const RFC_SECRET = new TextEncoder().encode('12345678901234567890');
const RFC_VECTORS: readonly [number, string, string][] = [
  [59, '94287082', '287082'],
  [1111111109, '07081804', '081804'],
  [1111111111, '14050471', '050471'],
  [1234567890, '89005924', '005924'],
  [2000000000, '69279037', '279037'],
  [20000000000, '65353130', '353130'],
];

describe('TOTP', () => {
  it('matches the RFC 6238 test vectors', () => {
    for (const [seconds, eight, six] of RFC_VECTORS) {
      const step = Math.floor(seconds / 30);
      expect(hotp(RFC_SECRET, step, 8), String(seconds)).toBe(eight);
      expect(hotp(RFC_SECRET, step), String(seconds)).toBe(six);
      expect(totpStep(new Date(seconds * 1000))).toBe(step);
    }
  });

  it('accepts the current step and one step of drift, not two', () => {
    const now = new Date(1_700_000_000_000);
    const step = totpStep(now);
    for (const drift of [-1, 0, 1]) {
      expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + drift), now)).toBe(step + drift);
    }
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 2), now)).toBeUndefined();
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 2), now)).toBeUndefined();
  });

  it('never accepts a step twice, nor an older one', () => {
    const now = new Date(1_700_000_000_000);
    const step = totpStep(now);
    const code = hotp(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, code, now, step - 1)).toBe(step);
    expect(verifyTotp(RFC_SECRET, code, now, step)).toBeUndefined();
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), now, step)).toBeUndefined();
  });

  it('rejects anything that is not six digits', () => {
    const now = new Date(1_700_000_000_000);
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 456', '１２３４５６']) {
      expect(verifyTotp(RFC_SECRET, bad, now), bad).toBeUndefined();
    }
  });

  it('round-trips base32 and refuses other characters', () => {
    expect(base32Encode(new TextEncoder().encode('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('mzxw 6ytb oi====')).toEqual(new TextEncoder().encode('foobar'));
    expect(base32Decode('MZXW1')).toBeUndefined();
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (data) => {
        expect(base32Decode(base32Encode(data))).toEqual(data);
      }),
    );
  });

  it('builds the otpauth URI an authenticator reads', () => {
    const secret = newTotpSecret();
    expect(secret).toHaveLength(20);
    expect(secret).not.toEqual(newTotpSecret());
    const uri = new URL(otpauthUri(secret, 'Socle ERP', 'alice@acme.test'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/Socle ERP:alice@acme.test');
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      secret: base32Encode(secret),
      issuer: 'Socle ERP',
      algorithm: 'SHA1',
      digits: '6',
      period: '30',
    });
  });
});
