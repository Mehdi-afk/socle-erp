// SPDX-License-Identifier: LGPL-3.0-only
//
// Single sign-on end to end: the real server and database against a fake identity provider that
// behaves like one (discovery document, signing keys, an authorisation code that is checked
// against PKCE, the client secret and the redirect URI, real RS256 ID tokens). The Google and
// Microsoft settings are the real presets, fed with tokens shaped like theirs.
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { buildModelRegistry, buildSecurityPolicy } from '@socle/framework';
import { applySchema, createPgDatabase, verifyAudit, type Executor } from '@socle/orm-pg';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { sql } from 'kysely';
import { afterEach, describe, expect, inject, it } from 'vitest';

import { buildServer, type ServerOptions } from './app.js';
import { createUser } from './auth.js';
import {
  googleProvider,
  microsoftProvider,
  validateOidcOptions,
  type OidcProvider,
} from './oidc.js';
import { createTenantDirectory, type TenantDirectory } from './tenants.js';

const FAST = { memoryKiB: 1024, passes: 1, parallelism: 1 };
const HOST = 'acme.erp.test';
const REDIRECT = `https://${HOST}/auth/oidc/callback`;
const registry = buildModelRegistry([], { side: 'server' });
const security = buildSecurityPolicy([], () => false);

type Claims = Record<string, unknown>;
interface Grant {
  readonly nonce: string;
  readonly challenge: string;
  readonly clientId: string;
  readonly claims: Claims;
  readonly forge: Forge;
}
interface Forge {
  /** Sign with another key, as an attacker would. */
  readonly foreignKey?: boolean;
  readonly overrides?: Claims;
  readonly expired?: boolean;
  readonly unsigned?: boolean;
}

/** A software identity provider: everything `fetch` would reach, and the token endpoint's checks. */
async function identityProvider(config: {
  readonly base: string;
  readonly issuer: string;
  readonly discoveryUrl?: string;
  readonly announcedIssuer?: string;
  readonly clientId: string;
  readonly clientSecret: string;
}) {
  const pair = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const grants = new Map<string, Grant>();
  const state = { tokenFailure: false, exchanges: 0 };
  const discovery = config.discoveryUrl ?? `${config.issuer}/.well-known/openid-configuration`;

  const idToken = async (grant: Grant, issuerOverride?: string): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    // The overrides come last, so that a forgery really changes the claim it names.
    const payload = {
      iss: issuerOverride ?? config.issuer,
      aud: grant.clientId,
      iat: grant.forge.expired ? now - 7200 : now,
      exp: grant.forge.expired ? now - 3600 : now + 300,
      ...grant.claims,
      nonce: grant.nonce,
      ...grant.forge.overrides,
    };
    if (grant.forge.unsigned) {
      const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
      return `${part({ alg: 'none' })}.${part(payload)}.`;
    }
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .sign(grant.forge.foreignKey ? other.privateKey : pair.privateKey);
  };

  const fetched: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const json = (body: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));
    if (url.href === discovery) {
      return json({
        issuer: config.announcedIssuer ?? config.issuer,
        authorization_endpoint: `${config.base}/authorize`,
        token_endpoint: `${config.base}/token`,
        jwks_uri: `${config.base}/keys`,
      });
    }
    if (url.href === `${config.base}/keys`) return json({ keys: [jwk] });
    if (url.href === `${config.base}/token`) {
      state.exchanges += 1;
      if (state.tokenFailure) return json({ error: 'server_error' }, 500);
      const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
      const grant = grants.get(form.get('code') ?? '');
      grants.delete(form.get('code') ?? ''); // an authorisation code is single use
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (
        !grant ||
        form.get('grant_type') !== 'authorization_code' ||
        form.get('client_secret') !== config.clientSecret ||
        form.get('client_id') !== grant.clientId ||
        form.get('redirect_uri') !== REDIRECT ||
        challenge !== grant.challenge
      ) {
        return json({ error: 'invalid_grant' }, 400);
      }
      const tid = grant.claims.tid;
      const issuerOverride =
        typeof tid === 'string' && config.issuer.includes('{tenantid}')
          ? config.issuer.replace('{tenantid}', tid)
          : undefined;
      return json({ id_token: await idToken(grant, issuerOverride), token_type: 'Bearer' });
    }
    return json({ error: 'not_found' }, 404);
  };

  /** The user agrees at the provider: returns the code and state for the callback. */
  const authorize = (location: string, claims: Claims, forge: Forge = {}) => {
    const url = new URL(location);
    const code = randomBytes(16).toString('base64url');
    grants.set(code, {
      nonce: url.searchParams.get('nonce') ?? '',
      challenge: url.searchParams.get('code_challenge') ?? '',
      clientId: url.searchParams.get('client_id') ?? '',
      claims,
      forge,
    });
    return { code, state: url.searchParams.get('state') ?? '', url };
  };
  return { fetch: fetched, authorize, state };
}

