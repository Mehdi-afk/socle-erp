// SPDX-License-Identifier: LGPL-3.0-only
import { randomBytes, randomUUID } from 'node:crypto';

import { exportPublicKey, generateSigningKeyPair, uuidv7 } from '@socle/crypto';
import {
  buildModelRegistry,
  buildSecurityPolicy,
  defineModel,
  f,
  type RegistrySnapshot,
} from '@socle/framework';
import { applySchema, createPgDatabase, verifyAudit, type Executor } from '@socle/orm-pg';
import { signDeviceStatus, signMutation } from '@socle/sync';
import { sql } from 'kysely';
import { afterEach, describe, expect, inject, it } from 'vitest';

import { buildServer, type ServerOptions } from './app.js';
import {
  createUser,
  csrfToken,
  hashPassword,
  readSessionCookie,
  requestPasswordReset,
  resetPassword,
  verifyPassword,
  type SessionPolicy,
} from './auth.js';
import { corsHeaders } from './headers.js';
import { createRateLimiter, takeToken } from './rate-limit.js';
import { createTenantDirectory, tenantFromHost, type TenantDirectory } from './tenants.js';
import { verifySecondFactor } from './mfa.js';
import { issueEmailCode, verifyEmailCode } from './mfa-email.js';
import { base32Decode, hotp, totpStep } from './totp.js';
import {
  virtualAuthenticator,
  type VirtualAuthenticator,
} from './virtual-authenticator.support.js';

/** The anti-CSRF header a browser client would send with this session cookie. */
const csrfHeader = (cookie: string): Record<string, string> => {
  const token = readSessionCookie(cookie);
  return token === undefined ? {} : { 'x-csrf-token': csrfToken(token) };
};

const C1 = '0190a000-0000-7000-8000-0000000000c1';
const C2 = '0190a000-0000-7000-8000-0000000000c2';
const FAST = { memoryKiB: 1024, passes: 1, parallelism: 1 };
const SESSION: SessionPolicy = {
  idleMs: 3_600_000,
  absoluteMs: 86_400_000,
  maxFailures: 2,
  cost: FAST,
};

const invoice = defineModel({
  name: 'srv.invoice',
  fields: {
    name: f.char({ required: true }),
    companyId: f.char(),
    margin: f.integer({ groups: ['srv.group_manager'] }),
  },
});
const registry = buildModelRegistry([{ module: 'srv', models: [invoice] }], { side: 'server' });
const security = buildSecurityPolicy(
  [
    {
      module: 'srv',
      groups: [
        { id: 'srv.group_user', name: { fr: 'Utilisateur' } },
        { id: 'srv.group_manager', name: { fr: 'Responsable' }, implies: ['srv.group_user'] },
      ],
      access: [
        {
          model: 'srv.invoice',
          group: 'srv.group_user',
          read: true,
          create: true,
          write: true,
          unlink: true,
        },
      ],
      rules: [
        {
          id: 'srv.invoice_company',
          model: 'srv.invoice',
          domain: [['companyId', 'in', { $user: 'companyIds' }]],
        },
      ],
    },
  ],
  (model) => registry.has(model),
);

// ─── pure parts ──────────────────────────────────────────────────────────────────────────

describe('building blocks', () => {
  it('rate-limits with a token bucket', () => {
    const policy = { capacity: 2, refillPerSecond: 1 };
    let state = takeToken(undefined, 0, policy);
    state = takeToken(state.bucket, 0, policy);
    const refused = takeToken(state.bucket, 0, policy);
    expect(refused).toMatchObject({ allowed: false, retryAfterMs: 1000 });
    expect(takeToken(refused.bucket, 1000, policy).allowed).toBe(true);
    const limiter = createRateLimiter(policy, 3);
    for (const key of ['a', 'b', 'c', 'd']) limiter.take(key);
    expect(limiter.size()).toBe(3);
  });

  it('resolves tenants from the subdomain only', () => {
    expect(tenantFromHost('acme.erp.test', 'erp.test')).toBe('acme');
    expect(tenantFromHost('ACME.erp.test:443', 'erp.test')).toBe('acme');
    for (const host of [
      undefined,
      'erp.test',
      'a.b.erp.test',
      'www.erp.test',
      'acme.evil.test',
      'ac--me.erp.test',
      '-x.erp.test',
      'acme.erp.test.evil.com',
    ]) {
      expect(tenantFromHost(host, 'erp.test'), String(host)).toBeUndefined();
    }
  });

  it('allows only listed origins', () => {
    expect(corsHeaders(undefined, []).allowed).toBe(true);
    expect(corsHeaders('https://evil.test', ['https://acme.erp.test']).allowed).toBe(false);
    expect(corsHeaders('https://acme.erp.test', ['https://acme.erp.test']).headers).toMatchObject({
      'access-control-allow-origin': 'https://acme.erp.test',
      vary: 'Origin',
    });
  });

  it('hashes passwords with Argon2id', async () => {
    const hash = await hashPassword('correct horse', FAST);
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,p=1\$/);
    expect(await verifyPassword(hash, 'correct horse')).toBe(true);
    expect(await verifyPassword(hash, 'Correct horse')).toBe(false);
    expect(await verifyPassword('$argon2id$garbage', 'x')).toBe(false);
    expect(await hashPassword('same', FAST)).not.toBe(await hashPassword('same', FAST));
    expect(readSessionCookie('a=1; __Host-socle_session=abc; b=2')).toBe('abc');
  });
});

// ─── the server over HTTP ────────────────────────────────────────────────────────────────

const pools: Executor[] = [];
const directories: TenantDirectory[] = [];
const apps: ReturnType<typeof buildServer>[] = [];
// Fixtures belong to one test; retaining their pools until the suite ends can exhaust PostgreSQL.
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0)) await directory.close();
  for (const pool of pools.splice(0)) await pool.destroy();
});

async function server(overrides: Partial<ServerOptions> = {}) {
  const base = inject('pgUrl');
  const name = `srv_${randomUUID().replaceAll('-', '')}`;
  const admin = createPgDatabase({ connectionString: base, max: 1 });
  pools.push(admin);
  await sql`create database ${sql.id(name)}`.execute(admin);
  const url = new URL(base);
  url.pathname = `/${name}`;
  const db = createPgDatabase({ connectionString: url.toString(), max: 2 });
  pools.push(db);
  await applySchema(db, registry, { security });
  await createUser(
    db,
    {
      id: 'alice',
      login: 'alice@acme.test',
      password: 'alice-pass',
      groupIds: ['srv.group_user'],
      companyIds: [C1],
      companyId: C1,
    },
    FAST,
  );
  await createUser(
    db,
    {
      id: 'bob',
      login: 'bob@acme.test',
      password: 'bob-pass',
      groupIds: ['srv.group_manager'],
      companyIds: [C1, C2],
      companyId: C1,
    },
    FAST,
  );
  const tenants = createTenantDirectory({
    resolve: (tenant) =>
      Promise.resolve(
        tenant === 'acme' ? { connectionString: url.toString(), registry, security } : undefined,
      ),
  });
  directories.push(tenants);
  const app = buildServer({
    baseDomain: 'erp.test',
    tenants,
    session: SESSION,
    logger: false,
    ...overrides,
  });
  apps.push(app);
  const request = (
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    options: {
      body?: unknown;
      cookie?: string;
      headers?: Record<string, string>;
      host?: string;
    } = {},
  ) =>
    app.inject({
      method,
      url: path,
      headers: {
        host: options.host ?? 'acme.erp.test',
        ...(options.cookie ? { cookie: options.cookie, ...csrfHeader(options.cookie) } : {}),
        ...(options.headers ?? {}),
      },
      ...(options.body === undefined ? {} : { payload: options.body as Record<string, unknown> }),
    });
  const signIn = async (loginName: string, password: string): Promise<string> => {
    const response = await request('POST', '/auth/login', { body: { login: loginName, password } });
    expect(response.statusCode).toBe(200);
    return String(response.headers['set-cookie']).split(';')[0] as string;
  };
  return { app, db, request, signIn };
}

