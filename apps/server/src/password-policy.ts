// SPDX-License-Identifier: LGPL-3.0-only
//
// Password policy (lot 2.2): a minimum length and nothing else that is arbitrary (no
// "one capital, one digit" rules), the password is not the login, and — unless the
// administrator turned it off — it must not appear in a known data breach. The breach check
// uses the k-anonymity range API of Have I Been Pwned: only the first 5 hex characters of the
// SHA-1 of the password leave the server, never the password nor its full hash.
import { createHash } from 'node:crypto';

export const MIN_PASSWORD_LENGTH = 12;

export interface PasswordPolicy {
  /** Minimum length in characters (Unicode code points). */
  readonly minLength: number;
  /** Looks a password up in known breaches; undefined turns the check off. */
  readonly breachCheck?: BreachCheck | undefined;
}

/** How many times a password was seen in breaches (0 when unknown or when the check failed). */
export type BreachCheck = (password: string) => Promise<number>;

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = Object.freeze({
  minLength: MIN_PASSWORD_LENGTH,
});

/** The reason a password is refused, in words the user can act on; undefined when accepted. */
export async function passwordProblem(
  password: string,
  policy: PasswordPolicy,
  login: string,
): Promise<string | undefined> {
  if (Array.from(password).length < policy.minLength) {
    return `The password must have at least ${String(policy.minLength)} characters.`;
  }
  if (password.toLowerCase() === login.toLowerCase()) {
    return 'The password must differ from the login.';
  }
  if (policy.breachCheck && (await policy.breachCheck(password)) > 0) {
    return 'This password appears in a known data breach: choose another one.';
  }
  return undefined;
}

export interface BreachCheckOptions {
  /** Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch | undefined;
  /** Range API (default `https://api.pwnedpasswords.com/range/`). */
  readonly url?: string | undefined;
  readonly timeoutMs?: number | undefined;
  /** Called when the service cannot be reached; the password is then accepted. */
  readonly onError?: ((error: unknown) => void) | undefined;
}

/**
 * The Have I Been Pwned range API as a {@link BreachCheck}. When the service is down the
 * check fails open (returns 0 and reports the error): an outage must not stop users from
 * signing up, and the length rule still applies.
 */
export function pwnedPasswords(options: BreachCheckOptions = {}): BreachCheck {
  const request = options.fetch ?? fetch;
  const base = options.url ?? 'https://api.pwnedpasswords.com/range/';
  return async (password) => {
    const hash = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    try {
      const response = await request(`${base}${prefix}`, {
        // Padded answers hide how many hashes really share the prefix.
        headers: { 'add-padding': 'true', 'user-agent': 'socle-erp' },
        signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
      });
      if (!response.ok) throw new Error(`Breach service answered ${String(response.status)}.`);
      for (const line of (await response.text()).split('\n')) {
        const [candidate, count] = line.trim().split(':');
        if (candidate === suffix) return Number(count) || 0;
      }
      return 0;
    } catch (error) {
      options.onError?.(error);
      return 0;
    }
  };
}
