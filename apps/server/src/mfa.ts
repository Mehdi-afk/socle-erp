// SPDX-License-Identifier: LGPL-3.0-only
//
// Second factor by authenticator app (lot 2.2c). Sign-in has two steps: the password is checked
// first; if the account has a second factor (or must have one), no session exists yet, only a
// short-lived, attempt-limited challenge; the session opens once the code is right. An account
// of a group that requires MFA and has none is sent to enrolment with the same kind of
// challenge, so it never holds a session without a second factor. The TOTP secret is stored
// encrypted, the recovery codes (80 random bits each) as hashes, each usable once.
import { createHash, randomBytes } from 'node:crypto';

import { effectiveGroups, type SecurityPolicy, type UserContext } from '@socle/framework';
import { AUTH_TABLES, type Executor } from '@socle/orm-pg';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';

import { loginOf, verifyPassword } from './auth.js';
import { HttpError } from './http-error.js';
import { emailEnabled, issueEmailCode, setEmailEnabled, verifyEmailCode } from './mfa-email.js';
import { open, seal } from './secret-box.js';
import type { TenantRuntime } from './tenants.js';
import { base32Encode, newTotpSecret, otpauthUri, verifyTotp } from './totp.js';

const T = AUTH_TABLES;
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export interface MfaOptions {
  /** 32-byte key that encrypts the TOTP secrets (from the server configuration). */
  readonly key: Uint8Array;
  /** Name shown in the authenticator app (default "Socle"). */
  readonly issuer?: string | undefined;
  /** Groups whose members must have a second factor (default `base.group_system`). */
  readonly requiredGroups?: readonly string[] | undefined;
  /**
   * Delivers a one-time code by email (lot 2.4 plugs the SMTP sending in). Without it the email
   * method is not offered.
   */
  readonly sendCode?:
    ((message: { login: string; code: string; host: string }) => Promise<void>) | undefined;
}

export const DEFAULT_MFA_GROUPS: readonly string[] = ['base.group_system'];
export const CHALLENGE_MS = 5 * 60_000;
export const CHALLENGE_ATTEMPTS = 5;
const RECOVERY_CODES = 10;

/** No second factor, a secret waiting for its first code, or fully set up. */
export type MfaState = 'none' | 'pending' | 'enrolled';

export async function mfaState(db: Executor, userId: string): Promise<MfaState> {
  const rows = await sql<{
    confirmed_at: Date | string | null;
  }>`select confirmed_at from ${sql.table(T.totp)} where user_id = ${userId}`.execute(db);
  const row = rows.rows[0];
  if (!row) return 'none';
  return row.confirmed_at === null ? 'pending' : 'enrolled';
}

/** The second factors a user has set up. */
export async function mfaMethods(
  db: Executor,
  userId: string,
): Promise<{ readonly totp: boolean; readonly email: boolean }> {
  return {
    totp: (await mfaState(db, userId)) === 'enrolled',
    email: await emailEnabled(db, userId),
  };
}

/** True when one of the user's groups (implied ones included) requires a second factor. */
export async function mfaRequired(
  db: Executor,
  security: SecurityPolicy,
  options: MfaOptions,
  userId: string,
): Promise<boolean> {
  const rows = await sql<{
    group_ids: string[];
  }>`select group_ids from ${sql.table(T.user)} where id = ${userId}`.execute(db);
  const groups = effectiveGroups(security, rows.rows[0]?.group_ids ?? []);
  return (options.requiredGroups ?? DEFAULT_MFA_GROUPS).some((group) => groups.has(group));
}

// ─── challenges ──────────────────────────────────────────────────────────────────────────

/** A single-purpose token that proves the password was right, valid 5 minutes. */
export async function createChallenge(
  db: Executor,
  userId: string,
  now: Date = new Date(),
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await sql`delete from ${sql.table(T.challenge)} where expires_at < ${now.toISOString()}::timestamptz or user_id = ${userId}`.execute(
    db,
  );
  await sql`insert into ${sql.table(T.challenge)} (token_hash, user_id, expires_at) values (${sha256(token)}, ${userId}, ${new Date(now.getTime() + CHALLENGE_MS).toISOString()}::timestamptz)`.execute(
    db,
  );
  return token;
}

