// SPDX-License-Identifier: LGPL-3.0-only
//
// Passkeys (WebAuthn, lot 2.2e). The server keeps only public keys. A passkey always requires
// user verification (biometrics or PIN on the device), so signing in with one is already two
// factors in one gesture; it can also be the second step after the password. The relying-party id
// is the host of the tenant that served the request (`acme.erp.example.com`), and the origin
// `https://<host>`: a passkey made for one tenant is useless on another. Each ceremony has its
// own challenge, stored server side, valid 5 minutes and consumed by the first answer.
import { createHash, randomBytes } from 'node:crypto';

import type { UserContext } from '@socle/framework';
import { AUTH_TABLES, type Executor } from '@socle/orm-pg';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';

import { loginOf, verifyPassword } from './auth.js';
import { HttpError } from './http-error.js';
import {
  challengeUser,
  endChallenge,
  failChallenge,
  mfaMethods,
  mfaRequired,
  type MfaOptions,
} from './mfa.js';
import type { TenantRuntime } from './tenants.js';

const T = AUTH_TABLES;
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const CEREMONY_MS = 5 * 60_000;
const MAX_PASSKEYS = 20;

export interface PasskeyOptions {
  /** Name shown by the browser when it asks to create a passkey (default "Socle"). */
  readonly rpName?: string | undefined;
  /** Second factor settings, to know which roles must keep at least one factor. */
  readonly mfa?: MfaOptions | undefined;
}

interface PasskeyRow {
  readonly id: string;
  readonly user_id: string;
  readonly public_key: string;
  readonly counter: string;
  readonly transports: string[];
  readonly name: string;
  readonly device_type: string;
  readonly backed_up: boolean;
  readonly created_at: Date | string;
  readonly last_used_at: Date | string | null;
}

/** A passkey as its owner sees it (never the public key). */
export interface PasskeyInfo {
  readonly id: string;
  readonly name: string;
  readonly deviceType: string;
  readonly backedUp: boolean;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

// ─── storage ─────────────────────────────────────────────────────────────────────────────

type Purpose = 'register' | 'login' | 'mfa';

/** Stores the challenge of a ceremony; the client gets an opaque token for it. */
async function createCeremony(
  db: Executor,
  purpose: Purpose,
  challenge: string,
  userId: string | null,
  now: Date = new Date(),
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await sql`delete from ${sql.table(T.ceremony)} where expires_at < ${now.toISOString()}::timestamptz`.execute(
    db,
  );
  await sql`insert into ${sql.table(T.ceremony)} (token_hash, challenge, purpose, user_id, expires_at) values (${sha256(token)}, ${challenge}, ${purpose}, ${userId}, ${new Date(now.getTime() + CEREMONY_MS).toISOString()}::timestamptz)`.execute(
    db,
  );
  return token;
}

/**
 * The challenge of a ceremony, consumed in the same statement: an answer works once, and a
 * ceremony of one kind cannot be answered as another.
 */
async function takeCeremony(
  db: Executor,
  token: string,
  purpose: Purpose,
  now: Date = new Date(),
): Promise<{ challenge: string; userId: string | null } | undefined> {
  const rows = await sql<{
    challenge: string;
    user_id: string | null;
  }>`delete from ${sql.table(T.ceremony)} where token_hash = ${sha256(token)} and purpose = ${purpose} and expires_at > ${now.toISOString()}::timestamptz returning challenge, user_id`.execute(
    db,
  );
  const row = rows.rows[0];
  return row ? { challenge: row.challenge, userId: row.user_id } : undefined;
}

const toInfo = (row: PasskeyRow): PasskeyInfo => ({
  id: row.id,
  name: row.name,
  deviceType: row.device_type,
  backedUp: row.backed_up,
  createdAt: new Date(row.created_at).toISOString(),
  lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at).toISOString(),
});

export async function listPasskeys(db: Executor, userId: string): Promise<PasskeyInfo[]> {
  const rows =
    await sql<PasskeyRow>`select * from ${sql.table(T.passkey)} where user_id = ${userId} order by created_at`.execute(
      db,
    );
  return rows.rows.map(toInfo);
}