// ─── the server ──────────────────────────────────────────────────────────────────────────

const pools: Executor[] = [];
const directories: TenantDirectory[] = [];
const apps: ReturnType<typeof buildServer>[] = [];
// Release every fixture before the next test opens another tenant database.
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0)) await directory.close();
  for (const pool of pools.splice(0)) await pool.destroy();
});

async function setup(
  providers: OidcProvider[],
  fetched: typeof fetch,
  overrides: Partial<ServerOptions> = {},
) {
  const base = inject('pgUrl');
  const name = `oidc_${randomUUID().replaceAll('-', '')}`;
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
    { id: 'alice', login: 'alice@acme.test', password: 'alice-password-1', groupIds: [] },
    FAST,
  );
  await createUser(
    db,
    { id: 'root', login: 'root@acme.test', password: 'root-password-1', groupIds: ['grp.admin'] },
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
    session: { idleMs: 3_600_000, absoluteMs: 86_400_000, maxFailures: 5, cost: FAST },
    logger: false,
    rateLimit: { capacity: 100_000, refillPerSecond: 100_000 },
    loginRateLimit: { capacity: 100_000, refillPerSecond: 100_000 },
    oidc: { providers, fetch: fetched },
    ...overrides,
  });
  apps.push(app);
  const get = (path: string, cookie?: string) =>
    app.inject({
      method: 'GET',
      url: path,
      headers: { host: HOST, ...(cookie ? { cookie } : {}) },
    });
  /** Start a sign-in: the redirect to the provider and the browser's flow cookie. */
  const start = async (provider: string) => {
    const response = await get(`/auth/oidc/${provider}/start`);
    return {
      response,
      location: String(response.headers.location),
      cookie: String(response.headers['set-cookie']).split(';')[0] as string,
    };
  };
  const callback = (query: { code?: string; state?: string; error?: string }, cookie?: string) =>
    get(
      `/auth/oidc/callback?${new URLSearchParams(query as Record<string, string>).toString()}`,
      cookie,
    );
  const cookiesOf = (response: { headers: Record<string, unknown> }): string[] =>
    ([] as unknown[]).concat(response.headers['set-cookie'] ?? []).map(String);
  const sessionOf = (response: { headers: Record<string, unknown> }): string | undefined =>
    cookiesOf(response)
      .find((c) => c.startsWith('__Host-socle_session='))
      ?.split(';')[0];
  return { app, db, get, start, callback, sessionOf, cookiesOf };
}

const google = (extra: Partial<Parameters<typeof googleProvider>[0]> = {}) =>
  googleProvider({ clientId: 'google-client', clientSecret: 'google-secret', ...extra });

async function googleIdp() {
  return identityProvider({
    base: 'https://accounts.google.test',
    issuer: 'https://accounts.google.com',
    discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration',
    clientId: 'google-client',
    clientSecret: 'google-secret',
  });
}

const GOOGLE_CLAIMS = {
  sub: 'g-1001',
  email: 'alice@acme.test',
  email_verified: true,
  name: 'Alice',
};

