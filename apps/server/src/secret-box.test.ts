// SPDX-License-Identifier: LGPL-3.0-only
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { open, seal } from './secret-box.js';

const key = Uint8Array.from(randomBytes(32));
const text = new TextEncoder().encode('JBSWY3DPEHPK3PXP');

describe('secret box', () => {
  it('round-trips, with a different nonce every time', () => {
    const [a, b] = [seal(key, text, 'alice'), seal(key, text, 'alice')];
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(open(key, a, 'alice')).toEqual(text);
    expect(a).not.toContain('JBSWY3DPEHPK3PXP');
  });

  it('refuses another context, another key, an altered value and garbage', () => {
    const sealed = seal(key, text, 'alice');
    expect(open(key, sealed, 'bob')).toBeUndefined();
    expect(open(Uint8Array.from(randomBytes(32)), sealed, 'alice')).toBeUndefined();
    const parts = sealed.split('.');
    parts[3] = `${parts[3]?.slice(0, -2) ?? ''}AA`;
    expect(open(key, parts.join('.'), 'alice')).toBeUndefined();
    // A shortened tag is refused, however it was cut.
    const short = [...parts];
    short[2] = (parts[2] as string).slice(0, 8);
    expect(open(key, short.join('.'), 'alice')).toBeUndefined();
    short[2] = '';
    expect(open(key, short.join('.'), 'alice')).toBeUndefined();
    for (const bad of ['', 'v1', 'v2.a.b.c', 'v1.a.b', 'v1...']) {
      expect(open(key, bad, 'alice'), bad).toBeUndefined();
    }
  });

  it('requires a 32-byte key', () => {
    expect(() => seal(new Uint8Array(16), text, 'x')).toThrow(RangeError);
    expect(() => open(new Uint8Array(31), 'v1.a.b.c', 'x')).toThrow(RangeError);
  });
});
