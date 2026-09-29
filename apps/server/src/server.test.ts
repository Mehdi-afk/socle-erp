// SPDX-License-Identifier: LGPL-3.0-only
import { randomUUID } from 'node:crypto';

import { exportPublicKey, generateSigningKeyPair, uuidv7 } from '@socle/crypto';
import { buildModelRegistry, buildSecurityPolicy, defineModel, f } from '@socle/framework';
import { applySchema, createPgDatabase, verifyAudit, type Executor } from '@socle/orm-pg';
import { signMutation } from '@socle/sync';
import { sql } from 'kysely';
import { afterAll, describe, expect, inject, it } from 'vitest';

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
afterAll(async () => {
  for (const directory of directories) await directory.close();
  for (const pool of pools) await pool.destroy();
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
