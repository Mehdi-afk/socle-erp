// SPDX-License-Identifier: LGPL-3.0-only
//
// Authentication (ARCHITECTURE.md §9.3): Argon2id password hashes (native Node crypto),
// opaque session tokens of which only a SHA-256 hash is stored, sliding and absolute expiry,
// revocation, progressive lock-out after failures, one generic error for every failure.
// MFA, passkeys and OIDC come later on top of the same sessions.
import { argon2, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { UserContext } from '@socle/framework';
import { AUTH_TABLES, type Executor } from '@socle/orm-pg';
import { sql } from 'kysely';

/** Argon2id cost (RFC 9106 second recommended option: 64 MiB, 3 passes, 4 lanes). */
export interface PasswordCost {
  readonly memoryKiB: number;
  readonly passes: number;
  readonly parallelism: number;
}

export const DEFAULT_COST: PasswordCost = Object.freeze({
  memoryKiB: 65_536,
  passes: 3,
  parallelism: 4,
});

const derive = (password: string, salt: Buffer, cost: PasswordCost): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: password,
        nonce: salt,
        parallelism: cost.parallelism,
        tagLength: 32,
        memory: cost.memoryKiB,
        passes: cost.passes,
      },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });

/** Hashes a password into a PHC string `$argon2id$v=19$m=…,t=…,p=…$salt$hash`. */
export async function hashPassword(
  password: string,
  cost: PasswordCost = DEFAULT_COST,
): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, cost);
  return `$argon2id$v=19$m=${String(cost.memoryKiB)},t=${String(cost.passes)},p=${String(cost.parallelism)}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

const PHC =
  /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9_-]{16,64})\$([A-Za-z0-9_-]{32,128})$/;

/** Checks a password against a PHC hash, in constant time for a given hash. */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const match = PHC.exec(stored);
  if (!match) return false;
  const [, m, t, p, salt, expected] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const wanted = Buffer.from(expected, 'base64url');
  const actual = await derive(password, Buffer.from(salt, 'base64url'), {
    memoryKiB: Number(m),
    passes: Number(t),
    parallelism: Number(p),
  });
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/**
 * True when a stored hash is weaker than `cost` (lower memory, fewer passes or fewer lanes) or
 * is not a well-formed Argon2id hash: it is then replaced at the next successful sign-in.
 */
export function needsRehash(stored: string, cost: PasswordCost): boolean {
  const match = PHC.exec(stored);
  if (!match) return true;
  const [m, t, p] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return m < cost.memoryKiB || t < cost.passes || p < cost.parallelism;
}

export interface SessionPolicy {
  /** Idle time after which a session expires (sliding). */
  readonly idleMs: number;
  /** Maximum lifetime of a session, whatever the activity. */
  readonly absoluteMs: number;
  /** Failed attempts before the account is locked (then doubling lock times, max 24 h). */
  readonly maxFailures: number;
  /** Failed attempts from one address, whatever the accounts, before it is locked (default 20). */
  readonly maxIpFailures?: number | undefined;
  readonly cost: PasswordCost;
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = Object.freeze({
  idleMs: 8 * 3_600_000,
  absoluteMs: 7 * 86_400_000,
  maxFailures: 5,
  cost: DEFAULT_COST,
});

const T = AUTH_TABLES;
const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

/** The generic answer to every failed login (no account enumeration). */
export class LoginError extends Error {
  constructor() {
    super('Invalid credentials.');
  }
}

/** Creates a user (tools, tests; administration screens later). */
export async function createUser(
  db: Executor,
  user: {
    readonly id: string;
    readonly login: string;
    readonly password: string;
    readonly groupIds?: readonly string[];
    readonly companyIds?: readonly string[];
    readonly companyId?: string | null;
  },
  cost: PasswordCost = DEFAULT_COST,
): Promise<void> {
  await sql`insert into ${sql.table(T.user)} (id, login, password_hash, group_ids, company_ids, company_id) values (${user.id}, ${user.login.toLowerCase()}, ${await hashPassword(user.password, cost)}, ${[...(user.groupIds ?? [])]}::text[], ${[...(user.companyIds ?? [])]}::text[], ${user.companyId ?? null})`.execute(
    db,
  );
}

/** A hash with the right shape and cost, used when the login is unknown (same timing). */
let decoy: Promise<string> | undefined;

const lockDuration = (failures: number, free: number): number =>
  failures >= free ? Math.min(86_400_000, 60_000 * 2 ** Math.min(20, failures - free)) : 0;

async function ipIsLocked(db: Executor, ip: string, now: Date): Promise<boolean> {
  const rows = await sql<{
    locked_until: Date | string | null;
  }>`select locked_until from ${sql.table(T.loginIp)} where ip = ${ip}`.execute(db);
  const until = rows.rows[0]?.locked_until;
  return until !== null && until !== undefined && new Date(until) > now;
}

/** Counts a failed attempt from `ip`; the count is forgotten after 24 hours of quiet. */
async function recordIpFailure(
  db: Executor,
  ip: string,
  now: Date,
  policy: SessionPolicy,
): Promise<void> {
  const stamp = now.toISOString();
  const rows = await sql<{
    failures: number;
  }>`insert into ${sql.table(T.loginIp)} as t (ip, failures, updated_at) values (${ip}, 1, ${stamp}::timestamptz) on conflict (ip) do update set failures = case when t.updated_at < ${stamp}::timestamptz - interval '24 hours' then 1 else t.failures + 1 end, updated_at = ${stamp}::timestamptz returning failures`.execute(
    db,
  );
  const wait = lockDuration(rows.rows[0]?.failures ?? 1, policy.maxIpFailures ?? 20);
  if (wait > 0) {
    await sql`update ${sql.table(T.loginIp)} set locked_until = ${new Date(now.getTime() + wait).toISOString()}::timestamptz where ip = ${ip}`.execute(
      db,
    );
  }
}

/**
 * Checks a login and password (lock-outs, generic failure, re-hash) without opening a session:
 * the caller may still ask for a second factor.
 * @returns the user id
 * @throws {@link LoginError}
 */
export async function checkCredentials(
  db: Executor,
  loginName: string,
  password: string,
  policy: SessionPolicy = DEFAULT_SESSION_POLICY,
  now: Date = new Date(),
  ip?: string,
): Promise<string> {
  // A locked address gets the generic answer after the same work, and does not touch the
  // account's own counter (an attacker must not lock a victim out from a locked address).
  if (ip !== undefined && (await ipIsLocked(db, ip, now))) {
    decoy ??= hashPassword('decoy', policy.cost);
    await verifyPassword(await decoy, password);
    throw new LoginError();
  }
  const rows = await sql<{
    id: string;
    password_hash: string;
    active: boolean;
    failed_attempts: number;
    locked_until: Date | string | null;
  }>`select id, password_hash, active, failed_attempts, locked_until from ${sql.table(T.user)} where login = ${loginName.toLowerCase()}`.execute(
    db,
  );
  const user = rows.rows[0];
  if (!user) {
    decoy ??= hashPassword('decoy', policy.cost);
    await verifyPassword(await decoy, password);
    if (ip !== undefined) await recordIpFailure(db, ip, now, policy);
    throw new LoginError();
  }
  const lockedUntil = user.locked_until === null ? null : new Date(user.locked_until);
  const locked = lockedUntil !== null && lockedUntil > now;
  const valid = await verifyPassword(user.password_hash, password);
  if (locked || !user.active || !valid) {
    if (!locked && !valid) {
      const failures = user.failed_attempts + 1;
      const over = failures - policy.maxFailures;
      const lockMs = over >= 0 ? Math.min(86_400_000, 60_000 * 2 ** over) : 0;
      await sql`update ${sql.table(T.user)} set failed_attempts = ${failures}, locked_until = ${lockMs > 0 ? new Date(now.getTime() + lockMs).toISOString() : null}::timestamptz where id = ${user.id}`.execute(
        db,
      );
    }
    if (!valid && ip !== undefined) await recordIpFailure(db, ip, now, policy);
    throw new LoginError();
  }
  await sql`update ${sql.table(T.user)} set failed_attempts = 0, locked_until = null where id = ${user.id}`.execute(
    db,
  );
  // Hashing parameters are raised over time: the password is re-hashed while we hold it.
  if (needsRehash(user.password_hash, policy.cost)) {
    await sql`update ${sql.table(T.user)} set password_hash = ${await hashPassword(password, policy.cost)} where id = ${user.id}`.execute(
      db,
    );
  }
  return user.id;
}

/**
 * Opens a session for a user whose identity was just proved (password, and second factor when
 * there is one): a new token every time, so session fixation is impossible.
 */
export async function openSession(
  db: Executor,
  userId: string,
  policy: SessionPolicy = DEFAULT_SESSION_POLICY,
  now: Date = new Date(),
  ip?: string,
  userAgent?: string,
): Promise<{ readonly token: string; readonly expiresAt: Date; readonly userId: string }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + policy.absoluteMs);
  await sql`insert into ${sql.table(T.session)} (token_hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent) values (${tokenHash(token)}, ${userId}, ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz, ${expiresAt.toISOString()}::timestamptz, ${ip ?? null}, ${userAgent?.slice(0, 300) ?? null})`.execute(
    db,
  );
  return { token, expiresAt, userId };
}

/**
 * Checks a login and password and opens a session (no second factor).
 * @throws {@link LoginError}
 */
export async function login(
  db: Executor,
  loginName: string,
  password: string,
  policy: SessionPolicy = DEFAULT_SESSION_POLICY,
  now: Date = new Date(),
  ip?: string,
  userAgent?: string,
): Promise<{ readonly token: string; readonly expiresAt: Date; readonly userId: string }> {
  const userId = await checkCredentials(db, loginName, password, policy, now, ip);
  return openSession(db, userId, policy, now, ip, userAgent);
}

/**
 * The user of a session token, or undefined (unknown, revoked, expired, idle too long, user
 * disabled). Extends the idle window on success.
 */
export async function authenticate(
  db: Executor,
  token: string | undefined,
  policy: SessionPolicy = DEFAULT_SESSION_POLICY,
  now: Date = new Date(),
): Promise<UserContext | undefined> {
  if (token === undefined || token.length !== 43) return undefined;
  const rows = await sql<{
    id: string;
    group_ids: string[];
    company_ids: string[];
    company_id: string | null;
    lang: string;
    tz: string;
    last_seen_at: Date | string;
  }>`select u.id, u.group_ids, u.company_ids, u.company_id, u.lang, u.tz, s.last_seen_at from ${sql.table(T.session)} s join ${sql.table(T.user)} u on u.id = s.user_id where s.token_hash = ${tokenHash(token)} and not s.revoked and s.expires_at > ${now.toISOString()}::timestamptz and u.active`.execute(
    db,
  );
  const row = rows.rows[0];
  if (!row || now.getTime() - new Date(row.last_seen_at).getTime() > policy.idleMs)
    return undefined;
  await sql`update ${sql.table(T.session)} set last_seen_at = ${now.toISOString()}::timestamptz where token_hash = ${tokenHash(token)}`.execute(
    db,
  );
  return {
    id: row.id,
    groupIds: row.group_ids,
    companyIds: row.company_ids,
    companyId: row.company_id,
    lang: row.lang,
    tz: row.tz,
  };
}

/** A session as its owner sees it (the id is not the secret token). */
export interface SessionInfo {
  readonly id: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  /** The session making the request. */
  readonly current: boolean;
}

/** The active sessions of a user (not revoked, not expired, not idle too long). */
export async function listSessions(
  db: Executor,
  userId: string,
  currentToken: string | undefined,
  policy: SessionPolicy = DEFAULT_SESSION_POLICY,
  now: Date = new Date(),
): Promise<SessionInfo[]> {
  const rows = await sql<{
    id: string;
    token_hash: string;
    created_at: Date | string;
    last_seen_at: Date | string;
    ip: string | null;
    user_agent: string | null;
  }>`select id, token_hash, created_at, last_seen_at, ip, user_agent from ${sql.table(T.session)} where user_id = ${userId} and not revoked and expires_at > ${now.toISOString()}::timestamptz and last_seen_at > ${new Date(now.getTime() - policy.idleMs).toISOString()}::timestamptz order by last_seen_at desc`.execute(
    db,
  );
  const mine = currentToken === undefined ? undefined : tokenHash(currentToken);
  return rows.rows.map((row) => ({
    id: row.id,
    createdAt: new Date(row.created_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    ip: row.ip,
    userAgent: row.user_agent,
    current: row.token_hash === mine,
  }));
}

/** Revokes one of the user's own sessions by id; false when it is not theirs or not there. */
export async function revokeSession(
  db: Executor,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const done =
    await sql`update ${sql.table(T.session)} set revoked = true where id = ${sessionId}::uuid and user_id = ${userId} and not revoked returning id`.execute(
      db,
    );
  return done.rows.length > 0;
}

/** Ties a session to the synchronising device it serves (see {@link revokeDeviceSessions}). */
export async function attachSessionToDevice(
  db: Executor,
  token: string,
  deviceId: string,
): Promise<void> {
  await sql`update ${sql.table(T.session)} set device_id = ${deviceId} where token_hash = ${tokenHash(token)} and not revoked`.execute(
    db,
  );
}

/** Cuts every session of a device (its owner revoked it): nothing it holds still opens the API. */
export async function revokeDeviceSessions(db: Executor, deviceId: string): Promise<void> {
  await sql`update ${sql.table(T.session)} set revoked = true where device_id = ${deviceId}`.execute(
    db,
  );
}

/**
 * Replaces the token of a session by a fresh one (same user, same absolute expiry): done when
 * privileges change (password change, second factor), so that a token seen before cannot be
 * used after. The old token stops working at once.
 * @returns the new token, or undefined when the old one is not an active session
 */
export async function rotateSession(
  db: Executor,
  token: string,
  now: Date = new Date(),
): Promise<string | undefined> {
  const fresh = randomBytes(32).toString('base64url');
  const done =
    await sql`with old as (update ${sql.table(T.session)} set revoked = true where token_hash = ${tokenHash(token)} and not revoked and expires_at > ${now.toISOString()}::timestamptz returning user_id, created_at, expires_at, ip, user_agent, device_id) insert into ${sql.table(T.session)} (token_hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent, device_id) select ${tokenHash(fresh)}, user_id, created_at, ${now.toISOString()}::timestamptz, expires_at, ip, user_agent, device_id from old returning token_hash`.execute(
      db,
    );
  return done.rows.length > 0 ? fresh : undefined;
}

/**
 * The anti-CSRF token of a session: derived from the session secret, so that a page of another
 * site (which cannot read the cookie) cannot compute it. The client keeps it in memory and
 * sends it in `X-CSRF-Token` with every modifying request.
 */
export function csrfToken(sessionToken: string): string {
  return createHash('sha256').update(`socle-csrf:${sessionToken}`).digest('base64url');
}

/** True when `given` is the anti-CSRF token of `sessionToken` (constant time). */
export function csrfMatches(sessionToken: string, given: string | undefined): boolean {
  if (given === undefined) return false;
  const expected = Buffer.from(csrfToken(sessionToken));
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Revokes a session (logout, device lost). */
export async function logout(db: Executor, token: string): Promise<void> {
  await sql`update ${sql.table(T.session)} set revoked = true where token_hash = ${tokenHash(token)}`.execute(
    db,
  );
}

/** The login of a user (to check that a password differs from it). */
export async function loginOf(db: Executor, userId: string): Promise<string> {
  const rows = await sql<{
    login: string;
  }>`select login from ${sql.table(T.user)} where id = ${userId}`.execute(db);
  return rows.rows[0]?.login ?? '';
}

/** Validity of a password-reset token. */
export const RESET_TOKEN_MS = 30 * 60_000;

/**
 * Changes the password of the signed-in user after checking the current one. Every other
 * session of the user is revoked (a stolen session does not survive the change); the current
 * one, `keepToken`, stays.
 * @throws {@link LoginError} when the current password is wrong
 */
export async function changePassword(
  db: Executor,
  userId: string,
  current: string,
  next: string,
  keepToken: string | undefined,
  cost: PasswordCost = DEFAULT_COST,
): Promise<void> {
  const rows = await sql<{
    password_hash: string;
  }>`select password_hash from ${sql.table(T.user)} where id = ${userId} and active`.execute(db);
  const stored = rows.rows[0]?.password_hash;
  if (stored === undefined || !(await verifyPassword(stored, current))) throw new LoginError();
  await sql`update ${sql.table(T.user)} set password_hash = ${await hashPassword(next, cost)} where id = ${userId}`.execute(
    db,
  );
  await sql`update ${sql.table(T.session)} set revoked = true where user_id = ${userId} and token_hash <> ${keepToken === undefined ? '' : tokenHash(keepToken)}`.execute(
    db,
  );
}

/**
 * A single-use reset token for the account `loginName`, valid 30 minutes (any earlier token of
 * the account stops working). Undefined for an unknown or disabled account: the caller answers
 * the same thing either way, so that the answer does not reveal which accounts exist.
 */
export async function requestPasswordReset(
  db: Executor,
  loginName: string,
  now: Date = new Date(),
): Promise<{ readonly token: string; readonly userId: string } | undefined> {
  const rows = await sql<{
    id: string;
  }>`select id from ${sql.table(T.user)} where login = ${loginName.toLowerCase()} and active`.execute(
    db,
  );
  const userId = rows.rows[0]?.id;
  if (userId === undefined) return undefined;
  const token = randomBytes(32).toString('base64url');
  await sql`delete from ${sql.table(T.passwordReset)} where user_id = ${userId}`.execute(db);
  await sql`insert into ${sql.table(T.passwordReset)} (token_hash, user_id, expires_at) values (${tokenHash(token)}, ${userId}, ${new Date(now.getTime() + RESET_TOKEN_MS).toISOString()}::timestamptz)`.execute(
    db,
  );
  return { token, userId };
}

/** The login of the account a valid reset token belongs to (to check the new password). */
export async function resetTokenLogin(
  db: Executor,
  token: string,
  now: Date = new Date(),
): Promise<string | undefined> {
  const rows = await sql<{
    login: string;
  }>`select u.login from ${sql.table(T.passwordReset)} r join ${sql.table(T.user)} u on u.id = r.user_id where r.token_hash = ${tokenHash(token)} and r.used_at is null and r.expires_at > ${now.toISOString()}::timestamptz and u.active`.execute(
    db,
  );
  return rows.rows[0]?.login;
}

/**
 * Sets a new password with a reset token: the token is consumed atomically (a second use
 * fails), every session of the account is revoked and the account is unlocked.
 * @returns the user id, or undefined for an unknown, used or expired token
 */
export async function resetPassword(
  db: Executor,
  token: string,
  next: string,
  cost: PasswordCost = DEFAULT_COST,
  now: Date = new Date(),
): Promise<string | undefined> {
  const used = await sql<{
    user_id: string;
  }>`update ${sql.table(T.passwordReset)} set used_at = ${now.toISOString()}::timestamptz where token_hash = ${tokenHash(token)} and used_at is null and expires_at > ${now.toISOString()}::timestamptz returning user_id`.execute(
    db,
  );
  const userId = used.rows[0]?.user_id;
  if (userId === undefined) return undefined;
  await sql`update ${sql.table(T.user)} set password_hash = ${await hashPassword(next, cost)}, failed_attempts = 0, locked_until = null where id = ${userId}`.execute(
    db,
  );
  await sql`update ${sql.table(T.session)} set revoked = true where user_id = ${userId}`.execute(
    db,
  );
  return userId;
}

/** Name of the session cookie: `__Host-` forces Secure, Path=/ and no Domain (no subdomain sharing). */
export const SESSION_COOKIE = '__Host-socle_session';

export function sessionCookie(token: string, maxAgeMs: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${String(Math.floor(maxAgeMs / 1000))}`;
}

export const CLEAR_SESSION_COOKIE = `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

/** The session token from a `Cookie` header. */
export function readSessionCookie(header: string | undefined): string | undefined {
  if (header === undefined || header.length > 8192) return undefined;
  for (const part of header.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === SESSION_COOKIE) return value.join('=');
  }
  return undefined;
}
