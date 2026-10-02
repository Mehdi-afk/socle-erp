// SPDX-License-Identifier: LGPL-3.0-only
import { z } from 'zod';

import { PasskeyFailure, passkeyOptionsSchema, requestPasskey } from './passkey.js';

/** Factors announced by the server for this challenge. @public */
export type AuthMethod = 'totp' | 'recovery' | 'email' | 'passkey';

/** Authentication completion or a short-lived MFA challenge; never a session token. @public */
export type AuthResult =
  | { readonly kind: 'authenticated' }
  | {
      readonly kind: 'challenge';
      readonly challenge: string;
      readonly mfa: 'verify' | 'enroll';
      readonly methods: readonly AuthMethod[];
    };

/** Exactly one second-factor answer. @public */
export type AuthAnswer =
  | { readonly code: string; readonly recovery?: never; readonly emailCode?: never }
  | { readonly recovery: string; readonly code?: never; readonly emailCode?: never }
  | { readonly emailCode: string; readonly code?: never; readonly recovery?: never };

/** Public identity provider configuration, containing no OAuth credentials. @public */
export interface AuthProvider {
  readonly id: string;
  readonly label: string;
}

/** Options shared by all requests of an authentication screen. @public */
export interface AuthClientOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly language?: string;
  readonly signal?: AbortSignal;
}

/** Same-origin authentication, without persistent secrets or automatic request retries. @public */
export interface AuthClient {
  login(login: string, password: string): Promise<AuthResult>;
  verify(challenge: string, answer: AuthAnswer): Promise<void>;
  setupTotp(challenge: string): Promise<{ readonly secret: string; readonly uri: string }>;
  confirmTotp(challenge: string, code: string): Promise<readonly string[]>;
  sendEmail(challenge: string): Promise<void>;
  enableEmail(challenge: string): Promise<void>;
  confirmEmail(challenge: string, code: string): Promise<void>;
  passkey(challenge: string): Promise<void>;
  providers(): Promise<readonly AuthProvider[]>;
  logout(): Promise<void>;
  /** Abort requests and the native authenticator, and refuse their late responses. */
  dispose(): void;
}

/** Stable safe error codes; invalid credentials or OTPs do not close the auth client. @public */
export type AuthErrorCode =
  | 'invalid_credentials'
  | 'invalid_code'
  | 'invalid'
  | 'unauthenticated'
  | 'forbidden'
  | 'csrf'
  | 'mfa_enrolled'
  | 'email_unavailable'
  | 'email_not_enabled'
  | 'not_found'
  | 'rate_limited'
  | 'unavailable'
  | 'invalid_response'
  | 'browser_unsupported'
  | 'cancelled'
  | 'disposed';

