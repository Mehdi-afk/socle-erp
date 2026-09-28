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

export interface SessionPolicy {
  /** Idle time after which a session expires (sliding). */
  readonly idleMs: number;
  /** Maximum lifetime of a session, whatever the activity. */
  readonly absoluteMs: number;
  /** Failed attempts before the account is locked (then doubling lock times, max 24 h). */
  readonly maxFailures: number;
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

/**
 * Checks a login and password; on success opens a session and returns its token (a new one
 * at each login: session fixation is impossible).
 * @throws {@link LoginError}
 */
export async function login(
  db: Executor,
  loginName: string,
  password: string,
  policy: SessionPolicy = DEFAULT_SESSION_POLICY,
  now: Date = new Date(),
): Promise<{ readonly token: string; readonly expiresAt: Date }> {
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
    throw new LoginError();
  }
  await sql`update ${sql.table(T.user)} set failed_attempts = 0, locked_until = null where id = ${user.id}`.execute(
    db,
  );
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + policy.absoluteMs);
  await sql`insert into ${sql.table(T.session)} (token_hash, user_id, created_at, last_seen_at, expires_at) values (${tokenHash(token)}, ${user.id}, ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz, ${expiresAt.toISOString()}::timestamptz)`.execute(
    db,
  );
  return { token, expiresAt };
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

/** Revokes a session (logout, device lost). */
export async function logout(db: Executor, token: string): Promise<void> {
  await sql`update ${sql.table(T.session)} set revoked = true where token_hash = ${tokenHash(token)}`.execute(
    db,
  );
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
