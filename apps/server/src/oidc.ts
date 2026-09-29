// SPDX-License-Identifier: LGPL-3.0-only
//
// Single sign-on with any OpenID Connect provider (lot 2.2f): Authorization Code flow with PKCE.
// Protections, each of them tested:
// - `state` (single use, stored as a hash) and a `nonce` inside the ID token;
// - a cookie that ties the flow to the browser that started it, so that an attacker cannot make a
//   victim finish the attacker's sign-in (login CSRF);
// - PKCE (S256): a stolen authorisation code is useless without the verifier kept on the server;
// - the ID token is fully checked (signature against the provider's keys, issuer, audience,
//   expiry, nonce, authorised party); the discovery document must announce the configured issuer
//   and HTTPS endpoints;
// - an account is recognised by the provider's stable `sub`, never by the email alone: linking
//   an existing account by email is off unless the administrator turns it on for a provider that
//   verifies emails (Google does; a Microsoft `email` claim can be set by the user, the
//   "nOAuth" attack), and a new account is only created for listed email domains.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { AUTH_TABLES, type Executor } from '@socle/orm-pg';
import { createLocalJWKSet, decodeJwt, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';

import { createUser, type PasswordCost } from './auth.js';
import { HttpError } from './http-error.js';
import type { TenantRuntime } from './tenants.js';

const T = AUTH_TABLES;
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const FLOW_MS = 10 * 60_000;
const DISCOVERY_MS = 3_600_000;
const REFRESH_KEYS_MS = 5 * 60_000;
const HTTP_TIMEOUT_MS = 5000;
const MAX_BODY = 1_000_000;
export const OIDC_COOKIE = '__Host-socle_oidc';

export interface OidcProvider {
  /** Lower case letters, digits and hyphens: appears in the URLs. */
  readonly id: string;
  /** Text of the sign-in button. */
  readonly label: string;
  /**
   * The issuer the ID tokens carry. It may contain `{tenantid}` (Microsoft multi-tenant): the
   * value is then taken from the token's `tid` claim, after its signature is verified.
   */
  readonly issuer: string;
  /** Where the discovery document is, when it is not `<issuer>/.well-known/openid-configuration`. */
  readonly discoveryUrl?: string | undefined;
  readonly clientId: string;
  /** From the server configuration, never from the database. */
  readonly clientSecret: string;
  /** Default `openid email profile`. */
  readonly scopes?: readonly string[] | undefined;
  /** Extra query parameters of the authorisation request (e.g. Microsoft `response_mode`). */
  readonly authorizationParams?: Readonly<Record<string, string>> | undefined;
  /** With `{tenantid}` in the issuer: the tenants that may sign in (empty: any). */
  readonly allowedTenants?: readonly string[] | undefined;
  /** Email domains allowed to be linked or created (empty: no restriction on linking). */
  readonly allowedDomains?: readonly string[] | undefined;
  /**
   * Attach an existing account whose login is the provider's verified email. Off by default:
   * only for a provider that guarantees the email is verified.
   */
  readonly linkByEmail?: boolean | undefined;
  /** Create the account of an unknown identity (needs `allowedDomains`). */
  readonly provision?:
    | {
        readonly groupIds?: readonly string[] | undefined;
        readonly companyIds?: readonly string[] | undefined;
        readonly companyId?: string | null | undefined;
      }
    | undefined;
  /**
   * The provider enforces its own multi-factor authentication, so the local second factor is not
   * asked again (default: it is).
   */
  readonly trustProviderMfa?: boolean | undefined;
}

export interface OidcOptions {
  readonly providers: readonly OidcProvider[];
  /** Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch | undefined;
  /** Where the browser lands after sign-in (default `/`) or a failure/second factor (`/login`). */
  readonly homePath?: string | undefined;
  readonly loginPath?: string | undefined;
}

/** Google Accounts. Emails are verified by Google, so linking by email may be turned on. */
export function googleProvider(options: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly label?: string | undefined;
  readonly allowedDomains?: readonly string[] | undefined;
  readonly linkByEmail?: boolean | undefined;
  readonly provision?: OidcProvider['provision'];
}): OidcProvider {
  return {
    id: 'google',
    label: options.label ?? 'Google',
    issuer: 'https://accounts.google.com',
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    allowedDomains: options.allowedDomains,
    linkByEmail: options.linkByEmail,
    provision: options.provision,
  };
}