describe('single sign-on with Google', () => {
  it('lists the providers and sends the browser to the provider with state, nonce and PKCE', async () => {
    const idp = await googleIdp();
    const { get, start, db } = await setup([google()], idp.fetch);
    expect((await get('/auth/oidc/providers')).json()).toEqual({
      providers: [{ id: 'google', label: 'Google' }],
    });
    expect((await get('/auth/oidc/nope/start')).statusCode).toBe(404);

    const { response, location, cookie } = await start('google');
    expect(response.statusCode).toBe(302);
    const url = new URL(location);
    expect(url.origin + url.pathname).toBe('https://accounts.google.test/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'google-client',
      redirect_uri: REDIRECT,
      scope: 'openid email profile',
      code_challenge_method: 'S256',
    });
    expect(url.searchParams.get('state')).toHaveLength(43);
    expect(url.searchParams.get('nonce')).toHaveLength(43);
    // The cookie ties the flow to this browser.
    expect(String(response.headers['set-cookie'])).toMatch(
      /^__Host-socle_oidc=[\w-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/,
    );
    expect(cookie).toContain('__Host-socle_oidc=');
    // The database holds hashes of the state and cookie, and the PKCE verifier behind the challenge.
    const flow = await sql<{
      state_hash: string;
      browser_hash: string;
      code_verifier: string;
    }>`select state_hash, browser_hash, code_verifier from socle_oidc_flow`.execute(db);
    const row = flow.rows[0];
    expect(row?.state_hash).not.toBe(url.searchParams.get('state'));
    expect(row?.browser_hash).not.toBe(cookie.split('=')[1]);
    expect(
      createHash('sha256')
        .update(row?.code_verifier ?? '')
        .digest('base64url'),
    ).toBe(url.searchParams.get('code_challenge'));
  });

  it('signs in an existing account by its verified email, then by its stable identity', async () => {
    const idp = await googleIdp();
    const { start, callback, sessionOf, db, get } = await setup(
      [google({ linkByEmail: true, allowedDomains: ['acme.test'] })],
      idp.fetch,
    );
    const first = await start('google');
    const { code, state } = idp.authorize(first.location, GOOGLE_CLAIMS);
    const done = await callback({ code, state }, first.cookie);
    expect(done.statusCode).toBe(302);
    expect(done.headers.location).toBe('/');
    const session = sessionOf(done) as string;
    expect((await get('/auth/session', session)).json()).toMatchObject({ userId: 'alice' });
    const linked = await sql<{
      provider: string;
      sub: string;
      user_id: string;
    }>`select provider, sub, user_id from socle_oidc_identity`.execute(db);
    expect(linked.rows).toEqual([{ provider: 'google', sub: 'g-1001', user_id: 'alice' }]);

    // Next time the identity is what counts: the email may have changed.
    const second = await start('google');
    const again = idp.authorize(second.location, {
      sub: 'g-1001',
      email: 'renamed@elsewhere.test',
    });
    const done2 = await callback(again, second.cookie);
    expect(sessionOf(done2)).toBeDefined();
    expect((await get('/auth/session', sessionOf(done2))).json()).toMatchObject({
      userId: 'alice',
    });
    expect(await verifyAudit(db)).toMatchObject({ ok: true });
  });

  it('refuses a callback that was not started by this browser, twice, or with a wrong state', async () => {
    const idp = await googleIdp();
    const { start, callback, sessionOf } = await setup([google({ linkByEmail: true })], idp.fetch);
    const victim = await start('google');
    const attackers = await start('google');
    // The attacker's code and state finished in the victim's browser: refused (login CSRF).
    const injected = idp.authorize(attackers.location, GOOGLE_CLAIMS);
    const refused = await callback(injected, victim.cookie);
    expect(refused.headers.location).toBe('/login#error=oidc_failed');
    expect(sessionOf(refused)).toBeUndefined();
    // Without the cookie, and with a state nobody issued.
    expect((await callback(injected)).headers.location).toBe('/login#error=oidc_failed');
    const real = idp.authorize(victim.location, GOOGLE_CLAIMS);
    expect(
      (await callback({ code: real.code, state: 'x'.repeat(43) }, victim.cookie)).headers.location,
    ).toBe('/login#error=oidc_failed');
    // The right browser succeeds once; the same callback again is refused.
    const fresh = await start('google');
    const ok = idp.authorize(fresh.location, GOOGLE_CLAIMS);
    expect(sessionOf(await callback(ok, fresh.cookie))).toBeDefined();
    const replay = idp.authorize(fresh.location, GOOGLE_CLAIMS);
    expect(
      sessionOf(await callback({ code: replay.code, state: ok.state }, fresh.cookie)),
    ).toBeUndefined();
    // The provider reporting an error.
    const denied = await start('google');
    expect(
      (await callback({ error: 'access_denied', state: 'x'.repeat(43) }, denied.cookie)).headers
        .location,
    ).toBe('/login#error=oidc_failed');
  });

  it('refuses a flow that took more than ten minutes', async () => {
    const idp = await googleIdp();
    const { start, callback, sessionOf, db } = await setup(
      [google({ linkByEmail: true })],
      idp.fetch,
    );
    const flow = await start('google');
    await sql`update socle_oidc_flow set expires_at = now() - interval '1 second'`.execute(db);
    const late = idp.authorize(flow.location, GOOGLE_CLAIMS);
    expect(sessionOf(await callback(late, flow.cookie))).toBeUndefined();
  });

  it('refuses every forged or misdirected ID token', async () => {
    const idp = await googleIdp();
    const { start, callback, sessionOf, db } = await setup(
      [google({ linkByEmail: true })],
      idp.fetch,
    );
    const forgeries: [string, Forge][] = [
      ['another nonce', { overrides: { nonce: 'not-the-nonce' } }],
      ['another audience', { overrides: { aud: 'someone-elses-app' } }],
      ['another issuer', { overrides: { iss: 'https://evil.example' } }],
      ['expired', { expired: true }],
      ['signed by another key', { foreignKey: true }],
      ['no signature at all', { unsigned: true }],
    ];
    for (const [label, forge] of forgeries) {
      const flow = await start('google');
      const granted = idp.authorize(flow.location, GOOGLE_CLAIMS, forge);
      const answer = await callback(granted, flow.cookie);
      expect(sessionOf(answer), label).toBeUndefined();
      expect(answer.headers.location, label).toBe('/login#error=oidc_failed');
    }
    // Every refusal is journaled without any secret.
    const journal = await sql<{
      details: { method: string; reason: string };
    }>`select details from socle_audit where kind = 'login_failed'`.execute(db);
    expect(journal.rows.length).toBeGreaterThanOrEqual(forgeries.length);
    expect(JSON.stringify(journal.rows)).not.toContain('google-secret');
    // A token endpoint that fails, and a code that is stolen without the PKCE verifier.
    idp.state.tokenFailure = true;
    const flow = await start('google');
    const broken = idp.authorize(flow.location, GOOGLE_CLAIMS);
    expect(sessionOf(await callback(broken, flow.cookie))).toBeUndefined();
    idp.state.tokenFailure = false;
  });

  it('does not attach an account by email unless that is turned on, verified and allowed', async () => {
    const idp = await googleIdp();
    // Off by default.
    const off = await setup([google()], idp.fetch);
    const a = await off.start('google');
    expect(
      off.sessionOf(await off.callback(idp.authorize(a.location, GOOGLE_CLAIMS), a.cookie)),
    ).toBeUndefined();

    const on = await setup(
      [google({ linkByEmail: true, allowedDomains: ['acme.test'] })],
      idp.fetch,
    );
    const cases: [string, Claims][] = [
      ['unverified email', { ...GOOGLE_CLAIMS, sub: 'u1', email_verified: false }],
      ['no email', { sub: 'u2' }],
      ['other domain', { sub: 'u3', email: 'alice@evil.test', email_verified: true }],
      ['unknown account', { sub: 'u4', email: 'nobody@acme.test', email_verified: true }],
    ];
    for (const [label, claims] of cases) {
      const flow = await on.start('google');
      expect(
        on.sessionOf(await on.callback(idp.authorize(flow.location, claims), flow.cookie)),
        label,
      ).toBeUndefined();
    }
    const none = await sql<{ n: string }>`select count(*) as n from socle_oidc_identity`.execute(
      on.db,
    );
    expect(Number(none.rows[0]?.n)).toBe(0);
    // A disabled account cannot come in through its identity either.
    const flow = await on.start('google');
    const ok = idp.authorize(flow.location, { ...GOOGLE_CLAIMS, sub: 'g-1' });
    expect(on.sessionOf(await on.callback(ok, flow.cookie))).toBeDefined();
    await sql`update socle_user set active = false where id = 'alice'`.execute(on.db);
    const again = await on.start('google');
    expect(
      on.sessionOf(
        await on.callback(
          idp.authorize(again.location, { ...GOOGLE_CLAIMS, sub: 'g-1' }),
          again.cookie,
        ),
      ),
    ).toBeUndefined();
  });

  it('creates the account of a new identity only for listed domains, without any usable password', async () => {
    const idp = await googleIdp();
    const { start, callback, sessionOf, db, app } = await setup(
      [
        google({
          allowedDomains: ['acme.test'],
          provision: { groupIds: ['srv.group_user'], companyIds: ['c1'], companyId: 'c1' },
        }),
      ],
      idp.fetch,
    );
    const foreign = await start('google');
    expect(
      sessionOf(
        await callback(
          idp.authorize(foreign.location, {
            sub: 'x1',
            email: 'carol@evil.test',
            email_verified: true,
          }),
          foreign.cookie,
        ),
      ),
    ).toBeUndefined();

    const flow = await start('google');
    const claims = { sub: 'g-carol', email: 'Carol@Acme.test', email_verified: true };
    const done = await callback(idp.authorize(flow.location, claims), flow.cookie);
    expect(sessionOf(done)).toBeDefined();
    const created = await sql<{
      login: string;
      group_ids: string[];
      company_id: string;
    }>`select login, group_ids, company_id from socle_user where login = 'carol@acme.test'`.execute(
      db,
    );
    expect(created.rows).toEqual([
      { login: 'carol@acme.test', group_ids: ['srv.group_user'], company_id: 'c1' },
    ]);
    // Nobody knows its password: guessing one fails, and so does an empty or the email itself.
    for (const password of ['carol@acme.test', 'password', 'x'.repeat(12)]) {
      const attempt = await app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { host: HOST },
        payload: { login: 'carol@acme.test', password },
      });
      expect(attempt.statusCode).toBe(401);
    }
    // Signing in again finds the same account.
    const again = await start('google');
    expect(
      sessionOf(await callback(idp.authorize(again.location, claims), again.cookie)),
    ).toBeDefined();
    const count = await sql<{ n: string }>`select count(*) as n from socle_user`.execute(db);
    expect(Number(count.rows[0]?.n)).toBe(3);
  });

  it('refuses to start with an unsafe configuration', () => {
    const base = google();
    const validate = (...providers: OidcProvider[]) => {
      return () => {
        validateOidcOptions({ providers });
      };
    };
    expect(validate({ ...base, provision: {} })).toThrow(/allowedDomains/);
    expect(validate({ ...base, issuer: 'http://insecure.test' })).toThrow(/https/);
    expect(validate(base, base)).toThrow(/twice/);
    expect(validate({ ...base, id: 'Bad Id' })).toThrow(/invalid/);
    expect(validate({ ...base, clientSecret: '' })).toThrow(/secret/);
    expect(validate(base)).not.toThrow();
  });

  it('is unavailable, not trusted, when the provider announces another issuer', async () => {
    const idp = await identityProvider({
      base: 'https://accounts.google.test',
      issuer: 'https://accounts.google.com',
      discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration',
      announcedIssuer: 'https://evil.example',
      clientId: 'google-client',
      clientSecret: 'google-secret',
    });
    const { get } = await setup([google()], idp.fetch);
    expect((await get('/auth/oidc/google/start')).statusCode).toBe(502);
  });
});