const messages: Readonly<Record<string, Readonly<Record<AuthErrorCode, string>>>> = {
  fr: {
    invalid_credentials: 'Identifiant ou mot de passe incorrect, ou connexion refusée.',
    invalid_code: 'Code incorrect ou expiré. Réessayez ou recommencez la connexion.',
    invalid: 'Vérifiez les informations saisies.',
    unauthenticated: 'Votre session a expiré. Reconnectez-vous.',
    forbidden: 'Cette opération n’est pas autorisée.',
    csrf: 'Votre session a changé. Reconnectez-vous.',
    mfa_enrolled: 'Une méthode de vérification est déjà configurée. Recommencez la connexion.',
    email_unavailable: 'L’envoi de codes par email est indisponible.',
    email_not_enabled: 'La vérification par email n’est pas activée pour ce compte.',
    not_found: 'Ce service de connexion est indisponible.',
    rate_limited: 'Trop de tentatives. Patientez avant de réessayer.',
    unavailable: 'Le serveur ne répond pas. Vérifiez votre connexion avant de réessayer.',
    invalid_response: 'La réponse du serveur est invalide. Recommencez la connexion.',
    browser_unsupported:
      'Ce navigateur ne prend pas en charge cette passkey. Utilisez un navigateur récent avec HTTPS.',
    cancelled: 'La vérification par passkey a été annulée ou a expiré.',
    disposed: 'Cette connexion est fermée. Recommencez la connexion.',
  },
  en: {
    invalid_credentials: 'Incorrect sign-in details or sign-in refused.',
    invalid_code: 'Incorrect or expired code. Try again or restart sign-in.',
    invalid: 'Check the information you entered.',
    unauthenticated: 'Your session has expired. Sign in again.',
    forbidden: 'This operation is not permitted.',
    csrf: 'Your session has changed. Sign in again.',
    mfa_enrolled: 'A verification method is already configured. Restart sign-in.',
    email_unavailable: 'Email verification codes are unavailable.',
    email_not_enabled: 'Email verification is not enabled for this account.',
    not_found: 'This sign-in service is unavailable.',
    rate_limited: 'Too many attempts. Wait before trying again.',
    unavailable: 'The server is not responding. Check your connection before trying again.',
    invalid_response: 'The server response is invalid. Restart sign-in.',
    browser_unsupported:
      'This browser does not support this passkey. Use a recent browser with HTTPS.',
    cancelled: 'Passkey verification was cancelled or timed out.',
    disposed: 'This connection is closed. Restart sign-in.',
  },
  ar: {
    invalid_credentials: 'بيانات الدخول غير صحيحة أو تم رفض الاتصال.',
    invalid_code: 'الرمز غير صحيح أو انتهت صلاحيته. حاول مجددًا أو أعد تسجيل الدخول.',
    invalid: 'تحقّق من البيانات المدخلة.',
    unauthenticated: 'انتهت جلستك. سجّل الدخول مجددًا.',
    forbidden: 'هذه العملية غير مسموحة.',
    csrf: 'تغيّرت جلستك. سجّل الدخول مجددًا.',
    mfa_enrolled: 'تم إعداد وسيلة تحقق مسبقًا. أعد تسجيل الدخول.',
    email_unavailable: 'إرسال رموز التحقق عبر البريد الإلكتروني غير متاح.',
    email_not_enabled: 'التحقق عبر البريد الإلكتروني غير مفعّل لهذا الحساب.',
    not_found: 'خدمة تسجيل الدخول هذه غير متاحة.',
    rate_limited: 'محاولات كثيرة جدًا. انتظر قبل المحاولة مجددًا.',
    unavailable: 'الخادم لا يستجيب. تحقّق من الاتصال قبل المحاولة مجددًا.',
    invalid_response: 'استجابة الخادم غير صالحة. أعد تسجيل الدخول.',
    browser_unsupported: 'هذا المتصفح لا يدعم مفتاح المرور هذا. استخدم متصفحًا حديثًا مع HTTPS.',
    cancelled: 'تم إلغاء التحقق بمفتاح المرور أو انتهت مهلته.',
    disposed: 'هذا الاتصال مغلق. أعد تسجيل الدخول.',
  },
};