describe('HTTP server', () => {
  it('returns an empty public provider list when OIDC is not configured', async () => {
    const { request } = await server();
    const response = await request('GET', '/auth/oidc/providers');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ providers: [] });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect((await request('GET', '/auth/session')).statusCode).toBe(401);
    expect((await request('GET', '/auth/oidc/unknown/start')).statusCode).toBe(404);
    expect(
      (await request('GET', '/auth/oidc/providers', { host: 'other.erp.test' })).statusCode,
    ).toBe(404);
    expect(
      (await request('GET', '/auth/oidc/providers', { headers: { origin: 'https://evil.test' } }))
        .statusCode,
    ).toBe(403);
  });

  it('sends security headers, resolves tenants and applies CORS', async () => {
    const { request } = await server();
    const response = await request('POST', '/auth/login', { body: { login: 'x', password: 'y' } });
    expect(response.headers).toMatchObject({
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect((await request('GET', '/sync/pull', { host: 'other.erp.test' })).statusCode).toBe(404);
    expect((await request('GET', '/sync/pull', { host: 'erp.test' })).statusCode).toBe(404);
    expect(
      (await request('GET', '/sync/pull', { headers: { origin: 'https://evil.test' } })).statusCode,
    ).toBe(403);
    const preflight = await request('POST', '/rpc/srv.invoice/search', {
      headers: { origin: 'https://acme.erp.test' },
    });
    expect(preflight.headers['access-control-allow-origin']).toBe('https://acme.erp.test');
  });

  it('rate-limits requests', async () => {
    const { request } = await server({ rateLimit: { capacity: 3, refillPerSecond: 0.01 } });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await request('GET', '/sync/pull')).statusCode);
    expect(codes).toEqual([401, 401, 401, 429]);
  });

  it('validates a metadata request before authentication and requires session CSRF without caching', async () => {
    const { request, signIn } = await server();
    expect((await request('POST', '/web/metadata', { body: { userId: 'bob' } })).statusCode).toBe(
      400,
    );
    expect((await request('POST', '/web/metadata', { body: {} })).statusCode).toBe(401);
    const cookie = await signIn('alice@acme.test', 'alice-pass');
    expect((await request('POST', '/web/metadata', { cookie, body: null })).statusCode).toBe(400);
    const missingCsrf = await request('POST', '/web/metadata', {
      cookie,
      body: {},
      headers: { 'x-csrf-token': '' },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json()).toMatchObject({ error: 'csrf' });
    const response = await request('POST', '/web/metadata', { cookie, body: {} });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const snapshot = response.json<RegistrySnapshot>();
    expect(snapshot).toMatchObject({ version: 1, userId: 'alice', companyId: C1, views: [] });
    expect(
      snapshot.models
        .find((model) => model.name === 'srv.invoice')
        ?.fields.map((field) => field.name),
    ).not.toContain('margin');
  });

  it('authenticates with sessions, the same error for every failure and a lock-out', async () => {
    const { request, signIn } = await server();
    const wrong = await request('POST', '/auth/login', {
      body: { login: 'alice@acme.test', password: 'nope' },
    });
    const unknown = await request('POST', '/auth/login', {
      body: { login: 'ghost@acme.test', password: 'nope' },
    });
    expect([wrong.statusCode, unknown.statusCode]).toEqual([401, 401]);
    expect(wrong.json()).toEqual(unknown.json());

    const cookie = await signIn('bob@acme.test', 'bob-pass');
    const raw = String(
      (
        await request('POST', '/auth/login', {
          body: { login: 'bob@acme.test', password: 'bob-pass' },
        })
      ).headers['set-cookie'],
    );
    expect(raw).toMatch(
      /^__Host-socle_session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=86400$/,
    );
    expect((await request('GET', '/sync/pull')).statusCode).toBe(401);
    expect((await request('GET', '/sync/pull', { cookie })).statusCode).toBe(200);
    await request('POST', '/auth/logout', { cookie });
    expect((await request('GET', '/sync/pull', { cookie })).statusCode).toBe(401);

    // Two failures lock the account: even the right password is refused for a while.
    await request('POST', '/auth/login', { body: { login: 'alice@acme.test', password: 'nope' } });
    expect(
      (
        await request('POST', '/auth/login', {
          body: { login: 'alice@acme.test', password: 'alice-pass' },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('re-hashes a password stored with weaker parameters at the next sign-in', async () => {
    const { db, signIn } = await server();
    await createUser(
      db,
      { id: 'carol', login: 'carol@acme.test', password: 'carol-pass-12', groupIds: [] },
      { memoryKiB: 512, passes: 1, parallelism: 1 },
    );
    const stored = async () =>
      (
        await sql<{
          password_hash: string;
        }>`select password_hash from socle_user where id = 'carol'`.execute(db)
      ).rows[0]?.password_hash as string;
    expect(await stored()).toContain('m=512,');
    await signIn('carol@acme.test', 'carol-pass-12');
    expect(await stored()).toContain('m=1024,');
    // The new hash still verifies.
    await signIn('carol@acme.test', 'carol-pass-12');
  });

  it('changes a password: policy, current password, other sessions revoked', async () => {
    const { request, signIn, db } = await server({
      passwordPolicy: {
        minLength: 12,
        breachCheck: (password) => Promise.resolve(password.startsWith('pwned') ? 9 : 0),
      },
      loginRateLimit: { capacity: 1000, refillPerSecond: 1000 },
    });
    const here = await signIn('bob@acme.test', 'bob-pass');
    const elsewhere = await signIn('bob@acme.test', 'bob-pass');
    const change = (current: string, next: string) =>
      request('POST', '/auth/password/change', { cookie: here, body: { current, next } });

    expect((await change('bob-pass', 'short')).json()).toMatchObject({ error: 'weak_password' });
    expect((await change('bob-pass', 'pwned-password-123')).json()).toMatchObject({
      error: 'weak_password',
    });
    const wrong = await change('not-my-password', 'a brand new password');
    expect([wrong.statusCode, wrong.json<{ error: string }>().error]).toEqual([
      403,
      'invalid_credentials',
    ]);
    // Validation comes before authentication; a valid body without a session is refused.
    expect((await request('POST', '/auth/password/change', { body: {} })).statusCode).toBe(400);
    expect(
      (
        await request('POST', '/auth/password/change', {
          body: { current: 'bob-pass', next: 'a brand new password' },
        })
      ).statusCode,
    ).toBe(401);

    const done = await change('bob-pass', 'a brand new password');
    expect(done.statusCode).toBe(200);
    // The changing session gets a new token; the old one and the other sessions are dead.
    const renewed = String(done.headers['set-cookie']).split(';')[0] as string;
    expect((await request('GET', '/sync/pull', { cookie: here })).statusCode).toBe(401);
    expect((await request('GET', '/sync/pull', { cookie: renewed })).statusCode).toBe(200);
    expect((await request('GET', '/sync/pull', { cookie: elsewhere })).statusCode).toBe(401);
    const old = await request('POST', '/auth/login', {
      body: { login: 'bob@acme.test', password: 'bob-pass' },
    });
    expect(old.statusCode).toBe(401);
    await signIn('bob@acme.test', 'a brand new password');
    expect(await verifyAudit(db)).toMatchObject({ ok: true });
    const kinds = await sql<{
      kind: string;
    }>`select kind from socle_audit where kind = 'password_changed'`.execute(db);
    expect(kinds.rows).toHaveLength(1);
  });

  it('resets a password with a single-use token that expires', async () => {
    const mails: { login: string; token: string; host: string }[] = [];
    const { request, signIn, db } = await server({
      passwordPolicy: { minLength: 12 },
      sendPasswordReset: (message) => {
        mails.push(message);
        return Promise.resolve();
      },
      loginRateLimit: { capacity: 1000, refillPerSecond: 1000 },
    });
    const forgot = (login: string) => request('POST', '/auth/password/forgot', { body: { login } });
    const reset = (token: string, password: string) =>
      request('POST', '/auth/password/reset', { body: { token, password } });

    // The answer is the same for a known and an unknown account; only the known one gets a mail.
    const known = await forgot('alice@acme.test');
    const unknown = await forgot('ghost@acme.test');
    expect([known.statusCode, known.json()]).toEqual([200, { ok: true }]);
    expect(unknown.json()).toEqual(known.json());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ login: 'alice@acme.test', host: 'acme.erp.test' });
    const first = (mails[0] as { token: string }).token;

    // A newer request cancels the older token.
    await forgot('alice@acme.test');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = (mails[1] as { token: string }).token;
    expect((await reset(first, 'a brand new password')).json()).toMatchObject({
      error: 'invalid_token',
    });

    const session = await signIn('alice@acme.test', 'alice-pass');
    expect((await reset(second, 'too short')).json()).toMatchObject({ error: 'weak_password' });
    expect((await reset(second, 'a brand new password')).statusCode).toBe(200);
    // Single use; every session of the account is revoked; the new password works.
    expect((await reset(second, 'another new password')).json()).toMatchObject({
      error: 'invalid_token',
    });
    expect((await request('GET', '/sync/pull', { cookie: session })).statusCode).toBe(401);
    await signIn('alice@acme.test', 'a brand new password');

    // Expired after 30 minutes; the table only holds a hash of the token.
    await forgot('alice@acme.test');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const late = (mails[2] as { token: string }).token;
    const stored = await sql<{
      token_hash: string;
    }>`select token_hash from socle_password_reset`.execute(db);
    expect(stored.rows.map((row) => row.token_hash)).not.toContain(late);
    await sql`update socle_password_reset set expires_at = now() - interval '1 minute'`.execute(db);
    expect((await reset(late, 'yet another password')).json()).toMatchObject({
      error: 'invalid_token',
    });
    expect((await reset('x'.repeat(43), 'yet another password')).statusCode).toBe(400);
  });

  it('refuses a modifying request without the anti-CSRF token of its own session', async () => {
    const { app, request, signIn } = await server();
    const alice = await signIn('alice@acme.test', 'alice-pass');
    const bob = await signIn('bob@acme.test', 'bob-pass');
    const bare = (headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: '/rpc/srv.invoice/searchCount',
        headers: { host: 'acme.erp.test', cookie: alice, ...headers },
        payload: {},
      });
    const refused = await bare({});
    expect([refused.statusCode, refused.json<{ error: string }>().error]).toEqual([403, 'csrf']);
    expect((await bare({ 'x-csrf-token': 'x'.repeat(43) })).statusCode).toBe(403);
    // The token of another session is no good: it is bound to the cookie.
    const others = csrfHeader(bob)['x-csrf-token'] as string;
    expect((await bare({ 'x-csrf-token': others })).statusCode).toBe(403);
    // A browser saying "cross-site" without an Origin is refused even with the token.
    expect((await bare({ ...csrfHeader(alice), 'sec-fetch-site': 'cross-site' })).statusCode).toBe(
      403,
    );
    expect((await bare({ ...csrfHeader(alice), 'sec-fetch-site': 'same-origin' })).statusCode).toBe(
      200,
    );
    // A foreign Origin is refused before anything else (CORS step).
    expect((await bare({ ...csrfHeader(alice), origin: 'https://evil.test' })).statusCode).toBe(
      403,
    );
    // Reading needs no token; nor do sign-in and sign-out.
    expect((await request('GET', '/sync/pull', { cookie: alice })).statusCode).toBe(200);
    const loggedIn = await request('POST', '/auth/login', {
      body: { login: 'alice@acme.test', password: 'alice-pass' },
      cookie: alice,
    });
    expect(loggedIn.statusCode).toBe(200);
    // The token comes with the login answer and with /auth/session, and they agree.
    const fresh = String(loggedIn.headers['set-cookie']).split(';')[0] as string;
    const session = await app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { host: 'acme.erp.test', cookie: fresh },
    });
    expect(session.json()).toMatchObject({
      userId: 'alice',
      csrfToken: loggedIn.json<{ csrfToken: string }>().csrfToken,
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/logout',
          headers: { host: 'acme.erp.test', cookie: fresh },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('lists, revokes and rotates sessions', async () => {
    const { request, signIn } = await server({
      passwordPolicy: { minLength: 12 },
      loginRateLimit: { capacity: 1000, refillPerSecond: 1000 },
    });
    const phone = String(
      (
        await request('POST', '/auth/login', {
          body: { login: 'bob@acme.test', password: 'bob-pass' },
          headers: { 'user-agent': 'Phone/1.0' },
        })
      ).headers['set-cookie'],
    ).split(';')[0] as string;
    const laptop = await signIn('bob@acme.test', 'bob-pass');
    const alice = await signIn('alice@acme.test', 'alice-pass');

    const listed = (await request('GET', '/auth/sessions', { cookie: laptop })).json<{
      sessions: { id: string; current: boolean; userAgent: string | null }[];
    }>().sessions;
    expect(listed).toHaveLength(2);
    expect(listed.filter((entry) => entry.current)).toHaveLength(1);
    const other = listed.find((entry) => !entry.current) as {
      id: string;
      userAgent: string | null;
    };
    expect(other.userAgent).toBe('Phone/1.0');
    // The list never shows a secret: ids are not session tokens.
    expect(JSON.stringify(listed)).not.toContain(phone.split('=')[1] as string);

    // Only the owner can revoke; an unknown or foreign id is a plain 404.
    expect(
      (await request('DELETE', `/auth/sessions/${other.id}`, { cookie: alice })).statusCode,
    ).toBe(404);
    expect(
      (await request('DELETE', '/auth/sessions/not-a-uuid', { cookie: laptop })).statusCode,
    ).toBe(400);
    expect(
      (await request('DELETE', `/auth/sessions/${other.id}`, { cookie: laptop })).statusCode,
    ).toBe(200);
    expect((await request('GET', '/sync/pull', { cookie: phone })).statusCode).toBe(401);
    expect(
      (await request('DELETE', `/auth/sessions/${other.id}`, { cookie: laptop })).statusCode,
    ).toBe(404);

    // A password change gives the session a new token; the old one is dead at once.
    const changed = await request('POST', '/auth/password/change', {
      cookie: laptop,
      body: { current: 'bob-pass', next: 'a brand new password' },
    });
    expect(changed.statusCode).toBe(200);
    expect((await request('GET', '/sync/pull', { cookie: laptop })).statusCode).toBe(401);
    const renewed = String(changed.headers['set-cookie']).split(';')[0] as string;
    expect(renewed).not.toBe(laptop);
    expect((await request('GET', '/sync/pull', { cookie: renewed })).statusCode).toBe(200);
    expect(changed.json<{ csrfToken: string }>().csrfToken).toBe(
      csrfHeader(renewed)['x-csrf-token'],
    );
    const after = await request('GET', '/auth/sessions', { cookie: renewed });
    expect(after.json<{ sessions: unknown[] }>().sessions).toHaveLength(1);
  });

  describe('second factor', () => {
    const key = Uint8Array.from(randomBytes(32));
    const options = (requiredGroups: string[] = []) => ({
      passwordPolicy: { minLength: 12 },
      loginRateLimit: { capacity: 1000, refillPerSecond: 1000 },
      mfa: { key, issuer: 'Test ERP', requiredGroups },
    });
    const now = () => totpStep(new Date());
    const codeOf = (secret: string, drift = 0) =>
      hotp(base32Decode(secret) as Uint8Array, now() + drift);

    async function prepare(overrides: Partial<ServerOptions> = {}) {
      const s = await server({ ...options(), ...overrides });
      const password = (login: string) => (login.startsWith('alice') ? 'alice-pass' : 'bob-pass');
      const attempt = (login: string) =>
        s.request('POST', '/auth/login', { body: { login, password: password(login) } });
      // A TOTP code works once per 30-second step: tests that sign in again forget the step.
      const forgetStep = () => sql`update socle_mfa_totp set last_step = 0`.execute(s.db);
      return { ...s, attempt, forgetStep };
    }

    it('enrols with an authenticator app, then asks for a code at sign-in', async () => {
      const { request, signIn, db, attempt, forgetStep } = await prepare();
      const cookie = await signIn('alice@acme.test', 'alice-pass');
      expect((await request('GET', '/auth/mfa', { cookie })).json()).toMatchObject({
        state: 'none',
        required: false,
      });

      const setup = await request('POST', '/auth/mfa/totp/setup', { cookie, body: {} });
      const { secret, uri } = setup.json<{ secret: string; uri: string }>();
      expect(uri).toContain('otpauth://totp/Test%20ERP:alice%40acme.test');
      expect(uri).toContain(`secret=${secret}`);
      // The database never holds the secret in clear.
      const stored = await sql<{
        secret_enc: string;
      }>`select secret_enc from socle_mfa_totp`.execute(db);
      expect(stored.rows[0]?.secret_enc).not.toContain(secret);
      expect((await request('GET', '/auth/mfa', { cookie })).json()).toMatchObject({
        state: 'pending',
      });

      const wrong = await request('POST', '/auth/mfa/totp/confirm', {
        cookie,
        body: { code: codeOf(secret, 0) === '000000' ? '111111' : '000000' },
      });
      expect(wrong.statusCode).toBe(401);
      const confirmed = await request('POST', '/auth/mfa/totp/confirm', {
        cookie,
        body: { code: codeOf(secret) },
      });
      const { recoveryCodes } = confirmed.json<{ recoveryCodes: string[] }>();
      expect(recoveryCodes).toHaveLength(10);
      expect(new Set(recoveryCodes).size).toBe(10);
      for (const code of recoveryCodes) {
        expect(code.split('-')).toHaveLength(4);
        expect(code).toMatch(/^[A-Z2-7-]{19}$/);
      }
      const hashes = await sql<{
        code_hash: string;
      }>`select code_hash from socle_mfa_recovery`.execute(db);
      expect(hashes.rows).toHaveLength(10);
      expect(hashes.rows.map((row) => row.code_hash)).not.toContain(recoveryCodes[0]);
      expect((await request('POST', '/auth/mfa/totp/setup', { cookie, body: {} })).statusCode).toBe(
        409,
      );

      // Sign-in now stops at a challenge: no session, no cookie.
      await forgetStep();
      const first = await attempt('alice@acme.test');
      expect(first.headers['set-cookie']).toBeUndefined();
      const { mfa, challenge } = first.json<{ mfa: string; challenge: string }>();
      expect(mfa).toBe('verify');
      const verify = (body: Record<string, unknown>) =>
        request('POST', '/auth/mfa/verify', { body: { challenge, ...body } });
      expect((await verify({ code: '000000' })).statusCode).toBe(401);
      const done = await verify({ code: codeOf(secret) });
      expect(done.statusCode).toBe(200);
      const fresh = String(done.headers['set-cookie']).split(';')[0] as string;
      expect(done.json()).toHaveProperty('csrfToken');
      expect((await request('GET', '/sync/pull', { cookie: fresh })).statusCode).toBe(200);
      // A challenge is spent by success; the same code cannot be replayed in a new sign-in.
      expect((await verify({ code: codeOf(secret) })).statusCode).toBe(401);
      const again = (await attempt('alice@acme.test')).json<{ challenge: string }>();
      const replay = await request('POST', '/auth/mfa/verify', {
        body: { challenge: again.challenge, code: codeOf(secret) },
      });
      expect(replay.statusCode).toBe(401);
      // …but the next step's code is fine (one step of drift is allowed).
      expect(
        (
          await request('POST', '/auth/mfa/verify', {
            body: { challenge: again.challenge, code: codeOf(secret, 1) },
          })
        ).statusCode,
      ).toBe(200);
      expect(await verifyAudit(db)).toMatchObject({ ok: true });
    });

    it('accepts a code once even when two requests race with it', async () => {
      const { request, signIn, db, forgetStep } = await prepare();
      const cookie = await signIn('alice@acme.test', 'alice-pass');
      const { secret } = (
        await request('POST', '/auth/mfa/totp/setup', { cookie, body: {} })
      ).json<{ secret: string }>();
      await request('POST', '/auth/mfa/totp/confirm', { cookie, body: { code: codeOf(secret) } });
      await forgetStep();
      const code = codeOf(secret);
      const mfa = { key };
      const results = await Promise.all([
        verifySecondFactor(db, mfa, 'alice', { code }),
        verifySecondFactor(db, mfa, 'alice', { code }),
        verifySecondFactor(db, mfa, 'alice', { code }),
      ]);
      expect(results.filter((kind) => kind === 'totp')).toHaveLength(1);
    });

    it('limits the attempts of a challenge and lets it expire', async () => {
      const { request, signIn, attempt, forgetStep, db } = await prepare();
      const cookie = await signIn('alice@acme.test', 'alice-pass');
      const { secret } = (
        await request('POST', '/auth/mfa/totp/setup', { cookie, body: {} })
      ).json<{ secret: string }>();
      await request('POST', '/auth/mfa/totp/confirm', { cookie, body: { code: codeOf(secret) } });
      await forgetStep();

      const { challenge } = (await attempt('alice@acme.test')).json<{ challenge: string }>();
      for (let i = 0; i < 5; i++) {
        const bad = await request('POST', '/auth/mfa/verify', {
          body: { challenge, code: '000000' },
        });
        expect(bad.statusCode).toBe(401);
      }
      // Exhausted: even the right code is refused now, with the same answer.
      const late = await request('POST', '/auth/mfa/verify', {
        body: { challenge, code: codeOf(secret) },
      });
      expect([late.statusCode, late.json<{ error: string }>().error]).toEqual([
        401,
        'invalid_code',
      ]);

      const second = (await attempt('alice@acme.test')).json<{ challenge: string }>();
      await sql`update socle_mfa_challenge set expires_at = now() - interval '1 second'`.execute(
        db,
      );
      const expired = await request('POST', '/auth/mfa/verify', {
        body: { challenge: second.challenge, code: codeOf(secret) },
      });
      expect(expired.statusCode).toBe(401);
      expect(
        (
          await request('POST', '/auth/mfa/verify', {
            body: { challenge: 'x'.repeat(43), code: '123456' },
          })
        ).statusCode,
      ).toBe(401);
    });

    it('lets a recovery code in once, and only the authenticator makes new ones', async () => {
      const { request, signIn, attempt, forgetStep } = await prepare();
      const cookie = await signIn('alice@acme.test', 'alice-pass');
      const { secret } = (
        await request('POST', '/auth/mfa/totp/setup', { cookie, body: {} })
      ).json<{ secret: string }>();
      const { recoveryCodes } = (
        await request('POST', '/auth/mfa/totp/confirm', { cookie, body: { code: codeOf(secret) } })
      ).json<{ recoveryCodes: string[] }>();
      const recovery = recoveryCodes[0] as string;

      const viaRecovery = async (code: string) => {
        const { challenge } = (await attempt('alice@acme.test')).json<{ challenge: string }>();
        return request('POST', '/auth/mfa/verify', { body: { challenge, recovery: code } });
      };
      // Written in lower case and without dashes: still the same code.
      expect((await viaRecovery(recovery.replaceAll('-', '').toLowerCase())).statusCode).toBe(200);
      expect((await viaRecovery(recovery)).statusCode).toBe(401);
      expect((await viaRecovery('AAAA-AAAA-AAAA-AAAA')).statusCode).toBe(401);

      const session = await signIn2(request, attempt, recoveryCodes[1] as string);
      const left = await request('GET', '/auth/mfa', { cookie: session });
      expect(left.json()).toMatchObject({ recoveryCodesLeft: 8 });
      await forgetStep();
      const regenerated = await request('POST', '/auth/mfa/recovery/regenerate', {
        cookie: session,
        body: { code: codeOf(secret) },
      });
      const fresh = regenerated.json<{ recoveryCodes: string[] }>().recoveryCodes;
      expect(fresh).toHaveLength(10);
      // The old codes are gone.
      expect((await viaRecovery(recoveryCodes[2] as string)).statusCode).toBe(401);
      expect((await viaRecovery(fresh[0] as string)).statusCode).toBe(200);
      expect(
        (
          await request('POST', '/auth/mfa/recovery/regenerate', {
            cookie: session,
            body: { code: '000000' },
          })
        ).statusCode,
      ).toBe(401);
    });

    async function signIn2(
      request: Awaited<ReturnType<typeof prepare>>['request'],
      attempt: (login: string) => ReturnType<Awaited<ReturnType<typeof prepare>>['request']>,
      recovery: string,
    ): Promise<string> {
      const { challenge } = (await attempt('alice@acme.test')).json<{ challenge: string }>();
      const done = await request('POST', '/auth/mfa/verify', { body: { challenge, recovery } });
      return String(done.headers['set-cookie']).split(';')[0] as string;
    }

    it('turns the second factor off only with the password and a code, never for a required role', async () => {
      const { request, signIn, forgetStep } = await prepare();
      const cookie = await signIn('alice@acme.test', 'alice-pass');
      const { secret } = (
        await request('POST', '/auth/mfa/totp/setup', { cookie, body: {} })
      ).json<{ secret: string }>();
      await request('POST', '/auth/mfa/totp/confirm', { cookie, body: { code: codeOf(secret) } });
      await forgetStep();
      const disable = (password: string, code: string) =>
        request('POST', '/auth/mfa/totp/disable', { cookie, body: { password, code } });
      expect((await disable('wrong password', codeOf(secret))).statusCode).toBe(403);
      expect((await disable('alice-pass', '000000')).statusCode).toBe(403);
      expect((await disable('alice-pass', codeOf(secret))).statusCode).toBe(200);
      expect((await request('GET', '/auth/mfa', { cookie })).json()).toMatchObject({
        state: 'none',
      });
      // Back to a password-only sign-in.
      const plain = await request('POST', '/auth/login', {
        body: { login: 'alice@acme.test', password: 'alice-pass' },
      });
      expect(plain.headers['set-cookie']).toBeDefined();
    });

    describe('codes by email', () => {
      const wait = () => new Promise((resolve) => setTimeout(resolve, 30));
      async function withMail(requiredGroups: string[] = []) {
        const mails: { login: string; code: string; host: string }[] = [];
        const s = await prepare({
          mfa: {
            key,
            requiredGroups,
            sendCode: (message) => {
              mails.push(message);
              return Promise.resolve();
            },
          },
        });
        const lastCode = async () => {
          await wait();
          return (mails.at(-1) as { code: string }).code;
        };
        const verifyMail = (challenge: string, emailCode: string) =>
          s.request('POST', '/auth/mfa/verify', { body: { challenge, emailCode } });
        const send = (challenge: string) =>
          s.request('POST', '/auth/mfa/email/send', { body: { challenge } });
        return { ...s, mails, lastCode, verifyMail, send };
      }

      it('turns on with a first code, then signs in with a code sent by email', async () => {
        const { request, signIn, db, mails, lastCode, attempt, verifyMail, send } =
          await withMail();
        const cookie = await signIn('alice@acme.test', 'alice-pass');
        expect((await request('GET', '/auth/mfa', { cookie })).json()).toMatchObject({
          methods: { totp: false, email: false },
          emailAvailable: true,
        });
        expect(
          (await request('POST', '/auth/mfa/email/enable', { cookie, body: {} })).statusCode,
        ).toBe(200);
        const first = await lastCode();
        expect(mails[0]).toMatchObject({ login: 'alice@acme.test', host: 'acme.erp.test' });
        expect(first).toMatch(/^\d{6}$/);
        // Not on yet, and the database holds a keyed hash, not the code.
        expect((await request('GET', '/auth/mfa', { cookie })).json()).toMatchObject({
          methods: { email: false },
        });
        const stored = await sql<{
          code_hash: string;
        }>`select code_hash from socle_mfa_email_otp`.execute(db);
        expect(stored.rows[0]?.code_hash).not.toContain(first);
        const wrong = first === '000000' ? '111111' : '000000';
        expect(
          (await request('POST', '/auth/mfa/email/confirm', { cookie, body: { code: wrong } }))
            .statusCode,
        ).toBe(401);
        expect(
          (await request('POST', '/auth/mfa/email/confirm', { cookie, body: { code: first } }))
            .statusCode,
        ).toBe(200);
        expect((await request('GET', '/auth/mfa', { cookie })).json()).toMatchObject({
          methods: { email: true },
        });
        expect(
          (await request('POST', '/auth/mfa/email/enable', { cookie, body: {} })).statusCode,
        ).toBe(409);

        // Sign-in: a challenge, no session; the client asks for the code.
        const login = await attempt('alice@acme.test');
        expect(login.headers['set-cookie']).toBeUndefined();
        const { mfa, methods, challenge } = login.json<{
          mfa: string;
          methods: string[];
          challenge: string;
        }>();
        expect([mfa, methods]).toEqual(['verify', ['email']]);
        expect((await send(challenge)).statusCode).toBe(200);
        const code = await lastCode();
        expect(mails).toHaveLength(2);
        expect(
          (await verifyMail(challenge, code === '000000' ? '111111' : '000000')).statusCode,
        ).toBe(401);
        const done = await verifyMail(challenge, code);
        expect(done.statusCode).toBe(200);
        expect(done.json()).toHaveProperty('csrfToken');
        const session = String(done.headers['set-cookie']).split(';')[0] as string;
        expect((await request('GET', '/sync/pull', { cookie: session })).statusCode).toBe(200);
        // A code works once, even on a new challenge.
        const again = (await attempt('alice@acme.test')).json<{ challenge: string }>();
        expect((await verifyMail(again.challenge, code)).statusCode).toBe(401);
        // At most one mail a minute: the second request sends nothing new.
        await send(again.challenge);
        await send(again.challenge);
        await wait();
        expect(mails).toHaveLength(3);
        expect(await verifyAudit(db)).toMatchObject({ ok: true });
      });

      it('allows 5 tries and 10 minutes, and refuses a code for another method', async () => {
        const { request, signIn, attempt, verifyMail, send, lastCode, db } = await withMail();
        const cookie = await signIn('alice@acme.test', 'alice-pass');
        await request('POST', '/auth/mfa/email/enable', { cookie, body: {} });
        await request('POST', '/auth/mfa/email/confirm', {
          cookie,
          body: { code: await lastCode() },
        });

        const { challenge } = (await attempt('alice@acme.test')).json<{ challenge: string }>();
        await send(challenge);
        const code = await lastCode();
        const bad = code === '000000' ? '111111' : '000000';
        // The account has no authenticator app: a TOTP code or a recovery code opens nothing.
        expect(
          (await request('POST', '/auth/mfa/verify', { body: { challenge, code: '123456' } }))
            .statusCode,
        ).toBe(401);
        expect(
          (
            await request('POST', '/auth/mfa/verify', {
              body: { challenge, recovery: 'AAAA-AAAA-AAAA-AAAA' },
            })
          ).statusCode,
        ).toBe(401);
        const fresh = (await attempt('alice@acme.test')).json<{ challenge: string }>();
        await send(fresh.challenge);
        const second = await lastCode();
        for (let i = 0; i < 5; i++)
          expect((await verifyMail(fresh.challenge, bad)).statusCode).toBe(401);
        // Five wrong tries kill the code: even the right one is refused now.
        expect((await verifyMail(fresh.challenge, second)).statusCode).toBe(401);

        // Expired after 10 minutes.
        await sql`delete from socle_mfa_email_otp`.execute(db);
        const third = (await attempt('alice@acme.test')).json<{ challenge: string }>();
        await send(third.challenge);
        const late = await lastCode();
        await sql`update socle_mfa_email_otp set expires_at = now() - interval '1 second'`.execute(
          db,
        );
        expect((await verifyMail(third.challenge, late)).statusCode).toBe(401);
        // And a body naming two methods is invalid.
        expect(
          (
            await request('POST', '/auth/mfa/verify', {
              body: { challenge, code: '123456', emailCode: '123456' },
            })
          ).statusCode,
        ).toBe(400);
      });

      it('counts its own five tries, apart from the challenge limit', async () => {
        const { db } = await withMail();
        const mfa = { key };
        const code = (await issueEmailCode(db, mfa, 'alice')) as string;
        const bad = code === '000000' ? '111111' : '000000';
        for (let i = 0; i < 5; i++)
          expect(await verifyEmailCode(db, mfa, 'alice', bad)).toBe(false);
        expect(await verifyEmailCode(db, mfa, 'alice', code)).toBe(false);
        // A new code (after the minute) starts again; a spent code cannot be used twice.
        await sql`update socle_mfa_email_otp set sent_at = now() - interval '2 minutes'`.execute(
          db,
        );
        const next = (await issueEmailCode(db, mfa, 'alice')) as string;
        expect(await verifyEmailCode(db, mfa, 'alice', next)).toBe(true);
        expect(await verifyEmailCode(db, mfa, 'alice', next)).toBe(false);
        expect(await verifyEmailCode(db, mfa, 'alice', '12345')).toBe(false);
      });

      it('cannot be added to an account that has a factor by a sign-in challenge alone', async () => {
        const { request, signIn, attempt, db, mails } = await withMail();
        const cookie = await signIn('alice@acme.test', 'alice-pass');
        const { secret } = (
          await request('POST', '/auth/mfa/totp/setup', { cookie, body: {} })
        ).json<{ secret: string }>();
        await request('POST', '/auth/mfa/totp/confirm', { cookie, body: { code: codeOf(secret) } });
        // Someone with the password and the mailbox, but not the authenticator app.
        const { challenge } = (await attempt('alice@acme.test')).json<{ challenge: string }>();
        const enable = await request('POST', '/auth/mfa/email/enable', { body: { challenge } });
        expect([enable.statusCode, enable.json<{ error: string }>().error]).toEqual([
          409,
          'mfa_enrolled',
        ]);
        expect(mails).toHaveLength(0);
        // Even with a code the mailbox really received, the method is not theirs to use.
        const code = (await issueEmailCode(db, { key }, 'alice')) as string;
        const confirm = await request('POST', '/auth/mfa/email/confirm', {
          body: { challenge, code },
        });
        expect(confirm.statusCode).toBe(409);
        const verify = await request('POST', '/auth/mfa/verify', {
          body: { challenge, emailCode: code },
        });
        expect(verify.statusCode).toBe(401);
      });

      it('accepts a code once when several requests race with it', async () => {
        const { request, signIn, db, lastCode } = await withMail();
        const cookie = await signIn('alice@acme.test', 'alice-pass');
        await request('POST', '/auth/mfa/email/enable', { cookie, body: {} });
        const code = await lastCode();
        const results = await Promise.all([
          verifyEmailCode(db, { key }, 'alice', code),
          verifyEmailCode(db, { key }, 'alice', code),
          verifyEmailCode(db, { key }, 'alice', code),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
      });

      it('offers it for enrolment to a role that requires a second factor, and keeps one factor', async () => {
        const { request, attempt, mails, lastCode } = await withMail(['srv.group_manager']);
        const first = await attempt('bob@acme.test');
        const { mfa, methods, challenge } = first.json<{
          mfa: string;
          methods: string[];
          challenge: string;
        }>();
        expect([mfa, methods]).toEqual(['enroll', ['totp', 'email']]);
        expect(first.headers['set-cookie']).toBeUndefined();
        await request('POST', '/auth/mfa/email/enable', { body: { challenge } });
        expect(mails).toHaveLength(1);
        expect(
          (
            await request('POST', '/auth/mfa/email/confirm', {
              body: { challenge, code: '00000a' },
            })
          ).statusCode,
        ).toBe(400);
        const done = await request('POST', '/auth/mfa/email/confirm', {
          body: { challenge, code: await lastCode() },
        });
        expect(done.statusCode).toBe(200);
        const cookie = String(done.headers['set-cookie']).split(';')[0] as string;
        expect((await request('GET', '/sync/pull', { cookie })).statusCode).toBe(200);
        // Its only factor cannot be turned off.
        const off = await request('POST', '/auth/mfa/email/disable', {
          cookie,
          body: { password: 'bob-pass' },
        });
        expect([off.statusCode, off.json<{ error: string }>().error]).toEqual([
          403,
          'mfa_required',
        ]);
      });

      it('is not offered without a mail sender, and turning it off needs the password', async () => {
        const plain = await prepare();
        const cookie = await plain.signIn('alice@acme.test', 'alice-pass');
        const refused = await plain.request('POST', '/auth/mfa/email/enable', { cookie, body: {} });
        expect([refused.statusCode, refused.json<{ error: string }>().error]).toEqual([
          409,
          'email_unavailable',
        ]);
        expect((await plain.request('GET', '/auth/mfa', { cookie })).json()).toMatchObject({
          emailAvailable: false,
        });

        const { request, signIn, lastCode } = await withMail();
        const session = await signIn('alice@acme.test', 'alice-pass');
        await request('POST', '/auth/mfa/email/enable', { cookie: session, body: {} });
        await request('POST', '/auth/mfa/email/confirm', {
          cookie: session,
          body: { code: await lastCode() },
        });
        const off = (password: string) =>
          request('POST', '/auth/mfa/email/disable', { cookie: session, body: { password } });
        expect((await off('wrong password')).statusCode).toBe(403);
        expect((await off('alice-pass')).statusCode).toBe(200);
        expect((await request('GET', '/auth/mfa', { cookie: session })).json()).toMatchObject({
          methods: { email: false },
        });
      });
    });

    it('forces enrolment before any session for a role that requires it', async () => {
      const { request, attempt, db } = await prepare(options(['srv.group_manager']));
      const first = await attempt('bob@acme.test');
      expect(first.headers['set-cookie']).toBeUndefined();
      const { mfa, challenge } = first.json<{ mfa: string; challenge: string }>();
      expect(mfa).toBe('enroll');

      // The challenge opens nothing but the enrolment; a stale cookie in the way does not matter.
      const stale = { cookie: `__Host-socle_session=${'a'.repeat(43)}` };
      expect((await request('GET', '/sync/pull', stale)).statusCode).toBe(401);
      expect(
        (await request('POST', '/auth/mfa/verify', { body: { challenge, code: '123456' } }))
          .statusCode,
      ).toBe(401);
      const setup = await request('POST', '/auth/mfa/totp/setup', {
        ...stale,
        body: { challenge },
      });
      const { secret } = setup.json<{ secret: string }>();
      expect(
        (await request('POST', '/auth/mfa/totp/confirm', { body: { challenge, code: '000000' } }))
          .statusCode,
      ).toBe(401);
      const done = await request('POST', '/auth/mfa/totp/confirm', {
        body: { challenge, code: codeOf(secret) },
      });
      expect(done.statusCode).toBe(200);
      expect(done.json<{ recoveryCodes: string[] }>().recoveryCodes).toHaveLength(10);
      const cookie = String(done.headers['set-cookie']).split(';')[0] as string;
      expect((await request('GET', '/sync/pull', { cookie })).statusCode).toBe(200);
      expect((await request('GET', '/auth/mfa', { cookie })).json()).toMatchObject({
        state: 'enrolled',
        required: true,
      });

      // Required: cannot be turned off.
      await sql`update socle_mfa_totp set last_step = 0`.execute(db);
      const off = await request('POST', '/auth/mfa/totp/disable', {
        cookie,
        body: { password: 'bob-pass', code: codeOf(secret) },
      });
      expect([off.statusCode, off.json<{ error: string }>().error]).toEqual([403, 'mfa_required']);
      // A user outside the required group keeps signing in with the password alone.
      expect((await attempt('alice@acme.test')).headers['set-cookie']).toBeDefined();
      const kinds = await sql<{ kind: string }>`select distinct kind from socle_audit`.execute(db);
      expect(kinds.rows.map((row) => row.kind)).toEqual(
        expect.arrayContaining(['mfa_enabled', 'login']),
      );
      expect(await verifyAudit(db)).toMatchObject({ ok: true });
    });
  });

  describe('passkeys', () => {
    const RP = { id: 'acme.erp.test', origin: 'https://acme.erp.test' };
    const key = Uint8Array.from(randomBytes(32));

    async function withPasskeys(overrides: Partial<ServerOptions> = {}) {
      const s = await server({
        passkeys: {},
        passwordPolicy: { minLength: 12 },
        loginRateLimit: { capacity: 1000, refillPerSecond: 1000 },
        ...overrides,
      });
      type Options = { ceremony: string; options: { challenge: string } };
      const register = async (
        cookie: string,
        authenticator: VirtualAuthenticator,
        tweaks: Parameters<VirtualAuthenticator['create']>[2] = {},
        password = 'alice-pass',
        name?: string,
      ) => {
        const start = await s.request('POST', '/auth/passkeys/register/options', {
          cookie,
          body: { password },
        });
        if (start.statusCode !== 200) return start;
        const { ceremony, options } = start.json<Options>();
        return s.request('POST', '/auth/passkeys/register/verify', {
          cookie,
          body: {
            ceremony,
            ...(name === undefined ? {} : { name }),
            response: authenticator.create(options, RP, tweaks),
          },
        });
      };
      const options = async (path: string, body: Record<string, unknown> = {}) =>
        (await s.request('POST', path, { body })).json<Options>();
      const passkeyLogin = async (
        authenticator: VirtualAuthenticator,
        userHandle: string,
        tweaks: Parameters<VirtualAuthenticator['get']>[3] = {},
      ) => {
        const { ceremony, options: o } = await options('/auth/passkeys/login/options');
        const response = authenticator.get(o, RP, userHandle, tweaks);
        return {
          ceremony,
          response,
          options: o,
          answer: () =>
            s.request('POST', '/auth/passkeys/login/verify', { body: { ceremony, response } }),
        };
      };
      return { ...s, register, options, passkeyLogin };
    }

    it('registers a passkey, lists it without its key, and refuses duplicates and a wrong password', async () => {
      const { request, signIn, register, db } = await withPasskeys();
      const cookie = await signIn('alice@acme.test', 'alice-pass');
      const phone = virtualAuthenticator();

      const wrong = await register(cookie, phone, {}, 'not my password');
      expect(wrong.statusCode).toBe(403);
      const start = await request('POST', '/auth/passkeys/register/options', {
        cookie,
        body: { password: 'alice-pass' },
      });
      const { options } = start.json<{
        options: {
          rp: { id: string };
          authenticatorSelection: { userVerification: string; residentKey: string };
          user: { name: string };
        };
      }>();
      expect(options.rp.id).toBe('acme.erp.test');
      expect(options.authenticatorSelection).toMatchObject({
        userVerification: 'required',
        residentKey: 'required',
      });
      expect(options.user.name).toBe('alice@acme.test');

      expect((await register(cookie, phone, {}, 'alice-pass', 'Alice phone')).statusCode).toBe(200);
      const listed = await request('GET', '/auth/passkeys', { cookie });
      expect(listed.json<{ passkeys: { id: string; name: string }[] }>().passkeys).toMatchObject([
        { id: phone.id, name: 'Alice phone' },
      ]);
      expect(listed.body).not.toContain('publicKey');
      expect(listed.body).not.toContain('public_key');
      // The same credential twice is refused.
      expect((await register(cookie, phone)).statusCode).toBe(409);
      // Without a session there is nothing to register on; one bad answer is not stored.
      expect(
        (await request('POST', '/auth/passkeys/register/options', { body: { password: 'x' } }))
          .statusCode,
      ).toBe(401);
      const other = virtualAuthenticator();
      for (const bad of [
        { origin: 'https://evil.test' },
        { rpId: 'evil.test' },
        { userVerified: false },
      ]) {
        expect((await register(cookie, other, bad)).statusCode, JSON.stringify(bad)).toBe(400);
      }
      const count = await sql<{ n: string }>`select count(*) as n from socle_passkey`.execute(db);
      expect(Number(count.rows[0]?.n)).toBe(1);
    });

    it('signs in with a passkey alone and refuses every forgery', async () => {
      const { request, signIn, register, options, passkeyLogin, db } = await withPasskeys();
      const cookie = await signIn('alice@acme.test', 'alice-pass');
      const phone = virtualAuthenticator();
      await register(cookie, phone);

      const good = await passkeyLogin(phone, 'alice');
      const done = await good.answer();
      expect(done.statusCode).toBe(200);
      expect(done.json()).toHaveProperty('csrfToken');
      const session = String(done.headers['set-cookie']).split(';')[0] as string;
      expect((await request('GET', '/sync/pull', { cookie: session })).statusCode).toBe(200);

      // The same answer cannot be replayed: its ceremony is spent.
      expect((await good.answer()).statusCode).toBe(401);
      // Nor can a fresh signature (counter up) over the same challenge use the spent ceremony.
      const resigned = phone.get(good.options, RP, 'alice');
      const reused = await request('POST', '/auth/passkeys/login/verify', {
        body: { ceremony: good.ceremony, response: resigned },
      });
      expect(reused.statusCode).toBe(401);
      // A signature made for another challenge, another site, another party, or without user
      // verification is refused, and so is a counter that does not go up.
      const forged: [string, Parameters<VirtualAuthenticator['get']>[3]][] = [
        ['origin', { origin: 'https://evil.test' }],
        ['party', { rpId: 'evil.test' }],
        ['no verification', { userVerified: false }],
        ['counter back', { counter: 1 }],
      ];
      for (const [label, tweak] of forged) {
        expect((await (await passkeyLogin(phone, 'alice', tweak)).answer()).statusCode, label).toBe(
          401,
        );
      }
      const first = await options('/auth/passkeys/login/options');
      const second = await options('/auth/passkeys/login/options');
      const crossed = phone.get(first.options, RP, 'alice');
      expect(
        (
          await request('POST', '/auth/passkeys/login/verify', {
            body: { ceremony: second.ceremony, response: crossed },
          })
        ).statusCode,
      ).toBe(401);
      // An unknown passkey, and a ceremony of another kind, open nothing.
      expect(
        (await (await passkeyLogin(virtualAuthenticator(), 'alice')).answer()).statusCode,
      ).toBe(401);
      const mfaKind = await options('/auth/passkeys/login/options');
      expect(
        (
          await request('POST', '/auth/mfa/passkey/verify', {
            body: {
              challenge: 'x'.repeat(43),
              ceremony: mfaKind.ceremony,
              response: phone.get(mfaKind.options, RP, 'alice'),
            },
          })
        ).statusCode,
      ).toBe(401);

      // A disabled account cannot sign in with its passkey.
      await sql`update socle_user set active = false where id = 'alice'`.execute(db);
      expect((await (await passkeyLogin(phone, 'alice')).answer()).statusCode).toBe(401);
      expect(await verifyAudit(db)).toMatchObject({ ok: true });
    });

    it('lets only one of two simultaneous answers with the same counter through', async () => {
      const { signIn, register, passkeyLogin } = await withPasskeys();
      const cookie = await signIn('alice@acme.test', 'alice-pass');
      const phone = virtualAuthenticator();
      await register(cookie, phone);
      // Two genuine ceremonies answered by a cloned key that reports the same counter.
      const [a, b] = await Promise.all([
        passkeyLogin(phone, 'alice', { counter: 7 }),
        passkeyLogin(phone, 'alice', { counter: 7 }),
      ]);
      const codes = (await Promise.all([a.answer(), b.answer()])).map((r) => r.statusCode).sort();
      expect(codes).toEqual([200, 401]);
    });

    it('serves as the second step after the password, for that account only', async () => {
      const { request, signIn, register, options, db } = await withPasskeys(
        (() => {
          const mfa = { key, requiredGroups: [] as string[] };
          return { mfa, passkeys: { mfa } };
        })(),
      );
      const cookie = await signIn('alice@acme.test', 'alice-pass');
      const bobCookie = await signIn('bob@acme.test', 'bob-pass');
      const phone = virtualAuthenticator();
      const bobs = virtualAuthenticator();
      await register(cookie, phone);
      await register(bobCookie, bobs, {}, 'bob-pass');

      const login = await request('POST', '/auth/login', {
        body: { login: 'alice@acme.test', password: 'alice-pass' },
      });
      expect(login.headers['set-cookie']).toBeUndefined();
      const { challenge, methods } = login.json<{ challenge: string; methods: string[] }>();
      expect(methods).toEqual(['passkey']);

      const start = await options('/auth/mfa/passkey/options', { challenge });
      // Bob's passkey does not open Alice's challenge.
      const wrong = await request('POST', '/auth/mfa/passkey/verify', {
        body: { challenge, ceremony: start.ceremony, response: bobs.get(start.options, RP, 'bob') },
      });
      expect(wrong.statusCode).toBe(401);
      const again = await options('/auth/mfa/passkey/options', { challenge });
      const ok = await request('POST', '/auth/mfa/passkey/verify', {
        body: {
          challenge,
          ceremony: again.ceremony,
          response: phone.get(again.options, RP, 'alice'),
        },
      });
      expect(ok.statusCode).toBe(200);
      const session = String(ok.headers['set-cookie']).split(';')[0] as string;
      expect((await request('GET', '/sync/pull', { cookie: session })).statusCode).toBe(200);
      // The challenge is spent by success.
      const spent = await options('/auth/mfa/passkey/options', { challenge }).catch(
        () => undefined,
      );
      expect(spent?.ceremony).toBeUndefined();
      expect(await verifyAudit(db)).toMatchObject({ ok: true });
    });

    it('lets a role that requires a second factor enrol a passkey first, and keep one', async () => {
      const mfa = { key, requiredGroups: ['srv.group_manager'] };
      const { request, options, db } = await withPasskeys({ mfa, passkeys: { mfa } });
      const login = await request('POST', '/auth/login', {
        body: { login: 'bob@acme.test', password: 'bob-pass' },
      });
      const {
        mfa: state,
        methods,
        challenge,
      } = login.json<{
        mfa: string;
        methods: string[];
        challenge: string;
      }>();
      expect([state, methods]).toEqual(['enroll', ['totp', 'passkey']]);
      expect(login.headers['set-cookie']).toBeUndefined();

      const phone = virtualAuthenticator();
      const start = await options('/auth/passkeys/register/options', { challenge });
      // A stale cookie in the way does not matter: the challenge is the proof.
      const done = await request('POST', '/auth/passkeys/register/verify', {
        cookie: `__Host-socle_session=${'a'.repeat(43)}`,
        body: { ceremony: start.ceremony, challenge, response: phone.create(start.options, RP) },
      });
      expect(done.statusCode).toBe(200);
      const cookie = String(done.headers['set-cookie']).split(';')[0] as string;
      expect((await request('GET', '/sync/pull', { cookie })).statusCode).toBe(200);

      // Its only factor cannot be removed; an account with one cannot add another by challenge.
      const removed = await request('DELETE', `/auth/passkeys/${phone.id}`, { cookie });
      expect([removed.statusCode, removed.json<{ error: string }>().error]).toEqual([
        403,
        'mfa_required',
      ]);
      const next = (
        await request('POST', '/auth/login', {
          body: { login: 'bob@acme.test', password: 'bob-pass' },
        })
      ).json<{ challenge: string }>();
      const downgrade = await request('POST', '/auth/passkeys/register/options', {
        body: { challenge: next.challenge },
      });
      expect(downgrade.statusCode).toBe(409);
      expect(await verifyAudit(db)).toMatchObject({ ok: true });
    });

    it('removes one of its own passkeys and nobody else’s', async () => {
      const { request, signIn, register, passkeyLogin } = await withPasskeys();
      const alice = await signIn('alice@acme.test', 'alice-pass');
      const bob = await signIn('bob@acme.test', 'bob-pass');
      const phone = virtualAuthenticator();
      await register(alice, phone);
      expect(
        (await request('DELETE', `/auth/passkeys/${phone.id}`, { cookie: bob })).statusCode,
      ).toBe(404);
      expect(
        (await request('DELETE', `/auth/passkeys/${phone.id}`, { cookie: alice })).statusCode,
      ).toBe(200);
      expect(
        (await request('DELETE', `/auth/passkeys/${phone.id}`, { cookie: alice })).statusCode,
      ).toBe(404);
      expect((await (await passkeyLogin(phone, 'alice')).answer()).statusCode).toBe(401);
    });
  });

  describe('devices', () => {
    async function withDevices() {
      const s = await server({ loginRateLimit: { capacity: 1000, refillPerSecond: 1000 } });
      const alice = await s.signIn('alice@acme.test', 'alice-pass');
      const bob = await s.signIn('bob@acme.test', 'bob-pass');
      const newDevice = async () => {
        const keys = await generateSigningKeyPair();
        return {
          keys,
          id: `dev-${randomBytes(6).toString('hex')}`,
          publicKey: await exportPublicKey(keys.publicKey),
        };
      };
      const register = (cookie: string, device: { id: string; publicKey: string }, name?: string) =>
        s.request('POST', '/sync/devices', {
          cookie,
          body: { id: device.id, publicKey: device.publicKey, ...(name ? { name } : {}) },
        });
      const proofRequest = async (
        device: { id: string; keys: { privateKey: never } },
        overrides: { timestamp?: number; signature?: string } = {},
        cookie?: string,
      ) => {
        const proof = await signDeviceStatus(device.keys.privateKey, device.id);
        return s.request('POST', `/sync/devices/${device.id}/status`, {
          ...(cookie ? { cookie } : {}),
          body: { ...proof, ...overrides },
        });
      };
      return { ...s, alice, bob, newDevice, register, proofRequest };
    }

    it('registers and lists a device with its name, never showing its key', async () => {
      const { request, register, newDevice, alice, db } = await withDevices();
      const phone = await newDevice();
      expect((await register(alice, phone, "Alice's phone")).statusCode).toBe(200);
      const listed = await request('GET', '/sync/devices', { cookie: alice });
      expect(
        listed.json<{ devices: { id: string; name: string; status: string }[] }>().devices,
      ).toMatchObject([{ id: phone.id, name: "Alice's phone", status: 'active' }]);
      expect(listed.body).not.toContain(phone.publicKey);
      // The session is tied to the device.
      const tied = await sql<{
        device_id: string;
      }>`select device_id from socle_session where device_id is not null`.execute(db);
      expect(tied.rows).toEqual([{ device_id: phone.id }]);
      // The registration is journaled.
      const kinds = await sql<{
        kind: string;
      }>`select kind from socle_audit where kind = 'device_registered'`.execute(db);
      expect(kinds.rows).toHaveLength(1);
    });

    it('recognises the same device on a new sign-in and refuses anyone else’s id or key', async () => {
      const { request, register, newDevice, alice, bob, signIn, db } = await withDevices();
      const phone = await newDevice();
      await register(alice, phone);
      // Another user, or the same user with another key, cannot take the id.
      const taken = await register(bob, phone);
      expect([taken.statusCode, taken.json<{ error: string }>().error]).toEqual([
        409,
        'device_exists',
      ]);
      const swapped = await register(alice, {
        id: phone.id,
        publicKey: (await newDevice()).publicKey,
      });
      expect(swapped.statusCode).toBe(409);
      // Signing in again on the same phone attaches the new session to it.
      const second = await signIn('alice@acme.test', 'alice-pass');
      expect((await register(second, phone)).statusCode).toBe(200);
      const tied = await sql<{
        n: string;
      }>`select count(*) as n from socle_session where device_id = ${phone.id}`.execute(db);
      expect(Number(tied.rows[0]?.n)).toBe(2);
      expect(
        (await request('GET', '/sync/devices', { cookie: second })).json<{ devices: unknown[] }>()
          .devices,
      ).toHaveLength(1);
    });

    it('shows a user only their own devices', async () => {
      const { request, register, newDevice, alice, bob } = await withDevices();
      const phone = await newDevice();
      await register(alice, phone);
      expect((await request('GET', `/sync/devices/${phone.id}`, { cookie: alice })).json()).toEqual(
        { status: 'active' },
      );
      expect((await request('GET', `/sync/devices/${phone.id}`, { cookie: bob })).json()).toEqual({
        status: 'unknown',
      });
      expect((await request('GET', '/sync/devices', { cookie: bob })).json()).toEqual({
        devices: [],
      });
    });

    it('lets a device prove its status without a session, and never mistakes a bad proof for "unknown"', async () => {
      const { request, register, newDevice, alice, proofRequest } = await withDevices();
      const phone = await newDevice();
      await register(alice, phone);
      const ok = await proofRequest(phone as never);
      expect([ok.statusCode, ok.json()]).toEqual([200, { status: 'active' }]);
      // A stale cookie in the way (an expired session) does not get in the way of the proof.
      expect(
        (await proofRequest(phone as never, {}, `__Host-socle_session=${'a'.repeat(43)}`))
          .statusCode,
      ).toBe(200);
      // Wrong signature, stale or altered timestamp: 401, an answer that never means "wipe".
      const stranger = await newDevice();
      const forged = await signDeviceStatus(stranger.keys.privateKey, phone.id);
      for (const bad of [
        forged,
        {
          timestamp: Date.now() - 3_600_000,
          signature: (
            await signDeviceStatus(phone.keys.privateKey, phone.id, Date.now() - 3_600_000)
          ).signature,
        },
        {
          timestamp: Date.now() + 1,
          signature: (await signDeviceStatus(phone.keys.privateKey, phone.id)).signature,
        },
      ]) {
        const answer = await proofRequest(phone as never, bad);
        expect([answer.statusCode, answer.json<{ error: string }>().error]).toEqual([
          401,
          'invalid_proof',
        ]);
      }
      // A device the server does not know is "unknown" (it wipes), and junk is refused.
      const ghost = await newDevice();
      expect((await proofRequest(ghost as never)).json()).toEqual({ status: 'unknown' });
      expect(
        (
          await request('POST', '/sync/devices/bad!id/status', {
            body: { timestamp: 1, signature: 'x' },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await request('POST', `/sync/devices/${phone.id}/status`, {
            body: { timestamp: 'now', signature: 'x' },
          })
        ).statusCode,
      ).toBe(400);
    });

    it('revokes a device: pushes refused, its sessions cut, remote wipe signal, other sessions kept', async () => {
      const { request, register, newDevice, alice, bob, signIn, proofRequest, db } =
        await withDevices();
      const phone = await newDevice();
      const laptop = await newDevice();
      await register(alice, phone);
      const onPhone = alice;
      const onLaptop = await signIn('alice@acme.test', 'alice-pass');
      await register(onLaptop, laptop);
      const elsewhere = await signIn('alice@acme.test', 'alice-pass'); // a session of no device

      // Only the owner can revoke.
      expect(
        (await request('DELETE', `/sync/devices/${phone.id}`, { cookie: bob })).statusCode,
      ).toBe(404);
      expect(
        (await request('DELETE', '/sync/devices/bad!id', { cookie: onLaptop })).statusCode,
      ).toBe(400);
      expect(
        (await request('DELETE', `/sync/devices/${phone.id}`, { cookie: onLaptop })).statusCode,
      ).toBe(200);

      // The phone's session is dead, the laptop's and the unattached one are not.
      expect((await request('GET', '/sync/pull', { cookie: onPhone })).statusCode).toBe(401);
      expect((await request('GET', '/sync/pull', { cookie: onLaptop })).statusCode).toBe(200);
      expect((await request('GET', '/sync/pull', { cookie: elsewhere })).statusCode).toBe(200);
      // No session left, but the phone can still learn it must wipe, by signing.
      expect((await proofRequest(phone as never)).json()).toEqual({ status: 'revoked' });
      expect((await proofRequest(laptop as never)).json()).toEqual({ status: 'active' });
      const listed = (await request('GET', '/sync/devices', { cookie: onLaptop })).json<{
        devices: { id: string; status: string; revokedAt: string | null }[];
      }>().devices;
      expect(listed.map((d) => [d.id, d.status]).sort()).toEqual(
        [
          [laptop.id, 'active'],
          [phone.id, 'revoked'],
        ].sort(),
      );
      expect(listed.find((d) => d.id === phone.id)?.revokedAt).not.toBeNull();
      // A revoked device cannot come back with the same id.
      const again = await register(onLaptop, phone);
      expect([again.statusCode, again.json<{ error: string }>().error]).toEqual([
        403,
        'device_revoked',
      ]);
      const kinds = await sql<{
        kind: string;
      }>`select kind from socle_audit where kind = 'device_revoked'`.execute(db);
      expect(kinds.rows).toHaveLength(1);
      expect(await verifyAudit(db)).toMatchObject({ ok: true });
    });

    it('keeps the device link through a session rotation and caps the number of devices', async () => {
      const { request, register, newDevice, alice } = await withDevices();
      const phone = await newDevice();
      await register(alice, phone);
      // Rotation (a password change gives the session a new token): still the phone's session.
      const changed = await request('POST', '/auth/password/change', {
        cookie: alice,
        body: { current: 'alice-pass', next: 'a brand new password' },
      });
      const renewed = String(changed.headers['set-cookie']).split(';')[0] as string;
      expect(
        (await request('DELETE', `/sync/devices/${phone.id}`, { cookie: renewed })).statusCode,
      ).toBe(200);
      expect((await request('GET', '/sync/pull', { cookie: renewed })).statusCode).toBe(401);

      // At most 20 active devices.
      const fresh = await withDevices();
      for (let i = 0; i < 20; i++) {
        expect((await fresh.register(fresh.alice, await fresh.newDevice())).statusCode).toBe(200);
      }
      const over = await fresh.register(fresh.alice, await fresh.newDevice());
      expect([over.statusCode, over.json<{ error: string }>().error]).toEqual([
        409,
        'too_many_devices',
      ]);
    }, 60_000);
  });

  it('consumes a reset token atomically: of two simultaneous uses only one wins', async () => {
    const { db } = await server();
    const found = await requestPasswordReset(db, 'alice@acme.test');
    const token = (found as { token: string }).token;
    const results = await Promise.all([
      db.transaction().execute((trx) => resetPassword(trx, token, 'first new password', FAST)),
      db.transaction().execute((trx) => resetPassword(trx, token, 'second new password', FAST)),
    ]);
    expect(results.filter((userId) => userId !== undefined)).toEqual(['alice']);
    expect(await requestPasswordReset(db, 'ghost@acme.test')).toBeUndefined();
  });

  it('locks an address after repeated failures, whatever the accounts', async () => {
    const { request, db } = await server({
      session: { ...SESSION, maxFailures: 1000, maxIpFailures: 3 },
      loginRateLimit: { capacity: 1000, refillPerSecond: 1000 },
    });
    const attempt = (ip: string, login: string, password: string) =>
      request('POST', '/auth/login', {
        headers: { 'x-forwarded-for': ip },
        body: { login, password },
      });
    for (const ghost of ['a', 'b', 'c']) {
      expect((await attempt('203.0.113.7', `${ghost}@acme.test`, 'nope')).statusCode).toBe(401);
    }
    // The right password from the locked address is refused, with the same generic answer…
    const locked = await attempt('203.0.113.7', 'alice@acme.test', 'alice-pass');
    expect([locked.statusCode, locked.json<{ error: string }>().error]).toEqual([
      401,
      'invalid_credentials',
    ]);
    // …and did not count against the account: another address signs in at once.
    expect((await attempt('198.51.100.9', 'alice@acme.test', 'alice-pass')).statusCode).toBe(200);
    const row = await sql<{
      failures: number;
    }>`select failures from socle_login_ip where ip = '203.0.113.7'`.execute(db);
    expect(row.rows[0]?.failures).toBe(3);
    // The lock ends: the address is free again once its lock time has passed.
    await sql`update socle_login_ip set locked_until = now() - interval '1 second'`.execute(db);
    expect((await attempt('203.0.113.7', 'alice@acme.test', 'alice-pass')).statusCode).toBe(200);
  });

  it("serves RPC under the user's rights, validates input and hides internals", async () => {
    const { request, signIn } = await server();
    const bob = await signIn('bob@acme.test', 'bob-pass');
    const alice = await signIn('alice@acme.test', 'alice-pass');
    const rpc = (cookie: string, model: string, method: string, body: unknown) =>
      request('POST', `/rpc/${model}/${method}`, { cookie, body });

    const created = await rpc(bob, 'srv.invoice', 'create', {
      values: [
        { name: 'I1', companyId: C1, margin: 10 },
        { name: 'I2', companyId: C2 },
      ],
    });
    expect(created.statusCode).toBe(200);
    const [first] = created.json<{ ids: string[] }>().ids;

    const seen = await rpc(alice, 'srv.invoice', 'searchRead', { fields: ['name'], order: 'name' });
    expect(seen.json<{ records: { name: string }[] }>().records.map((r) => r.name)).toEqual(['I1']);
    expect(
      (await rpc(alice, 'srv.invoice', 'read', { ids: [first], fields: ['margin'] })).statusCode,
    ).toBe(403);
    expect(
      (await rpc(bob, 'srv.invoice', 'read', { ids: [first], fields: ['margin'] })).json(),
    ).toEqual({ records: [{ id: first, margin: 10 }] });
    expect(
      (await rpc(alice, 'srv.invoice', 'create', { values: { name: 'X', companyId: C2 } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await rpc(alice, 'srv.invoice', 'write', { ids: [first], values: { name: 'I1b' } })).json(),
    ).toEqual({ ok: true });

    expect((await rpc(alice, 'srv.ghost', 'search', {})).statusCode).toBe(404);
    expect((await rpc(alice, 'srv.invoice', 'actionDrop', {})).statusCode).toBe(404);
    const invalid = await rpc(alice, 'srv.invoice', 'search', { limit: 100000, extra: 1 });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ error: string }>().error).toBe('invalid_request');
    expect(
      (await rpc(alice, 'srv.invoice', 'search', { domain: [['nope', '=', 1]] })).statusCode,
    ).toBe(400);
    const text = await request('POST', '/rpc/srv.invoice/search', {
      cookie: alice,
      body: 'x',
      headers: { 'content-type': 'text/plain' },
    });
    expect(text.statusCode).toBe(415);
    expect(JSON.stringify(text.json())).not.toMatch(/stack|at /);
  });

  it('journals sign-ins and changes in the hash-chained audit journal', async () => {
    const { request, signIn, db } = await server();
    expect(
      (
        await request('POST', '/auth/login', {
          body: { login: 'alice@acme.test', password: 'nope' },
        })
      ).statusCode,
    ).toBe(401);
    const alice = await signIn('alice@acme.test', 'alice-pass');
    const created = await request('POST', '/rpc/srv.invoice/create', {
      cookie: alice,
      body: { values: { name: 'Audited', companyId: C1 } },
    });
    expect(created.statusCode).toBe(200);
    const rows = await sql<{
      kind: string;
      user_id: string | null;
      model: string | null;
      details: Record<string, unknown>;
    }>`select kind, user_id, model, details from socle_audit order by seq`.execute(db);
    expect(rows.rows).toEqual([
      { kind: 'login_failed', user_id: null, model: null, details: { login: 'alice@acme.test' } },
      { kind: 'login', user_id: 'alice', model: null, details: {} },
      {
        kind: 'create',
        user_id: 'alice',
        model: 'srv.invoice',
        details: { fields: ['companyId', 'name'], su: false },
      },
    ]);
    expect(JSON.stringify(rows.rows)).not.toContain('nope');
    expect(await verifyAudit(db)).toEqual({ ok: true, count: 3 });
  });

  it('synchronises a device over HTTP', async () => {
    const { request, signIn } = await server();
    const cookie = await signIn('alice@acme.test', 'alice-pass');
    const keys = await generateSigningKeyPair();
    expect(
      (
        await request('POST', '/sync/devices', {
          cookie,
          body: { id: 'tablet-0001', publicKey: await exportPublicKey(keys.publicKey) },
        })
      ).statusCode,
    ).toBe(200);
    expect((await request('GET', '/sync/devices/tablet-0001', { cookie })).json()).toEqual({
      status: 'active',
    });

    const recordId = uuidv7();
    const mutation = await signMutation(keys.privateKey, {
      mutationId: uuidv7(),
      deviceId: 'tablet-0001',
      model: 'srv.invoice',
      op: 'create',
      recordId,
      changes: { name: 'offline', companyId: C1 },
      clientTs: new Date().toISOString(),
    });
    const pushed = await request('POST', '/sync/push', {
      cookie,
      body: { deviceId: 'tablet-0001', mutations: [mutation] },
    });
    expect(pushed.json()).toMatchObject({ results: [{ status: 'applied' }] });
    const pulled = (await request('GET', '/sync/pull?cursor=0', { cookie })).json<{
      records: { id: string; values: Record<string, unknown> }[];
    }>();
    expect(pulled.records.find((r) => r.id === recordId)?.values).toMatchObject({
      name: 'offline',
    });
    // Regression: fields restricted to groups were sent to and writable from any device.
    expect(pulled.records[0]?.values).not.toHaveProperty('margin');
    const hidden = await signMutation(keys.privateKey, {
      mutationId: uuidv7(),
      deviceId: 'tablet-0001',
      model: 'srv.invoice',
      op: 'write',
      recordId,
      changes: { margin: 99 },
      baseVersions: {},
      clientTs: new Date().toISOString(),
    });
    expect(
      (
        await request('POST', '/sync/push', {
          cookie,
          body: { deviceId: 'tablet-0001', mutations: [hidden] },
        })
      ).json(),
    ).toMatchObject({ results: [{ status: 'rejected' }] });
    // Another rights fingerprint: the device must reset.
    expect(
      (await request('GET', '/sync/pull?cursor=5&rights=stale', { cookie })).json(),
    ).toMatchObject({ reset: true, cursor: 0 });
  });
});