/** The user of a challenge that is still valid and not exhausted. */
export async function challengeUser(
  db: Executor,
  token: string,
  now: Date = new Date(),
): Promise<string | undefined> {
  const rows = await sql<{
    user_id: string;
  }>`select user_id from ${sql.table(T.challenge)} where token_hash = ${sha256(token)} and expires_at > ${now.toISOString()}::timestamptz and attempts < ${CHALLENGE_ATTEMPTS}`.execute(
    db,
  );
  return rows.rows[0]?.user_id;
}

export async function failChallenge(db: Executor, token: string): Promise<void> {
  await sql`update ${sql.table(T.challenge)} set attempts = attempts + 1 where token_hash = ${sha256(token)}`.execute(
    db,
  );
}

export async function endChallenge(db: Executor, token: string): Promise<void> {
  await sql`delete from ${sql.table(T.challenge)} where token_hash = ${sha256(token)}`.execute(db);
}

// ─── enrolment ───────────────────────────────────────────────────────────────────────────

/**
 * Starts (or restarts) the enrolment: a new secret, not active until a code proves the app has
 * it. Undefined when the user already has a second factor.
 */
export async function startEnrollment(
  db: Executor,
  options: MfaOptions,
  userId: string,
): Promise<{ readonly secret: string; readonly uri: string } | undefined> {
  if ((await mfaState(db, userId)) === 'enrolled') return undefined;
  const secret = newTotpSecret();
  await sql`insert into ${sql.table(T.totp)} (user_id, secret_enc, confirmed_at, last_step) values (${userId}, ${seal(options.key, secret, userId)}, null, 0) on conflict (user_id) do update set secret_enc = excluded.secret_enc, last_step = 0 where ${sql.table(T.totp)}.confirmed_at is null`.execute(
    db,
  );
  return {
    secret: base32Encode(secret),
    uri: otpauthUri(secret, options.issuer ?? 'Socle', await loginOf(db, userId)),
  };
}

const RECOVERY_BYTES = 10;

/** The 10 recovery codes replacing all earlier ones; shown once, stored as hashes. */
export async function newRecoveryCodes(db: Executor, userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODES }, () => {
    const raw = base32Encode(randomBytes(RECOVERY_BYTES));
    return raw.match(/.{4}/g)?.join('-') ?? raw;
  });
  await sql`delete from ${sql.table(T.recovery)} where user_id = ${userId}`.execute(db);
  for (const code of codes) {
    await sql`insert into ${sql.table(T.recovery)} (code_hash, user_id) values (${sha256(normalizeRecovery(code))}, ${userId})`.execute(
      db,
    );
  }
  return codes;
}

/** Upper case, without dashes or spaces: how recovery codes are compared. */
export const normalizeRecovery = (code: string): string => code.replace(/[\s-]/g, '').toUpperCase();

/**
 * Activates the second factor when `code` comes from the pending secret; returns the recovery
 * codes (shown once). Undefined for a wrong code or when nothing is pending.
 */
export async function confirmEnrollment(
  db: Executor,
  options: MfaOptions,
  userId: string,
  code: string,
  now: Date = new Date(),
): Promise<string[] | undefined> {
  const rows = await sql<{
    secret_enc: string;
  }>`select secret_enc from ${sql.table(T.totp)} where user_id = ${userId} and confirmed_at is null`.execute(
    db,
  );
  const sealed = rows.rows[0]?.secret_enc;
  const secret = sealed === undefined ? undefined : open(options.key, sealed, userId);
  const step = secret === undefined ? undefined : verifyTotp(secret, code, now);
  if (step === undefined) return undefined;
  const done =
    await sql`update ${sql.table(T.totp)} set confirmed_at = ${now.toISOString()}::timestamptz, last_step = ${step} where user_id = ${userId} and confirmed_at is null returning user_id`.execute(
      db,
    );
  return done.rows.length > 0 ? newRecoveryCodes(db, userId) : undefined;
}

// ─── checking a code ─────────────────────────────────────────────────────────────────────

/**
 * Checks an authenticator code or a recovery code. A code works once: the step of a TOTP code
 * is recorded atomically, and a recovery code is marked used in the same statement that finds
 * it.
 * @returns which kind matched, or undefined
 */
