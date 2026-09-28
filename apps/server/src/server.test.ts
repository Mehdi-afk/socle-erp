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
  hashPassword,
  readSessionCookie,
  verifyPassword,
  type SessionPolicy,
} from './auth.js';
import { corsHeaders } from './headers.js';
import { createRateLimiter, takeToken } from './rate-limit.js';
import { createTenantDirectory, tenantFromHost, type TenantDirectory } from './tenants.js';

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
    method: 'GET' | 'POST',
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
        ...(options.cookie ? { cookie: options.cookie } : {}),
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
