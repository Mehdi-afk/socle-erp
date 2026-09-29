// SPDX-License-Identifier: LGPL-3.0-only
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PASSWORD_POLICY,
  passwordProblem,
  pwnedPasswords,
  type PasswordPolicy,
} from './password-policy.js';

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex').toUpperCase();

describe('password policy', () => {
  it('requires a length and nothing arbitrary', async () => {
    const check = (password: string) => passwordProblem(password, DEFAULT_PASSWORD_POLICY, 'a@b.c');
    expect(await check('short one')).toContain('at least 12');
    expect(await check('aaaaaaaaaaaa')).toBeUndefined(); // no composition rules
    expect(await check('correct horse battery')).toBeUndefined();
    // Length counts characters, not bytes: 12 Arabic letters are accepted.
    expect(await check('كلمةالسرالطويلة')).toBeUndefined();
    expect(await check('١٢٣٤٥٦٧٨٩٠')).toContain('at least 12');
    expect(
      await passwordProblem('User@Example.com', DEFAULT_PASSWORD_POLICY, 'user@example.com'),
    ).toBe('The password must differ from the login.');
  });

  it('refuses a password found in breaches, when the check is on', async () => {
    const policy: PasswordPolicy = { minLength: 12, breachCheck: () => Promise.resolve(3) };
    expect(await passwordProblem('correct horse battery', policy, 'x')).toContain('data breach');
    const off: PasswordPolicy = { minLength: 12 };
    expect(await passwordProblem('correct horse battery', off, 'x')).toBeUndefined();
  });
});

describe('k-anonymity breach check', () => {
  const password = 'correct horse battery';
  const hash = sha1(password);

  it('sends only the first 5 characters of the hash and reads the count', async () => {
    const urls: string[] = [];
    const fetched: typeof fetch = (input, init) => {
      urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      expect(new Headers(init?.headers).get('add-padding')).toBe('true');
      return Promise.resolve(
        new Response(`0018A45C4D1DEF81644B54AB7F969B88D65:0\r\n${hash.slice(5)}:42\r\nFFFF:7`),
      );
    };
    const check = pwnedPasswords({ fetch: fetched, url: 'https://pwned.test/range/' });
    expect(await check(password)).toBe(42);
    expect(urls).toEqual([`https://pwned.test/range/${hash.slice(0, 5)}`]);
    expect(urls[0]).not.toContain(hash.slice(5));
    expect(urls[0]).not.toContain(password);
  });

  it('ignores padding entries and unknown passwords', async () => {
    const padded: typeof fetch = () =>
      Promise.resolve(new Response(`${hash.slice(5)}:0\r\nABCDEF:9`));
    expect(await pwnedPasswords({ fetch: padded })(password)).toBe(0);
  });

  it('fails open and reports when the service is down', async () => {
    const errors: unknown[] = [];
    const down: typeof fetch = () => Promise.reject(new Error('offline'));
    const check = pwnedPasswords({ fetch: down, onError: (error) => errors.push(error) });
    expect(await check(password)).toBe(0);
    expect(errors).toHaveLength(1);
    const broken: typeof fetch = () => Promise.resolve(new Response('no', { status: 503 }));
    expect(await pwnedPasswords({ fetch: broken, onError: (e) => errors.push(e) })(password)).toBe(
      0,
    );
    expect(errors).toHaveLength(2);
  });
});