export async function verifySecondFactor(
  db: Executor,
  options: MfaOptions,
  userId: string,
  input: { readonly code?: string | undefined; readonly recovery?: string | undefined },
  now: Date = new Date(),
): Promise<'totp' | 'recovery' | undefined> {
  if (input.recovery !== undefined) {
    const used =
      await sql`update ${sql.table(T.recovery)} set used_at = ${now.toISOString()}::timestamptz where code_hash = ${sha256(normalizeRecovery(input.recovery))} and user_id = ${userId} and used_at is null returning code_hash`.execute(
        db,
      );
    return used.rows.length > 0 ? 'recovery' : undefined;
  }
  if (input.code === undefined) return undefined;
  const rows = await sql<{
    secret_enc: string;
    last_step: string;
  }>`select secret_enc, last_step from ${sql.table(T.totp)} where user_id = ${userId} and confirmed_at is not null`.execute(
    db,
  );
  const row = rows.rows[0];
  const secret = row === undefined ? undefined : open(options.key, row.secret_enc, userId);
  if (row === undefined || secret === undefined) return undefined;
  const step = verifyTotp(secret, input.code, now, Number(row.last_step));
  if (step === undefined) return undefined;
  const recorded =
    await sql`update ${sql.table(T.totp)} set last_step = ${step} where user_id = ${userId} and last_step < ${step} returning user_id`.execute(
      db,
    );
  return recorded.rows.length > 0 ? 'totp' : undefined;
}

export async function unusedRecoveryCodes(db: Executor, userId: string): Promise<number> {
  const rows = await sql<{
    n: string;
  }>`select count(*) as n from ${sql.table(T.recovery)} where user_id = ${userId} and used_at is null`.execute(
    db,
  );
  return Number(rows.rows[0]?.n ?? 0);
}

export async function disableMfa(db: Executor, userId: string): Promise<void> {
  await sql`delete from ${sql.table(T.totp)} where user_id = ${userId}`.execute(db);
  await sql`delete from ${sql.table(T.recovery)} where user_id = ${userId}`.execute(db);
}

// ─── routes ──────────────────────────────────────────────────────────────────────────────

export interface MfaRouteDeps {
  readonly options: MfaOptions;
  readonly tenantOf: (request: FastifyRequest) => TenantRuntime;
  readonly userOf: (request: FastifyRequest) => Promise<UserContext>;
  readonly journal: (
    request: FastifyRequest,
    entry: { userId: string | null; kind: string; details: Record<string, string> },
  ) => Promise<void>;
  /** Opens the session (cookie, journal) once the second factor is proved; returns the body. */
  readonly finishLogin: (
    request: FastifyRequest,
    reply: FastifyReply,
    userId: string,
  ) => Promise<Record<string, unknown>>;
}

const codeText = z.string().regex(/^\d{6}$/);
const recoveryText = z.string().min(16).max(30);
const challengeText = z.string().length(43);
const verifyBody = z
  .object({
    challenge: challengeText,
    code: codeText.optional(),
    recovery: recoveryText.optional(),
    emailCode: codeText.optional(),
  })
  .strict()
  .refine(
    (body) =>
      [body.code, body.recovery, body.emailCode].filter((value) => value !== undefined).length ===
      1,
    { message: 'Give exactly one of code, recovery or emailCode.' },
  );
const emailConfirmBody = z.object({ challenge: challengeText.optional(), code: codeText }).strict();
const passwordOnlyBody = z.object({ password: z.string().min(1).max(1024) }).strict();
const setupBody = z.object({ challenge: challengeText.optional() }).strict();
const sendBody = z.object({ challenge: challengeText }).strict();
const confirmBody = z.object({ challenge: challengeText.optional(), code: codeText }).strict();
const disableBody = z
  .object({
    password: z.string().min(1).max(1024),
    code: codeText.optional(),
    recovery: recoveryText.optional(),
  })
  .strict();
const regenerateBody = z.object({ code: codeText }).strict();

const invalidCode = (): HttpError => new HttpError(401, 'invalid_code', 'Invalid or expired code.');