describe('single sign-on with Microsoft', () => {
  const DIRECTORY = '11111111-2222-4333-8444-555555555555';
  const OTHER = '99999999-2222-4333-8444-555555555555';
  const msClaims = (extra: Claims = {}) => ({
    sub: 'AAAAAAAAAAAA-pairwise',
    oid: 'oid-1',
    tid: DIRECTORY,
    email: 'alice@acme.test',
    name: 'Alice',
    ...extra,
  });

  async function msIdp(tenant: string) {
    const template = !/^[0-9a-f-]{36}$/i.test(tenant);
    return identityProvider({
      base: 'https://login.microsoft.test',
      issuer: template
        ? 'https://login.microsoftonline.com/{tenantid}/v2.0'
        : `https://login.microsoftonline.com/${tenant}/v2.0`,
      discoveryUrl: `https://login.microsoftonline.com/${tenant}/v2.0/.well-known/openid-configuration`,
      clientId: 'ms-client',
      clientSecret: 'ms-secret',
    });
  }
  const microsoft = (
    tenant: string,
    extra: Partial<Parameters<typeof microsoftProvider>[0]> = {},
  ) => microsoftProvider({ tenant, clientId: 'ms-client', clientSecret: 'ms-secret', ...extra });

  it('recognises an account by its identity, and never by an email Microsoft does not verify', async () => {
    const idp = await msIdp(DIRECTORY);
    const { start, callback, sessionOf, db } = await setup([microsoft(DIRECTORY)], idp.fetch);
    const flow = await start('microsoft');
    expect(new URL(flow.location).searchParams.get('response_mode')).toBe('query');
    // Anyone can put alice@acme.test in their Microsoft profile: this must not open her account.
    const spoof = idp.authorize(flow.location, msClaims());
    expect(sessionOf(await callback(spoof, flow.cookie))).toBeUndefined();
    const linked = await sql<{ n: string }>`select count(*) as n from socle_oidc_identity`.execute(
      db,
    );
    expect(Number(linked.rows[0]?.n)).toBe(0);

    // An identity the administrator linked works.
    await sql`insert into socle_oidc_identity (provider, sub, user_id) values ('microsoft', 'AAAAAAAAAAAA-pairwise', 'alice')`.execute(
      db,
    );
    const again = await start('microsoft');
    expect(
      sessionOf(await callback(idp.authorize(again.location, msClaims()), again.cookie)),
    ).toBeDefined();
  });

  it('checks the directory of a multi-tenant sign-in, from a token whose signature covers it', async () => {
    const idp = await msIdp('organizations');
    const { start, callback, sessionOf, db } = await setup(
      [microsoft('organizations', { allowedTenants: [DIRECTORY] })],
      idp.fetch,
    );
    await sql`insert into socle_oidc_identity (provider, sub, user_id) values ('microsoft', 'AAAAAAAAAAAA-pairwise', 'alice')`.execute(
      db,
    );
    const ok = await start('microsoft');
    expect(
      sessionOf(await callback(idp.authorize(ok.location, msClaims()), ok.cookie)),
    ).toBeDefined();
    // Another directory is refused even with a valid signature…
    const other = await start('microsoft');
    expect(
      sessionOf(
        await callback(idp.authorize(other.location, msClaims({ tid: OTHER })), other.cookie),
      ),
    ).toBeUndefined();
    // …and so is a `tid` claim that does not match the issuer the token was really signed for.
    const mismatch = await start('microsoft');
    const forged = idp.authorize(mismatch.location, msClaims(), {
      overrides: { iss: `https://login.microsoftonline.com/${OTHER}/v2.0` },
    });
    expect(sessionOf(await callback(forged, mismatch.cookie))).toBeUndefined();
  });
});