/**
 * Microsoft Entra ID. `tenant` is a directory id (recommended: only that directory signs in) or
 * `common` / `organizations` / `consumers`. The `email` claim is not verified by Microsoft, so
 * accounts are recognised by `sub`; `linkByEmail` must be a deliberate choice.
 */
export function microsoftProvider(options: {
  readonly tenant: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly label?: string | undefined;
  readonly allowedTenants?: readonly string[] | undefined;
  readonly allowedDomains?: readonly string[] | undefined;
  readonly linkByEmail?: boolean | undefined;
  readonly provision?: OidcProvider['provision'];
}): OidcProvider {
  const isDirectory = /^[0-9a-f-]{36}$/i.test(options.tenant);
  return {
    id: 'microsoft',
    label: options.label ?? 'Microsoft',
    issuer: isDirectory
      ? `https://login.microsoftonline.com/${options.tenant}/v2.0`
      : 'https://login.microsoftonline.com/{tenantid}/v2.0',
    discoveryUrl: `https://login.microsoftonline.com/${options.tenant}/v2.0/.well-known/openid-configuration`,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    authorizationParams: { response_mode: 'query' },
    allowedTenants: options.allowedTenants,
    allowedDomains: options.allowedDomains,
    linkByEmail: options.linkByEmail,
    provision: options.provision,
  };
}

/** Refuses at start-up a configuration that would be unsafe or cannot work. */
export function validateOidcOptions(options: OidcOptions): void {
  const seen = new Set<string>();
  for (const provider of options.providers) {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(provider.id)) {
      throw new Error(`OIDC provider id "${provider.id}" is invalid.`);
    }
    if (seen.has(provider.id)) throw new Error(`OIDC provider "${provider.id}" is declared twice.`);
    seen.add(provider.id);
    if (!provider.issuer.startsWith('https://')) {
      throw new Error(`OIDC provider "${provider.id}": the issuer must be an https URL.`);
    }
    if (provider.clientId === '' || provider.clientSecret === '') {
      throw new Error(`OIDC provider "${provider.id}": client id and secret are required.`);
    }
    if (provider.provision && (provider.allowedDomains?.length ?? 0) === 0) {
      throw new Error(
        `OIDC provider "${provider.id}": creating accounts needs allowedDomains (no open sign-up).`,
      );
    }
  }
}

// ─── discovery and keys ──────────────────────────────────────────────────────────────────

const httpsUrl = z.url().refine((value) => value.startsWith('https://'), 'https only');
const discoveryDocument = z.object({
  issuer: z.string().min(1),
  authorization_endpoint: httpsUrl,
  token_endpoint: httpsUrl,
  jwks_uri: httpsUrl,
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
});
type Discovery = z.infer<typeof discoveryDocument>;

const claimsSchema = z.object({
  sub: z.string().min(1).max(255),
  email: z.string().max(320).optional(),
  email_verified: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
  name: z.string().max(255).optional(),
  tid: z.string().max(64).optional(),
});
export type OidcClaims = z.infer<typeof claimsSchema>;

/** The endpoints and signing keys of one provider, cached. */
class ProviderClient {
  private discovery: { at: number; value: Discovery } | undefined;
  private keys: { at: number; jwks: ReturnType<typeof createLocalJWKSet> } | undefined;

  readonly provider: OidcProvider;
  private readonly request: typeof fetch;

  constructor(provider: OidcProvider, request: typeof fetch) {
    this.provider = provider;
    this.request = request;
  }