/** Safe localized error without server messages, payloads or native exception details. @public */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly status: number | undefined;

  constructor(code: AuthErrorCode, language = 'fr', status?: number) {
    const key = language.toLowerCase().split('-')[0] ?? 'fr';
    super(messages[key]?.[code] ?? messages.fr?.[code] ?? code);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const otp = z.string().regex(/^\d{6}$/);
const method = z.enum(['totp', 'recovery', 'email', 'passkey']);
const methods = z
  .array(method)
  .min(1)
  .max(4)
  .refine((items) => new Set(items).size === items.length);
const challengeShape = { challenge: token, mfa: z.enum(['verify', 'enroll']), methods };
const challengeSchema = z
  .strictObject(challengeShape)
  .refine((value) => value.mfa !== 'enroll' || !value.methods.includes('recovery'));
const sessionSchema = z.strictObject({ ok: z.literal(true), csrfToken: token });
const loginResponse = z.union([
  sessionSchema,
  z
    .strictObject({ ok: z.literal(true), ...challengeShape })
    .refine((value) => value.mfa !== 'enroll' || !value.methods.includes('recovery')),
]);
const okSchema = z.strictObject({ ok: z.literal(true) });
const challengeBody = z.strictObject({ challenge: token });
const codeBody = z.strictObject({ challenge: token, code: otp });
const answerSchema = z.union([
  z.strictObject({ code: otp }),
  z.strictObject({ recovery: z.string().min(16).max(30) }),
  z.strictObject({ emailCode: otp }),
]);
const providerId = z.string().regex(/^[a-z][a-z0-9-]{0,30}$/);
const providersSchema = z
  .strictObject({
    providers: z
      .array(z.strictObject({ id: providerId, label: z.string().min(1).max(200) }))
      .max(100),
  })
  .refine(
    (value) => new Set(value.providers.map((item) => item.id)).size === value.providers.length,
  );
const setupSchema = z
  .strictObject({
    secret: z.string().regex(/^[A-Z2-7]{32}$/),
    uri: z.string().max(4096),
  })
  .refine(({ secret, uri }) => {
    try {
      const value = new URL(uri);
      return (
        value.protocol === 'otpauth:' &&
        value.hostname === 'totp' &&
        value.username === '' &&
        value.password === '' &&
        value.hash === '' &&
        value.searchParams.getAll('secret').length === 1 &&
        value.searchParams.get('secret') === secret
      );
    } catch {
      return false;
    }
  });
const recoverySchema = sessionSchema.extend({
  recoveryCodes: z
    .array(z.string().regex(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/))
    .length(10)
    .refine((codes) => new Set(codes).size === codes.length),
});
const failureSchema = z.object({ error: z.string().max(80) });

const httpCode = (status: number, body: unknown): AuthErrorCode => {
  const parsed = failureSchema.safeParse(body);
  const code = parsed.success ? parsed.data.error : '';
  if (status === 401) {
    if (code === 'invalid_credentials' || code === 'invalid_code') return code;
    return 'unauthenticated';
  }
  if (status === 403) return code === 'csrf' ? 'csrf' : 'forbidden';
  if (status === 409 && ['mfa_enrolled', 'email_unavailable', 'email_not_enabled'].includes(code))
    return code as 'mfa_enrolled' | 'email_unavailable' | 'email_not_enabled';
  if (status === 400 || status === 409 || status === 422) return 'invalid';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'unavailable';
};

/** Fixed local OIDC entry point; the caller must choose an ID from providers(). @public */
export function oidcStartPath(id: string): string {
  if (!providerId.safeParse(id).success) throw new AuthError('invalid');
  return `/auth/oidc/${id}/start`;
}

/**
 * Parses only the known OIDC callback fragment. The caller must immediately clear the URL,
 * even when parsing fails, and retain a challenge only in memory. No fragment means no callback.
 * @public
 */
export function parseAuthCallback(
  fragment: string,
): AuthResult | { readonly kind: 'failed' } | undefined {
  if (fragment === '' || fragment === '#') return undefined;
  if (fragment.length > 1024) return { kind: 'failed' };
  const params = new URLSearchParams(fragment.startsWith('#') ? fragment.slice(1) : fragment);
  const entries = [...params.entries()];
  if (entries.length === 1 && params.get('error') === 'oidc_failed') return { kind: 'failed' };
  if (
    entries.length !== 3 ||
    new Set(entries.map(([key]) => key)).size !== 3 ||
    entries.some(([key]) => !['mfa', 'methods', 'challenge'].includes(key))
  )
    return { kind: 'failed' };
  const parsed = challengeSchema.safeParse({
    mfa: params.get('mfa'),
    challenge: params.get('challenge'),
    methods: params.get('methods')?.split(','),
  });
  return parsed.success ? { kind: 'challenge', ...parsed.data } : { kind: 'failed' };
}

/** Opens an authentication transport. Session restoration belongs to connectWebClient(). @public */
export function createAuthClient(options: AuthClientOptions = {}): AuthClient {
  const { language = 'fr' } = options;
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const controller = new AbortController();
  let closed = false;
  const error = (code: AuthErrorCode, status?: number): AuthError =>
    new AuthError(code, language, status);
  const active = (): void => {
    if (closed) throw error('disposed');
  };
  const dispose = (): void => {
    if (closed) return;
    closed = true;
    options.signal?.removeEventListener('abort', dispose);
    controller.abort();
  };
  if (options.signal?.aborted) dispose();
  else options.signal?.addEventListener('abort', dispose, { once: true });
  const parse = <T>(schema: z.ZodType<T>, value: unknown, code: AuthErrorCode = 'invalid'): T => {
    active();
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw error(code);
    return parsed.data;
  };
  const run = async <T>(work: () => Promise<T>): Promise<T> => {
    active();
    let onAbort = (): void => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        reject(error('disposed'));
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const result = await Promise.race([work(), aborted]);
      active();
      return result;
    } catch (caught) {
      active();
      if (caught instanceof AuthError) throw caught;
      if (caught instanceof PasskeyFailure) throw error(caught.code);
      throw error('unavailable');
    } finally {
      controller.signal.removeEventListener('abort', onAbort);
    }
  };
  const request = async <T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> => {
    active();
    // Inputs are parsed before the first await; no caller-owned mutable object is retained.
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    return run(async () => {
      const response = await fetcher(path, {
        method: serialized === undefined ? 'GET' : 'POST',
        mode: 'same-origin',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
        headers:
          serialized === undefined
            ? { accept: 'application/json' }
            : {
                accept: 'application/json',
                'content-type': 'application/json',
              },
        ...(serialized === undefined ? {} : { body: serialized }),
      });
      active();
      let result: unknown;
      try {
        result = await response.json();
      } catch {
        if (response.ok) throw error('invalid_response', response.status);
      }
      active();
      if (!response.ok) throw error(httpCode(response.status, result), response.status);
      return parse(schema, result, 'invalid_response');
    });
  };
  const email = async (operation: 'send' | 'enable', challenge: string): Promise<void> => {
    await request(`/auth/mfa/email/${operation}`, okSchema, parse(challengeBody, { challenge }));
  };
  return {
    async login(login, password) {
      const body = parse(
        z.strictObject({
          login: z.string().min(1).max(254),
          password: z.string().min(1).max(1024),
        }),
        { login, password },
      );
      const result = await request('/auth/login', loginResponse, body);
      return 'mfa' in result
        ? {
            kind: 'challenge',
            challenge: result.challenge,
            mfa: result.mfa,
            methods: result.methods,
          }
        : { kind: 'authenticated' };
    },
    async verify(challenge, answer) {
      const body = { ...parse(challengeBody, { challenge }), ...parse(answerSchema, answer) };
      await request('/auth/mfa/verify', sessionSchema, body);
    },
    async setupTotp(challenge) {
      return request('/auth/mfa/totp/setup', setupSchema, parse(challengeBody, { challenge }));
    },
    async confirmTotp(challenge, code) {
      const response = await request(
        '/auth/mfa/totp/confirm',
        recoverySchema,
        parse(codeBody, { challenge, code }),
      );
      return response.recoveryCodes;
    },
    async sendEmail(challenge) {
      await email('send', challenge);
    },
    async enableEmail(challenge) {
      await email('enable', challenge);
    },
    async confirmEmail(challenge, code) {
      await request('/auth/mfa/email/confirm', sessionSchema, parse(codeBody, { challenge, code }));
    },
    async passkey(challenge) {
      const body = parse(challengeBody, { challenge });
      const ceremony = await request(
        '/auth/mfa/passkey/options',
        z.strictObject({ ceremony: token, options: passkeyOptionsSchema }),
        body,
      );
      const assertion = await run(() => requestPasskey(ceremony.options, controller.signal));
      active();
      await request('/auth/mfa/passkey/verify', sessionSchema, {
        ...body,
        ceremony: ceremony.ceremony,
        response: assertion,
      });
    },
    async providers() {
      try {
        return (await request('/auth/oidc/providers', providersSchema)).providers;
      } catch (caught) {
        if (caught instanceof AuthError && caught.code === 'not_found') return [];
        throw caught;
      }
    },
    async logout() {
      await request('/auth/logout', okSchema, {});
    },
    dispose,
  };
}