const passkeyRows = async (db: Executor, userId: string): Promise<PasskeyRow[]> =>
  (
    await sql<PasskeyRow>`select * from ${sql.table(T.passkey)} where user_id = ${userId}`.execute(
      db,
    )
  ).rows;

// ─── routes ──────────────────────────────────────────────────────────────────────────────

export interface PasskeyRouteDeps {
  readonly options: PasskeyOptions;
  readonly tenantOf: (request: FastifyRequest) => TenantRuntime;
  readonly userOf: (request: FastifyRequest) => Promise<UserContext>;
  readonly journal: (
    request: FastifyRequest,
    entry: { userId: string | null; kind: string; details: Record<string, string> },
  ) => Promise<void>;
  readonly finishLogin: (
    request: FastifyRequest,
    reply: FastifyReply,
    userId: string,
  ) => Promise<Record<string, unknown>>;
}

const b64 = z.string().min(1).max(20_000);
const challengeText = z.string().length(43);
const ceremonyText = z.string().length(43);
const registrationResponse = z.looseObject({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.literal('public-key'),
  response: z.looseObject({
    clientDataJSON: b64,
    attestationObject: b64,
    transports: z.array(z.string().max(32)).max(8).optional(),
  }),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
});
const authenticationResponse = z.looseObject({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.literal('public-key'),
  response: z.looseObject({
    clientDataJSON: b64,
    authenticatorData: b64,
    signature: b64,
    userHandle: z.string().max(1024).nullish(),
  }),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
});
const registerOptionsBody = z
  .object({
    password: z.string().min(1).max(1024).optional(),
    challenge: challengeText.optional(),
  })
  .strict()
  .refine((body) => (body.password === undefined) !== (body.challenge === undefined), {
    message: 'Give either the password or a sign-in challenge.',
  });
const registerVerifyBody = z
  .object({
    ceremony: ceremonyText,
    challenge: challengeText.optional(),
    name: z.string().trim().min(1).max(60).optional(),
    response: registrationResponse,
  })
  .strict();
const loginVerifyBody = z
  .object({ ceremony: ceremonyText, response: authenticationResponse })
  .strict();
const mfaOptionsBody = z.object({ challenge: challengeText }).strict();
const mfaVerifyBody = z
  .object({ challenge: challengeText, ceremony: ceremonyText, response: authenticationResponse })
  .strict();
const passkeyId = z.object({ id: z.string().min(1).max(1024) });

const invalid = (): HttpError => new HttpError(401, 'invalid_credentials', 'Passkey refused.');