describe('single sign-on and the second factor', () => {
  const key = Uint8Array.from(randomBytes(32));

  it('sends an account that requires a second factor to enrol, or trusts the provider that enforced one', async () => {
    const idp = await googleIdp();
    const claims = { sub: 'g-root', email: 'root@acme.test', email_verified: true };
    const mfa = { key, requiredGroups: ['grp.admin'] };
    const strict = await setup([google({ linkByEmail: true })], idp.fetch, { mfa });
    const flow = await strict.start('google');
    const answer = await strict.callback(idp.authorize(flow.location, claims), flow.cookie);
    // No session: a challenge, in the fragment of the URL (never sent to a server).
    expect(strict.sessionOf(answer)).toBeUndefined();
    const location = String(answer.headers.location);
    expect(location.startsWith('/login#')).toBe(true);
    const fragment = new URLSearchParams(location.slice('/login#'.length));
    expect(fragment.get('mfa')).toBe('enroll');
    expect(fragment.get('challenge')).toHaveLength(43);
    expect(location).not.toContain('?');

    const trusting = await setup(
      [{ ...google({ linkByEmail: true }), trustProviderMfa: true }],
      idp.fetch,
      {
        mfa,
      },
    );
    const flow2 = await trusting.start('google');
    const done = await trusting.callback(idp.authorize(flow2.location, claims), flow2.cookie);
    expect(trusting.sessionOf(done)).toBeDefined();
    expect(done.headers.location).toBe('/');
  });
});