export function registerMfaRoutes(app: FastifyInstance, deps: MfaRouteDeps): void {
  const { options, tenantOf, userOf, journal } = deps;

  /** The user a request speaks for: a valid challenge, or else the signed-in user. */
  const subject = async (
    request: FastifyRequest,
    challenge: string | undefined,
  ): Promise<{ userId: string; challenge?: string }> => {
    const db = tenantOf(request).db;
    if (challenge === undefined) return { userId: (await userOf(request)).id };
    const userId = await challengeUser(db, challenge);
    if (userId === undefined) throw invalidCode();
    return { userId, challenge };
  };

  app.get('/auth/mfa', async (request) => {
    const user = await userOf(request);
    const db = tenantOf(request).db;
    return {
      state: await mfaState(db, user.id),
      methods: await mfaMethods(db, user.id),
      emailAvailable: options.sendCode !== undefined,
      required: await mfaRequired(db, tenantOf(request).security, options, user.id),
      recoveryCodesLeft: await unusedRecoveryCodes(db, user.id),
    };
  });

  app.post('/auth/mfa/verify', async (request, reply) => {
    const body = verifyBody.parse(request.body);
    const db = tenantOf(request).db;
    const userId = await challengeUser(db, body.challenge);
    const methods = userId === undefined ? undefined : await mfaMethods(db, userId);
    if (userId === undefined || methods === undefined || (!methods.totp && !methods.email)) {
      throw invalidCode();
    }
    let kind: 'totp' | 'recovery' | 'email' | undefined;
    if (body.emailCode !== undefined) {
      kind =
        methods.email && (await verifyEmailCode(db, options, userId, body.emailCode))
          ? 'email'
          : undefined;
    } else {
      kind = await verifySecondFactor(db, options, userId, body);
    }
    if (kind === undefined) {
      await failChallenge(db, body.challenge);
      await journal(request, { userId, kind: 'mfa_failed', details: {} });
      throw invalidCode();
    }
    await endChallenge(db, body.challenge);
    if (kind === 'recovery')
      await journal(request, { userId, kind: 'mfa_recovery_used', details: {} });
    return deps.finishLogin(request, reply, userId);
  });

  app.post('/auth/mfa/totp/setup', async (request) => {
    const body = setupBody.parse(request.body);
    const who = await subject(request, body.challenge);
    const started = await startEnrollment(tenantOf(request).db, options, who.userId);
    if (!started) throw new HttpError(409, 'mfa_enrolled', 'A second factor is already set up.');
    return started;
  });

  app.post('/auth/mfa/totp/confirm', async (request, reply) => {
    const body = confirmBody.parse(request.body);
    const db = tenantOf(request).db;
    const who = await subject(request, body.challenge);
    const codes = await confirmEnrollment(db, options, who.userId, body.code);
    if (codes === undefined) {
      if (who.challenge !== undefined) await failChallenge(db, who.challenge);
      throw invalidCode();
    }
    await journal(request, { userId: who.userId, kind: 'mfa_enabled', details: {} });
    if (who.challenge === undefined) return { ok: true, recoveryCodes: codes };
    await endChallenge(db, who.challenge);
    return { ...(await deps.finishLogin(request, reply, who.userId)), recoveryCodes: codes };
  });

  // ─── one-time codes by email ───────────────────────────────────────────────────────────

  /** Sends a fresh code (at most one a minute); the answer never tells whether one was sent. */
  const sendEmailCode = async (request: FastifyRequest, userId: string): Promise<void> => {
    const send = options.sendCode;
    if (!send) throw new HttpError(409, 'email_unavailable', 'Codes by email are not available.');
    const db = tenantOf(request).db;
    const code = await issueEmailCode(db, options, userId);
    if (code === undefined) return;
    const message = { login: await loginOf(db, userId), code, host: request.headers.host ?? '' };
    // Not awaited: the answer must not depend on the mail server's speed.
    send(message).catch((error: unknown) => {
      request.log.error({ err: error }, 'mfa code mail failed');
    });
  };

  /**
   * A sign-in challenge only proves the password. It may set up a first factor (enrolment), but
   * never add one to an account that already has one: whoever holds the password and the
   * mailbox could otherwise step around the authenticator app. Adding a method needs a session.
   */
  const refuseDowngrade = async (
    request: FastifyRequest,
    who: { userId: string; challenge?: string },
  ): Promise<void> => {
    if (who.challenge === undefined) return;
    const have = await mfaMethods(tenantOf(request).db, who.userId);
    if (have.totp || have.email) {
      throw new HttpError(409, 'mfa_enrolled', 'Sign in with your second factor first.');
    }
  };

  // Asks for a code during sign-in (the account must have turned the method on).
  app.post('/auth/mfa/email/send', async (request) => {
    const body = sendBody.parse(request.body);
    const who = await subject(request, body.challenge);
    if (!(await emailEnabled(tenantOf(request).db, who.userId))) {
      throw new HttpError(409, 'email_not_enabled', 'Codes by email are not turned on.');
    }
    await sendEmailCode(request, who.userId);
    return { ok: true };
  });

  // Turning the method on: a first code proves the mailbox is the user's.
  app.post('/auth/mfa/email/enable', async (request) => {
    const body = setupBody.parse(request.body);
    const who = await subject(request, body.challenge);
    await refuseDowngrade(request, who);
    if (await emailEnabled(tenantOf(request).db, who.userId)) {
      throw new HttpError(409, 'mfa_enrolled', 'Codes by email are already turned on.');
    }
    await sendEmailCode(request, who.userId);
    return { ok: true };
  });

  app.post('/auth/mfa/email/confirm', async (request, reply) => {
    const body = emailConfirmBody.parse(request.body);
    const db = tenantOf(request).db;
    const who = await subject(request, body.challenge);
    await refuseDowngrade(request, who);
    if (!(await verifyEmailCode(db, options, who.userId, body.code))) {
      if (who.challenge !== undefined) await failChallenge(db, who.challenge);
      throw invalidCode();
    }
    await setEmailEnabled(db, who.userId, true);
    await journal(request, { userId: who.userId, kind: 'mfa_email_enabled', details: {} });
    if (who.challenge === undefined) return { ok: true };
    await endChallenge(db, who.challenge);
    return deps.finishLogin(request, reply, who.userId);
  });

  app.post('/auth/mfa/email/disable', async (request) => {
    const body = passwordOnlyBody.parse(request.body);
    const user = await userOf(request);
    const tenant = tenantOf(request);
    // A required role keeps at least one factor: it cannot drop its only one.
    if (
      (await mfaRequired(tenant.db, tenant.security, options, user.id)) &&
      !(await mfaMethods(tenant.db, user.id)).totp
    ) {
      throw new HttpError(403, 'mfa_required', 'Your role requires a second factor.');
    }
    const stored = await sql<{
      password_hash: string;
    }>`select password_hash from ${sql.table(T.user)} where id = ${user.id}`.execute(tenant.db);
    if (
      stored.rows[0] === undefined ||
      !(await verifyPassword(stored.rows[0].password_hash, body.password))
    ) {
      throw new HttpError(403, 'invalid_credentials', 'Password is wrong.');
    }
    await setEmailEnabled(tenant.db, user.id, false);
    await journal(request, { userId: user.id, kind: 'mfa_email_disabled', details: {} });
    return { ok: true };
  });

  app.post('/auth/mfa/recovery/regenerate', async (request) => {
    const body = regenerateBody.parse(request.body);
    const user = await userOf(request);
    const db = tenantOf(request).db;
    if ((await verifySecondFactor(db, options, user.id, body)) !== 'totp') throw invalidCode();
    const codes = await newRecoveryCodes(db, user.id);
    await journal(request, { userId: user.id, kind: 'mfa_recovery_regenerated', details: {} });
    return { recoveryCodes: codes };
  });

  app.post('/auth/mfa/totp/disable', async (request) => {
    const body = disableBody.parse(request.body);
    const user = await userOf(request);
    const tenant = tenantOf(request);
    if (await mfaRequired(tenant.db, tenant.security, options, user.id)) {
      throw new HttpError(403, 'mfa_required', 'Your role requires a second factor.');
    }
    const stored = await sql<{
      password_hash: string;
    }>`select password_hash from ${sql.table(T.user)} where id = ${user.id}`.execute(tenant.db);
    const passwordOk =
      stored.rows[0] !== undefined &&
      (await verifyPassword(stored.rows[0].password_hash, body.password));
    const factor = passwordOk
      ? await verifySecondFactor(tenant.db, options, user.id, body)
      : undefined;
    if (factor === undefined) {
      throw new HttpError(403, 'invalid_credentials', 'Password or code is wrong.');
    }
    await disableMfa(tenant.db, user.id);
    await journal(request, { userId: user.id, kind: 'mfa_disabled', details: {} });
    return { ok: true };
  });
}