export function registerPasskeyRoutes(app: FastifyInstance, deps: PasskeyRouteDeps): void {
  const { options, tenantOf, userOf, journal } = deps;

  /** The relying party of a request: the tenant's own host, exactly. */
  const party = (request: FastifyRequest): { rpID: string; origin: string } => {
    const host = request.headers.host ?? '';
    return { rpID: host.replace(/:\d{1,5}$/, ''), origin: `https://${host}` };
  };

  /** Checks an assertion against the stored passkey and updates its counter. */
  const checkAssertion = async (
    request: FastifyRequest,
    challenge: string,
    response: AuthenticationResponseJSON,
    onlyUser?: string,
  ): Promise<string> => {
    const db = tenantOf(request).db;
    const found =
      await sql<PasskeyRow>`select p.* from ${sql.table(T.passkey)} p join ${sql.table(T.user)} u on u.id = p.user_id where p.id = ${response.id} and u.active`.execute(
        db,
      );
    const row = found.rows[0];
    if (!row || (onlyUser !== undefined && row.user_id !== onlyUser)) throw invalid();
    const { rpID, origin } = party(request);
    let verified;
    try {
      verified = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: row.id,
          publicKey: Uint8Array.from(Buffer.from(row.public_key, 'base64url')),
          counter: Number(row.counter),
          transports: row.transports,
        },
      });
    } catch {
      throw invalid();
    }
    if (!verified.verified) throw invalid();
    const updated =
      await sql`update ${sql.table(T.passkey)} set counter = ${verified.authenticationInfo.newCounter}, last_used_at = now(), backed_up = ${verified.authenticationInfo.credentialBackedUp} where id = ${row.id} and (counter < ${verified.authenticationInfo.newCounter} or (counter = 0 and ${verified.authenticationInfo.newCounter} = 0)) returning id`.execute(
        db,
      );
    // Two simultaneous uses of the same signature: only the first moves the counter forward.
    if (updated.rows.length === 0) throw invalid();
    return row.user_id;
  };

  app.get('/auth/passkeys', async (request) => {
    const user = await userOf(request);
    return { passkeys: await listPasskeys(tenantOf(request).db, user.id) };
  });

  // ─── registration ──────────────────────────────────────────────────────────────────────

  /**
   * Who is registering: a signed-in user who repeats the password (a stolen session must not be
   * able to add a passkey of its own), or an account that has to set up a first factor and holds
   * a sign-in challenge.
   */
  app.post('/auth/passkeys/register/options', async (request) => {
    const body = registerOptionsBody.parse(request.body);
    const db = tenantOf(request).db;
    let userId: string;
    if (body.challenge !== undefined) {
      const fromChallenge = await challengeUser(db, body.challenge);
      if (fromChallenge === undefined) throw invalid();
      const have = await mfaMethods(db, fromChallenge);
      if (have.totp || have.email || have.passkey) {
        throw new HttpError(409, 'mfa_enrolled', 'Sign in with your second factor first.');
      }
      userId = fromChallenge;
    } else {
      userId = (await userOf(request)).id;
      const stored = await sql<{
        password_hash: string;
      }>`select password_hash from ${sql.table(T.user)} where id = ${userId}`.execute(db);
      const hash = stored.rows[0]?.password_hash;
      if (hash === undefined || !(await verifyPassword(hash, body.password ?? ''))) {
        throw new HttpError(403, 'invalid_credentials', 'Password is wrong.');
      }
    }
    const existing = await passkeyRows(db, userId);
    if (existing.length >= MAX_PASSKEYS) {
      throw new HttpError(409, 'too_many', 'Too many passkeys: remove one first.');
    }
    const { rpID } = party(request);
    const generated = await generateRegistrationOptions({
      rpName: options.rpName ?? 'Socle',
      rpID,
      userName: await loginOf(db, userId),
      userID: new TextEncoder().encode(userId),
      attestationType: 'none',
      excludeCredentials: existing.map((row) => ({ id: row.id, transports: row.transports })),
      // A discoverable credential with user verification: usable without typing a login.
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const ceremony = await createCeremony(db, 'register', generated.challenge, userId);
    return { ceremony, options: generated };
  });

  app.post('/auth/passkeys/register/verify', async (request, reply) => {
    const body = registerVerifyBody.parse(request.body);
    const db = tenantOf(request).db;
    const taken = await takeCeremony(db, body.ceremony, 'register');
    if (!taken || taken.userId === null) throw invalid();
    let userId: string;
    if (body.challenge !== undefined) {
      const fromChallenge = await challengeUser(db, body.challenge);
      if (fromChallenge !== taken.userId) throw invalid();
      userId = fromChallenge;
    } else {
      userId = (await userOf(request)).id;
      if (userId !== taken.userId) throw invalid();
    }
    const { rpID, origin } = party(request);
    let verified;
    try {
      verified = await verifyRegistrationResponse({
        response: body.response as unknown as RegistrationResponseJSON,
        expectedChallenge: taken.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
    } catch {
      if (body.challenge !== undefined) await failChallenge(db, body.challenge);
      throw new HttpError(400, 'invalid_passkey', 'The passkey could not be verified.');
    }
    const info = verified.registrationInfo;
    if (!verified.verified || !info) {
      throw new HttpError(400, 'invalid_passkey', 'The passkey could not be verified.');
    }
    const name = body.name ?? `Passkey ${String((await passkeyRows(db, userId)).length + 1)}`;
    try {
      await sql`insert into ${sql.table(T.passkey)} (id, user_id, public_key, counter, transports, name, device_type, backed_up) values (${info.credential.id}, ${userId}, ${Buffer.from(info.credential.publicKey).toString('base64url')}, ${info.credential.counter}, ${info.credential.transports ?? []}::text[], ${name}, ${info.credentialDeviceType}, ${info.credentialBackedUp})`.execute(
        db,
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new HttpError(409, 'passkey_exists', 'This passkey is already registered.');
      }
      throw error;
    }
    await journal(request, {
      userId,
      kind: 'passkey_added',
      details: { name: name.slice(0, 60) },
    });
    if (body.challenge === undefined) return { ok: true, id: info.credential.id, name };
    await endChallenge(db, body.challenge);
    return { ...(await deps.finishLogin(request, reply, userId)), id: info.credential.id, name };
  });

  app.delete<{ Params: { id: string } }>('/auth/passkeys/:id', async (request) => {
    const user = await userOf(request);
    const { id } = passkeyId.parse(request.params);
    const tenant = tenantOf(request);
    const mine = await passkeyRows(tenant.db, user.id);
    if (!mine.some((row) => row.id === id))
      throw new HttpError(404, 'not_found', 'Unknown passkey.');
    // A role that requires a second factor keeps one: not its last.
    const have = await mfaMethods(tenant.db, user.id);
    if (
      options.mfa !== undefined &&
      mine.length === 1 &&
      !have.totp &&
      !have.email &&
      (await mfaRequired(tenant.db, tenant.security, options.mfa, user.id))
    ) {
      throw new HttpError(403, 'mfa_required', 'Your role requires a second factor.');
    }
    await sql`delete from ${sql.table(T.passkey)} where id = ${id} and user_id = ${user.id}`.execute(
      tenant.db,
    );
    await journal(request, { userId: user.id, kind: 'passkey_removed', details: {} });
    return { ok: true };
  });

  // ─── sign-in with a passkey alone ──────────────────────────────────────────────────────

  app.post('/auth/passkeys/login/options', async (request) => {
    const db = tenantOf(request).db;
    // No list of credentials: the device offers its passkeys for this site, and the answer
    // reveals nothing about which accounts exist.
    const generated = await generateAuthenticationOptions({
      rpID: party(request).rpID,
      userVerification: 'required',
    });
    return {
      ceremony: await createCeremony(db, 'login', generated.challenge, null),
      options: generated,
    };
  });

  app.post('/auth/passkeys/login/verify', async (request, reply) => {
    const body = loginVerifyBody.parse(request.body);
    const taken = await takeCeremony(tenantOf(request).db, body.ceremony, 'login');
    if (!taken) throw invalid();
    let userId: string;
    try {
      userId = await checkAssertion(
        request,
        taken.challenge,
        body.response as unknown as AuthenticationResponseJSON,
      );
    } catch (error) {
      await journal(request, {
        userId: null,
        kind: 'login_failed',
        details: { method: 'passkey' },
      });
      throw error;
    }
    return deps.finishLogin(request, reply, userId);
  });

  // ─── second step after the password ────────────────────────────────────────────────────

  app.post('/auth/mfa/passkey/options', async (request) => {
    const body = mfaOptionsBody.parse(request.body);
    const db = tenantOf(request).db;
    const userId = await challengeUser(db, body.challenge);
    const keys = userId === undefined ? [] : await passkeyRows(db, userId);
    if (userId === undefined || keys.length === 0) throw invalid();
    const generated = await generateAuthenticationOptions({
      rpID: party(request).rpID,
      userVerification: 'required',
      allowCredentials: keys.map((row) => ({ id: row.id, transports: row.transports as never })),
    });
    return {
      ceremony: await createCeremony(db, 'mfa', generated.challenge, userId),
      options: generated,
    };
  });

  app.post('/auth/mfa/passkey/verify', async (request, reply) => {
    const body = mfaVerifyBody.parse(request.body);
    const db = tenantOf(request).db;
    const userId = await challengeUser(db, body.challenge);
    const taken = await takeCeremony(db, body.ceremony, 'mfa');
    if (userId === undefined || !taken || taken.userId !== userId) throw invalid();
    try {
      await checkAssertion(
        request,
        taken.challenge,
        body.response as unknown as AuthenticationResponseJSON,
        userId,
      );
    } catch (error) {
      await failChallenge(db, body.challenge);
      await journal(request, { userId, kind: 'mfa_failed', details: { method: 'passkey' } });
      throw error;
    }
    await endChallenge(db, body.challenge);
    return deps.finishLogin(request, reply, userId);
  });
}