  private async getJson(url: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.request(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const text = await response.text();
    if (text.length > MAX_BODY) throw new Error('Response too large.');
    if (!response.ok) throw new Error(`Provider answered ${String(response.status)}.`);
    return JSON.parse(text) as unknown;
  }

  async endpoints(now = Date.now()): Promise<Discovery> {
    if (this.discovery && now - this.discovery.at < DISCOVERY_MS) return this.discovery.value;
    const url =
      this.provider.discoveryUrl ??
      `${this.provider.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const value = discoveryDocument.parse(await this.getJson(url));
    // The document must belong to the issuer we configured (mix-up and spoofing protection).
    if (value.issuer !== this.provider.issuer) {
      throw new Error('The discovery document announces another issuer.');
    }
    this.discovery = { at: now, value };
    return value;
  }

  /** The signing keys; `refresh` re-reads them (a key rotated by the provider), at most every 5 minutes. */
  async signingKeys(
    refresh = false,
    now = Date.now(),
  ): Promise<ReturnType<typeof createLocalJWKSet>> {
    const fresh = this.keys && now - this.keys.at < DISCOVERY_MS;
    if (this.keys && fresh && !(refresh && now - this.keys.at > REFRESH_KEYS_MS)) {
      return this.keys.jwks;
    }
    const { jwks_uri: uri } = await this.endpoints(now);
    const jwks = createLocalJWKSet((await this.getJson(uri)) as JSONWebKeySet);
    this.keys = { at: now, jwks };
    return jwks;
  }

  async exchange(code: string, verifier: string, redirectUri: string): Promise<string> {
    const endpoints = await this.endpoints();
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      client_id: this.provider.clientId,
    });
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    const methods = endpoints.token_endpoint_auth_methods_supported;
    if (
      methods &&
      !methods.includes('client_secret_post') &&
      methods.includes('client_secret_basic')
    ) {
      headers.authorization = `Basic ${Buffer.from(
        `${encodeURIComponent(this.provider.clientId)}:${encodeURIComponent(this.provider.clientSecret)}`,
      ).toString('base64')}`;
    } else {
      form.set('client_secret', this.provider.clientSecret);
    }
    const answer = z.object({ id_token: z.string().min(1).max(20_000) }).parse(
      await this.getJson(endpoints.token_endpoint, {
        method: 'POST',
        headers,
        body: form.toString(),
      }),
    );
    return answer.id_token;
  }

  /**
   * The verified claims of an ID token.
   * @throws when the signature, issuer, audience, expiry or nonce is wrong
   */
  async verify(idToken: string, nonce: string, now: Date = new Date()): Promise<OidcClaims> {
    const unverified = decodeJwt(idToken);
    let issuer = this.provider.issuer;
    if (issuer.includes('{tenantid}')) {
      // The tenant is read before the signature is checked, but the signature then covers it:
      // the issuer expected below is built from it, so a forged `tid` cannot pass.
      const tid = typeof unverified.tid === 'string' ? unverified.tid : '';
      if (!/^[0-9a-f-]{36}$/i.test(tid)) throw new Error('Missing tenant.');
      const allowed = this.provider.allowedTenants ?? [];
      if (allowed.length > 0 && !allowed.map((t) => t.toLowerCase()).includes(tid.toLowerCase())) {
        throw new Error('Tenant not allowed.');
      }
      issuer = issuer.replace('{tenantid}', tid);
    }
    const options = {
      issuer,
      audience: this.provider.clientId,
      algorithms: ['RS256', 'ES256'],
      clockTolerance: 60,
      currentDate: now,
      requiredClaims: ['exp', 'iat', 'sub', 'nonce'],
    };
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, await this.signingKeys(), options));
    } catch (error) {
      // Unknown key: the provider may have rotated its keys.
      if ((error as { code?: string }).code !== 'ERR_JWKS_NO_MATCHING_KEY') throw error;
      ({ payload } = await jwtVerify(idToken, await this.signingKeys(true), options));
    }
    if (
      Array.isArray(payload.aud) &&
      payload.aud.length > 1 &&
      payload.azp !== this.provider.clientId
    ) {
      throw new Error('Wrong authorised party.');
    }
    const given = Buffer.from(typeof payload.nonce === 'string' ? payload.nonce : '');
    const wanted = Buffer.from(nonce);
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
      throw new Error('Wrong nonce.');
    }
    return claimsSchema.parse(payload);
  }
}

// ─── accounts ────────────────────────────────────────────────────────────────────────────

const emailVerified = (claims: OidcClaims): boolean =>
  claims.email_verified === true || claims.email_verified === 'true';

const domainAllowed = (provider: OidcProvider, email: string): boolean => {
  const domains = provider.allowedDomains ?? [];
  if (domains.length === 0) return true;
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  return domains.map((d) => d.toLowerCase()).includes(domain);
};

export type Resolution = 'existing' | 'linked' | 'provisioned';

/**
 * The local account of a verified identity: the one already linked to its `sub`, else (only when
 * configured, and only with a verified email of an allowed domain) an account with that login,
 * else a new account. Undefined when the identity has no right to sign in.
 */
export async function resolveOidcUser(
  db: Executor,
  provider: OidcProvider,
  claims: OidcClaims,
  cost?: PasswordCost,
): Promise<{ userId: string; how: Resolution } | undefined> {
  const known = await sql<{
    user_id: string;
  }>`select i.user_id from ${sql.table(T.oidcIdentity)} i join ${sql.table(T.user)} u on u.id = i.user_id where i.provider = ${provider.id} and i.sub = ${claims.sub} and u.active`.execute(
    db,
  );
  if (known.rows[0]) return { userId: known.rows[0].user_id, how: 'existing' };

  const email = claims.email?.toLowerCase();
  if (email === undefined || !emailVerified(claims) || !domainAllowed(provider, email)) {
    return undefined;
  }
  if (provider.linkByEmail === true) {
    const found = await sql<{
      id: string;
    }>`select id from ${sql.table(T.user)} where login = ${email} and active`.execute(db);
    const id = found.rows[0]?.id;
    if (id !== undefined) {
      await sql`insert into ${sql.table(T.oidcIdentity)} (provider, sub, user_id, email) values (${provider.id}, ${claims.sub}, ${id}, ${email}) on conflict do nothing`.execute(
        db,
      );
      return { userId: id, how: 'linked' };
    }
  }
  if (provider.provision) {
    const id = randomUUID();
    try {
      await db.transaction().execute(async (trx) => {
        // No password can ever match: it is random and nobody knows it.
        await createUser(
          trx,
          {
            id,
            login: email,
            password: randomBytes(32).toString('base64url'),
            groupIds: provider.provision?.groupIds ?? [],
            companyIds: provider.provision?.companyIds ?? [],
            companyId: provider.provision?.companyId ?? null,
          },
          cost,
        );
        await sql`insert into ${sql.table(T.oidcIdentity)} (provider, sub, user_id, email) values (${provider.id}, ${claims.sub}, ${id}, ${email})`.execute(
          trx,
        );
      });
    } catch (error) {
      // The login exists but was not linked (and linking is off): not our account to give away.
      if ((error as { code?: string }).code === '23505') return undefined;
      throw error;
    }
    return { userId: id, how: 'provisioned' };
  }
  return undefined;
}

// ─── routes ──────────────────────────────────────────────────────────────────────────────

export interface OidcRouteDeps {
  readonly options: OidcOptions;
  readonly tenantOf: (request: FastifyRequest) => TenantRuntime;
  readonly journal: (
    request: FastifyRequest,
    entry: { userId: string | null; kind: string; details: Record<string, string> },
  ) => Promise<void>;
  readonly afterPrimaryAuth: (
    request: FastifyRequest,
    reply: FastifyReply,
    userId: string,
    trustedSecondFactor: boolean,
  ) => Promise<Record<string, unknown>>;
  readonly cost: PasswordCost;
}

const callbackQuery = z.object({
  code: z.string().min(1).max(2048).optional(),
  state: z.string().length(43).optional(),
  error: z.string().max(100).optional(),
});

const cookieOf = (header: string | undefined): string | undefined => {
  if (header === undefined || header.length > 8192) return undefined;
  for (const part of header.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === OIDC_COOKIE) return value.join('=');
  }
  return undefined;
};

export function registerOidcRoutes(app: FastifyInstance, deps: OidcRouteDeps): void {
  validateOidcOptions(deps.options);
  const request = deps.options.fetch ?? fetch;
  const clients = new Map(
    deps.options.providers.map((provider) => [provider.id, new ProviderClient(provider, request)]),
  );
  const loginPath = deps.options.loginPath ?? '/login';
  const homePath = deps.options.homePath ?? '/';
  const setFlowCookie = (value: string, maxAge: number): string =>
    `${OIDC_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${String(maxAge)}`;
  const redirectUri = (req: FastifyRequest): string =>
    `https://${req.headers.host ?? ''}/auth/oidc/callback`;
  const go = (reply: FastifyReply, location: string): FastifyReply =>
    reply.code(302).header('location', location);

  // The buttons of the sign-in screen.
  app.get('/auth/oidc/providers', () => ({
    providers: deps.options.providers.map(({ id, label }) => ({ id, label })),
  }));

  app.get<{ Params: { provider: string } }>('/auth/oidc/:provider/start', async (req, reply) => {
    const client = clients.get(req.params.provider);
    if (!client) throw new HttpError(404, 'not_found', 'Unknown provider.');
    const db = deps.tenantOf(req).db;
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const browser = randomBytes(32).toString('base64url');
    let endpoints;
    try {
      endpoints = await client.endpoints();
    } catch (error) {
      req.log.error({ err: error }, 'oidc discovery failed');
      throw new HttpError(502, 'oidc_unavailable', 'The identity provider is not reachable.');
    }
    await sql`delete from ${sql.table(T.oidcFlow)} where expires_at < now()`.execute(db);
    await sql`insert into ${sql.table(T.oidcFlow)} (state_hash, browser_hash, provider, nonce, code_verifier, expires_at) values (${sha256(state)}, ${sha256(browser)}, ${client.provider.id}, ${nonce}, ${verifier}, ${new Date(Date.now() + FLOW_MS).toISOString()}::timestamptz)`.execute(
      db,
    );
    const url = new URL(endpoints.authorization_endpoint);
    const params = {
      ...(client.provider.authorizationParams ?? {}),
      response_type: 'code',
      client_id: client.provider.clientId,
      redirect_uri: redirectUri(req),
      scope: (client.provider.scopes ?? ['openid', 'email', 'profile']).join(' '),
      state,
      nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    void reply.header('set-cookie', setFlowCookie(browser, FLOW_MS / 1000));
    return go(reply, url.toString()).send();
  });

  app.get('/auth/oidc/callback', async (req, reply) => {
    const query = callbackQuery.safeParse(req.query);
    const cleared = setFlowCookie('', 0);
    const fail = async (reason: string, userId: string | null = null): Promise<FastifyReply> => {
      await deps.journal(req, {
        userId,
        kind: 'login_failed',
        details: { method: 'oidc', reason },
      });
      void reply.header('set-cookie', cleared);
      return go(reply, `${loginPath}#error=oidc_failed`).send();
    };
    if (!query.success || query.data.error !== undefined) return fail('provider_error');
    const { code, state } = query.data;
    const browser = cookieOf(req.headers.cookie);
    if (code === undefined || state === undefined || browser === undefined) return fail('state');
    const db = deps.tenantOf(req).db;

    // The flow is consumed by the first answer, and only by the browser that started it.
    const taken = await sql<{
      provider: string;
      nonce: string;
      code_verifier: string;
    }>`delete from ${sql.table(T.oidcFlow)} where state_hash = ${sha256(state)} and browser_hash = ${sha256(browser)} and expires_at > now() returning provider, nonce, code_verifier`.execute(
      db,
    );
    const flow = taken.rows[0];
    const client = flow ? clients.get(flow.provider) : undefined;
    if (!flow || !client) return fail('state');

    let claims: OidcClaims;
    try {
      const idToken = await client.exchange(code, flow.code_verifier, redirectUri(req));
      claims = await client.verify(idToken, flow.nonce);
    } catch (error) {
      req.log.warn({ err: error }, 'oidc token refused');
      return fail('token');
    }
    const found = await resolveOidcUser(db, client.provider, claims, deps.cost);
    if (!found) return fail('not_authorized');
    if (found.how !== 'existing') {
      await deps.journal(req, {
        userId: found.userId,
        kind: found.how === 'linked' ? 'oidc_linked' : 'oidc_provisioned',
        details: { provider: client.provider.id },
      });
    }
    const body = await deps.afterPrimaryAuth(
      req,
      reply,
      found.userId,
      client.provider.trustProviderMfa === true,
    );
    void reply.header('set-cookie', cleared);
    if (typeof body.challenge === 'string') {
      // In the fragment: never sent to a server, never in a referrer or a log.
      const methods = Array.isArray(body.methods) ? (body.methods as string[]).join(',') : '';
      const fragment = new URLSearchParams({
        mfa: String(body.mfa),
        methods,
        challenge: body.challenge,
      });
      return go(reply, `${loginPath}#${fragment.toString()}`).send();
    }
    return go(reply, homePath).send();
  });
}
