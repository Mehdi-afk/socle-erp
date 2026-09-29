// SPDX-License-Identifier: LGPL-3.0-only
//
// One-time codes sent by email (lot 2.2d), a second factor for people without an authenticator
// app. A code has 6 digits from the system random generator, lives 10 minutes, allows 5 wrong
// tries and works once. Only a keyed hash (HMAC-SHA-256 with a key derived from the server key
// and bound to the user) is stored: six digits are too few to protect a plain hash, the key is.
// A new code cannot be requested more than once a minute, so the mailbox cannot be flooded.
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

import { AUTH_TABLES, type Executor } from '@socle/orm-pg';
import { sql } from 'kysely';

import type { MfaOptions } from './mfa.js';

const T = AUTH_TABLES;
export const EMAIL_CODE_MS = 10 * 60_000;
export const EMAIL_CODE_ATTEMPTS = 5;
export const EMAIL_RESEND_MS = 60_000;

const hashOf = (options: MfaOptions, userId: string, code: string): Buffer =>
  createHmac('sha256', createHmac('sha256', options.key).update('socle:email-otp').digest())
    .update(`${userId}:${code}`)
    .digest();

export async function emailEnabled(db: Executor, userId: string): Promise<boolean> {
  const rows = await sql<{
    mfa_email: boolean;
  }>`select mfa_email from ${sql.table(T.user)} where id = ${userId}`.execute(db);
  return rows.rows[0]?.mfa_email === true;
}

export async function setEmailEnabled(
  db: Executor,
  userId: string,
  enabled: boolean,
): Promise<void> {
  await sql`update ${sql.table(T.user)} set mfa_email = ${enabled} where id = ${userId}`.execute(
    db,
  );
  if (!enabled)
    await sql`delete from ${sql.table(T.emailOtp)} where user_id = ${userId}`.execute(db);
}

/**
 * A new code for the user, replacing any pending one; undefined when one was sent less than a
 * minute ago (nothing is sent, the caller answers the same way).
 */
export async function issueEmailCode(
  db: Executor,
  options: MfaOptions,
  userId: string,
  now: Date = new Date(),
): Promise<string | undefined> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const stamp = now.toISOString();
  const throttle = new Date(now.getTime() - EMAIL_RESEND_MS).toISOString();
  const done =
    await sql`insert into ${sql.table(T.emailOtp)} as t (user_id, code_hash, expires_at, attempts, sent_at) values (${userId}, ${hashOf(options, userId, code).toString('hex')}, ${new Date(now.getTime() + EMAIL_CODE_MS).toISOString()}::timestamptz, 0, ${stamp}::timestamptz) on conflict (user_id) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at where t.sent_at <= ${throttle}::timestamptz returning user_id`.execute(
      db,
    );
  return done.rows.length > 0 ? code : undefined;
}

/**
 * Checks a code. Every call counts as an attempt (5 at most, then the code is dead); a right
 * code is deleted in the statement that accepts it, so two simultaneous uses cannot both pass.
 */
export async function verifyEmailCode(
  db: Executor,
  options: MfaOptions,
  userId: string,
  code: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  const tried = await sql<{
    code_hash: string;
  }>`update ${sql.table(T.emailOtp)} set attempts = attempts + 1 where user_id = ${userId} and expires_at > ${now.toISOString()}::timestamptz and attempts < ${EMAIL_CODE_ATTEMPTS} returning code_hash`.execute(
    db,
  );
  const stored = tried.rows[0]?.code_hash;
  if (stored === undefined) return false;
  const expected = Buffer.from(stored, 'hex');
  const given = hashOf(options, userId, code);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  const spent =
    await sql`delete from ${sql.table(T.emailOtp)} where user_id = ${userId} and code_hash = ${stored} returning user_id`.execute(
      db,
    );
  return spent.rows.length > 0;
}
