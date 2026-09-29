// SPDX-License-Identifier: LGPL-3.0-only
//
// The HTTP server (ARCHITECTURE.md §4.9, §9.3). Processing order of every request:
// CORS → rate limit → tenant → parsing (JSON only, size-limited) → Zod validation →
// authentication (session cookie) → authorisation (the ORM: ACL, record rules, row-level
// security) → action. Errors never expose internals.
import {
  AccessError,
  canSeeField,
  createEnvironment,
  DomainError,
  effectiveGroups,
  FieldValueError,
  MissingRecordError,
  ModelDefinitionError,
  ValidationError,
  type Environment,
  type AuditEvent,
  type FieldDefinition,
  type UserContext,
} from '@socle/framework';
import {
  createPgSession,
  createPgStorage,
  createPgSyncBackend,
  deviceStatus,
  appendAudit,
  auditEntry,
  registerDevice,
  translateCommitError,
} from '@socle/orm-pg';
import { pullChanges, pushMutations, rightsFingerprint, type RunInTransaction } from '@socle/sync';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';

import {
  authenticate,
  changePassword,
  checkCredentials,
  CLEAR_SESSION_COOKIE,
  csrfMatches,
  csrfToken,
  DEFAULT_SESSION_POLICY,
  login,
  listSessions,
  LoginError,
  loginOf,
  logout,
  openSession,
  readSessionCookie,
  requestPasswordReset,
  resetPassword,
  resetTokenLogin,
  revokeSession,
  rotateSession,
  sessionCookie,
  type SessionPolicy,
} from './auth.js';
import {
  MIN_PASSWORD_LENGTH,
  passwordProblem,
  pwnedPasswords,
  type PasswordPolicy,
} from './password-policy.js';
import { registerAttachmentRoutes, type AttachmentOptions } from './attachments.js';
import { registerOidcRoutes, type OidcOptions } from './oidc.js';
import { registerPasskeyRoutes, type PasskeyOptions } from './passkeys.js';
import {
  createChallenge,
  mfaMethods,
  mfaRequired,
  registerMfaRoutes,
  type MfaOptions,
} from './mfa.js';
import { HttpError } from './http-error.js';
import { corsHeaders, SECURITY_HEADERS } from './headers.js';
import { createRateLimiter, type BucketPolicy } from './rate-limit.js';
import { tenantFromHost, type TenantDirectory, type TenantRuntime } from './tenants.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenant: TenantRuntime | null;
  }
}

export interface ServerOptions {
  /** `erp.example.com`: tenants are `<name>.erp.example.com`. */
  readonly baseDomain: string;
  readonly tenants: TenantDirectory;
  /** Extra allowed origins (the tenant's own `https://<name>.<baseDomain>` always is). */
  readonly allowedOrigins?: readonly string[] | undefined;
  readonly rateLimit?: BucketPolicy | undefined;
  readonly loginRateLimit?: BucketPolicy | undefined;
  readonly session?: SessionPolicy | undefined;
  /**
   * Length and breach rules for new passwords. Default: 12 characters and the k-anonymity
   * breach check on; pass { minLength: 12 } to turn the check off.
   */
  readonly passwordPolicy?: PasswordPolicy | undefined;
  /**
   * Delivers a password-reset token (by email, lot 2.4). Without it the reset request is
   * accepted and ignored.
   */
  readonly sendPasswordReset?:
    ((message: { login: string; token: string; host: string }) => Promise<void>) | undefined;
  /** Pino logger options (false in tests). */
  readonly logger?: boolean | undefined;
  /** File storage: the attachment endpoints exist only when it is configured. */
  readonly attachments?: AttachmentOptions | undefined;
  /**
   * Second factor (authenticator app). Without it, sign-in is password only. With it, accounts
   * that have set up a second factor must use it, and the groups in `requiredGroups` (default
   * administrators) cannot sign in without one.
   */
  readonly mfa?: MfaOptions | undefined;
  /**
   * Passkeys (WebAuthn): registration, sign-in with a passkey alone, and passkeys as a second
   * step. The relying party is the tenant's own host.
   */
  readonly passkeys?: PasskeyOptions | undefined;
  /**
   * Single sign-on with OpenID Connect providers (Google, Microsoft, any other). Each tenant's
   * redirect URI is https://<tenant host>/auth/oidc/callback.
   */
  readonly oidc?: OidcOptions | undefined;
}

const id = z.uuid();
const ids = z.array(id).min(1).max(1000);
const fields = z.array(z.string().max(64)).max(200);
const values = z.record(z.string().max(64), z.unknown());
const searchParams = z
  .object({
    domain: z.array(z.unknown()).max(200).default([]),
    order: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(1000).default(80),
    offset: z.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();
const RPC = {
  search: searchParams,
  searchCount: z.object({ domain: z.array(z.unknown()).max(200).default([]) }).strict(),
  read: z.object({ ids, fields: fields.optional() }).strict(),
  searchRead: searchParams.extend({ fields: fields.optional() }).strict(),
  create: z.object({ values: z.union([values, z.array(values).min(1).max(500)]) }).strict(),
  write: z.object({ ids, values }).strict(),
  unlink: z.object({ ids }).strict(),
} as const;
type RpcMethod = keyof typeof RPC;

const pullQuery = z
  .object({
    cursor: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(5000).default(1000),
    rights: z.string().max(100).optional(),
  })
  .strict();
const pushBody = z
  .object({ deviceId: z.string().max(64), mutations: z.array(z.unknown()).max(500) })
  .strict();
const deviceBody = z
  .object({ id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/), publicKey: z.string().max(100) })
  .strict();
const loginBody = z
  .object({ login: z.string().min(1).max(254), password: z.string().min(1).max(1024) })
  .strict();
const passwordText = z.string().min(1).max(1024);
const changeBody = z.object({ current: passwordText, next: passwordText }).strict();
const forgotBody = z.object({ login: z.string().min(1).max(254) }).strict();
const resetBody = z.object({ token: z.string().length(43), password: passwordText }).strict();

/** Field-level visibility (`groups` on fields) of a user, for RPC and synchronisation. */
const fieldVisibility =
  (tenant: TenantRuntime, user: UserContext) =>
  (definition: FieldDefinition): boolean =>
    canSeeField(effectiveGroups(tenant.security, user.groupIds), definition);

/** Maps an error to an HTTP answer; unknown errors are logged and answered generically. */
function toHttp(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof HttpError)
    return { status: error.status, code: error.code, message: error.message };
  if (error instanceof ZodError) {
    return {
      status: 400,
      code: 'invalid_request',
      message: error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    };
  }
  if (error instanceof AccessError)
    return { status: 403, code: 'forbidden', message: error.message };
  if (error instanceof MissingRecordError)
    return { status: 404, code: 'not_found', message: error.message };
  if (
    error instanceof ValidationError ||
    error instanceof FieldValueError ||
    error instanceof DomainError ||
    error instanceof ModelDefinitionError
  ) {
    return { status: 400, code: 'invalid', message: error.message };
  }
  const status = (error as { statusCode?: unknown }).statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return { status, code: 'bad_request', message: 'The request was refused.' };
  }
  return { status: 500, code: 'internal', message: 'Internal error.' };
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            redact: {
              paths: [
                'req.headers.cookie',
                'req.headers.authorization',
                'res.headers["set-cookie"]',
                '*.password',
              ],
              censor: '[redacted]',
            },
          },
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: true,
  });
  // JSON only: any other body type is answered with 415.
  app.removeContentTypeParser('text/plain');
  const session = options.session ?? DEFAULT_SESSION_POLICY;
  // The breach check is on unless the administrator gives a policy without one.
  const passwordPolicy: PasswordPolicy = options.passwordPolicy ?? {
    minLength: MIN_PASSWORD_LENGTH,
    breachCheck: pwnedPasswords({
      onError: (error) => {
        app.log.warn({ err: error }, 'breach check unavailable');
      },
    }),
  };
  const limiter = createRateLimiter(options.rateLimit ?? { capacity: 120, refillPerSecond: 20 });
  const loginLimiter = createRateLimiter(
    options.loginRateLimit ?? { capacity: 10, refillPerSecond: 0.1 },
  );

  app.decorateRequest('tenant', null);

  // 1. Headers and CORS.
  app.addHook('onRequest', async (request, reply) => {
    void reply.headers(SECURITY_HEADERS);
    const origin = request.headers.origin;
    const host = request.headers.host?.replace(/:\d{1,5}$/, '');
    const own = host ? [`https://${host}`] : [];
    const cors = corsHeaders(origin, [...own, ...(options.allowedOrigins ?? [])]);
    if (!cors.allowed) throw new HttpError(403, 'origin_refused', 'Origin not allowed.');
    void reply.headers(cors.headers);
    if (request.method === 'OPTIONS') return reply.code(204).send();
    return undefined;
  });

  // 2. Rate limit, per tenant and client address (stricter for logins).
  app.addHook('onRequest', async (request, reply) => {
    const key = `${request.headers.host ?? ''}|${request.ip}`;
    const strict = [
      '/auth/login',
      '/auth/password',
      '/auth/mfa',
      '/auth/passkeys',
      '/auth/oidc',
    ].some((prefix) => request.url.startsWith(prefix));
    const bucket = strict ? loginLimiter : limiter;
    const { allowed, retryAfterMs } = bucket.take(key);
    if (!allowed) {
      void reply.header('retry-after', String(Math.ceil(retryAfterMs / 1000)));
      throw new HttpError(429, 'rate_limited', 'Too many requests.');
    }
  });

  // 3. Tenant, from the subdomain.
  app.addHook('onRequest', async (request) => {
    const name = tenantFromHost(request.headers.host, options.baseDomain);
    const tenant = name === undefined ? undefined : await options.tenants.get(name);
    if (!tenant) throw new HttpError(404, 'unknown_tenant', 'Unknown tenant.');
    request.tenant = tenant;
  });

  // 4. CSRF, for every modifying request that carries a session cookie: the browser must say
  // the request comes from an allowed site (`Origin` was checked in step 1 when present; a
  // request declared cross-site without one is refused) and must send the session's own
  // anti-CSRF token. Sign-in, and the reset flow before any session, have no token to send.
  const CSRF_EXEMPT = new Set([
    '/auth/login',
    '/auth/logout',
    '/auth/password/forgot',
    '/auth/password/reset',
    // Sign-in with a passkey happens before any session.
    '/auth/passkeys/login/options',
    '/auth/passkeys/login/verify',
  ]);
  app.addHook('preHandler', (request) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return Promise.resolve();
    const path = request.url.split('?')[0] ?? '';
    if (CSRF_EXEMPT.has(path)) return Promise.resolve();
    // A second-factor step made with a sign-in challenge (a secret only the browser that
    // just typed the password holds) has no session token yet: the challenge is its proof.
    const challenge = (request.body as { challenge?: unknown } | null | undefined)?.challenge;
    if (
      (path.startsWith('/auth/mfa/') || path.startsWith('/auth/passkeys/register/')) &&
      typeof challenge === 'string'
    ) {
      return Promise.resolve();
    }
    const token = readSessionCookie(request.headers.cookie);
    // Presence check only; the token is compared in constant time by csrfMatches.
    // eslint-disable-next-line security/detect-possible-timing-attacks
    if (token === undefined) return Promise.resolve();
    if (
      request.headers['sec-fetch-site'] === 'cross-site' &&
      request.headers.origin === undefined
    ) {
      throw new HttpError(403, 'csrf', 'Cross-site request refused.');
    }
    const given = request.headers['x-csrf-token'];
    if (!csrfMatches(token, typeof given === 'string' ? given : undefined)) {
      throw new HttpError(403, 'csrf', 'Missing or invalid anti-CSRF token.');
    }
    return Promise.resolve();
  });

  app.setErrorHandler((error, request, reply) => {
    const answer = toHttp(error);
    if (answer.status >= 500) request.log.error({ err: error }, 'request failed');
    void reply.code(answer.status).send({ error: answer.code, message: answer.message });
  });
  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({ error: 'not_found', message: 'Not found.' });
  });

  const tenantOf = (request: FastifyRequest): TenantRuntime => {
    if (!request.tenant) throw new HttpError(404, 'unknown_tenant', 'Unknown tenant.');
    return request.tenant;
  };

  const userOf = async (request: FastifyRequest): Promise<UserContext> => {
    const user = await authenticate(
      tenantOf(request).db,
      readSessionCookie(request.headers.cookie),
      session,
    );
    if (!user) throw new HttpError(401, 'unauthenticated', 'Authentication required.');
    return user;
  };

  /** One transaction per unit of work, with the user's ORM environment and the sync backend. */
  const runner =
    (tenant: TenantRuntime, user: UserContext, request: FastifyRequest): RunInTransaction =>
    (work) =>
      tenant.db
        .transaction()
        .execute(async (trx) => {
          const events: AuditEvent[] = [];
          const pg = createPgSession(trx);
          const env = createEnvironment({
            registry: tenant.registry,
            storage: createPgStorage(trx, tenant.registry, pg),
            user,
            access: tenant.access,
            audit: {
              record: (event) => {
                events.push(event);
                if (event.type === 'sudo') request.log.info({ audit: event }, 'sudo');
              },
            },
          });
          const result = await work({ env, backend: createPgSyncBackend(pg, tenant.registry) });
          await env.flush();
          // Written in the same transaction: journaled if and only if it happened.
          await appendAudit(trx, events.map(auditEntry));
          return result;
        })
        .catch((error: unknown) => {
          throw translateCommitError(error);
        });

  /** One journal entry in a transaction of its own (sign-in events). */
  const journal = (
    request: FastifyRequest,
    entry: { userId: string | null; kind: string; details: Record<string, string> },
  ): Promise<void> =>
    tenantOf(request)
      .db.transaction()
      .execute((trx) =>
        appendAudit(trx, [
          {
            at: new Date().toISOString(),
            userId: entry.userId,
            kind: entry.kind,
            model: null,
            recordIds: [],
            details: entry.details,
          },
        ]),
      );

  // ─── authentication ──────────────────────────────────────────────────────────────────
  /** Opens the session once the user has proved who they are; the body the client receives. */
  const finishLogin = async (
    request: FastifyRequest,
    reply: FastifyReply,
    userId: string,
  ): Promise<Record<string, unknown>> => {
    const { token } = await openSession(
      tenantOf(request).db,
      userId,
      session,
      new Date(),
      request.ip,
      request.headers['user-agent'],
    );
    await journal(request, { userId, kind: 'login', details: {} });
    void reply.header('set-cookie', sessionCookie(token, session.absoluteMs));
    return { ok: true, csrfToken: csrfToken(token) };
  };

  /**
   * What follows a proved identity (password, or an identity provider): with a second factor, or
   * a role that requires one, there is no session yet, only a short-lived challenge to present
   * with the code; otherwise the session opens. `trustedSecondFactor` is for an identity
   * provider the administrator trusts to have enforced its own MFA.
   */
  const afterPrimaryAuth = async (
    request: FastifyRequest,
    reply: FastifyReply,
    userId: string,
    trustedSecondFactor = false,
  ): Promise<Record<string, unknown>> => {
    const tenant = tenantOf(request);
    const mfa = options.mfa;
    if (mfa && !trustedSecondFactor) {
      const have = await mfaMethods(tenant.db, userId);
      if (have.totp || have.email || have.passkey) {
        return {
          ok: true,
          mfa: 'verify',
          // What the account can answer with, so that the client shows the right choices.
          methods: [
            ...(have.totp ? ['totp', 'recovery'] : []),
            ...(have.email ? ['email'] : []),
            ...(have.passkey ? ['passkey'] : []),
          ],
          challenge: await createChallenge(tenant.db, userId),
        };
      }
      if (await mfaRequired(tenant.db, tenant.security, mfa, userId)) {
        return {
          ok: true,
          mfa: 'enroll',
          methods: [
            'totp',
            ...(mfa.sendCode ? ['email'] : []),
            ...(options.passkeys ? ['passkey'] : []),
          ],
          challenge: await createChallenge(tenant.db, userId),
        };
      }
    }
    return finishLogin(request, reply, userId);
  };

  app.post('/auth/login', async (request, reply) => {
    const body = loginBody.parse(request.body);
    try {
      const userId = await checkCredentials(
        tenantOf(request).db,
        body.login,
        body.password,
        session,
        new Date(),
        request.ip,
      );
      return await afterPrimaryAuth(request, reply, userId);
    } catch (error) {
      if (error instanceof LoginError) {
        // The attempted login, truncated: who was targeted, never the password.
        await journal(request, {
          userId: null,
          kind: 'login_failed',
          details: { login: body.login.slice(0, 254) },
        });
        throw new HttpError(401, 'invalid_credentials', error.message);
      }
      throw error;
    }
  });

  // Who am I, and the anti-CSRF token of this session (the client keeps it in memory).
  app.get('/auth/session', async (request) => {
    const user = await userOf(request);
    const token = readSessionCookie(request.headers.cookie) ?? '';
    return { userId: user.id, csrfToken: csrfToken(token) };
  });

  app.get('/auth/sessions', async (request) => {
    const user = await userOf(request);
    return {
      sessions: await listSessions(
        tenantOf(request).db,
        user.id,
        readSessionCookie(request.headers.cookie),
        session,
      ),
    };
  });

  app.delete<{ Params: { id: string } }>('/auth/sessions/:id', async (request) => {
    const user = await userOf(request);
    const sessionId = id.parse(request.params.id);
    if (!(await revokeSession(tenantOf(request).db, user.id, sessionId))) {
      throw new HttpError(404, 'not_found', 'Unknown session.');
    }
    await journal(request, {
      userId: user.id,
      kind: 'session_revoked',
      details: { session: sessionId },
    });
    return { ok: true };
  });

  app.post('/auth/logout', async (request, reply) => {
    const token = readSessionCookie(request.headers.cookie);
    // Presence check only; the secret itself is compared as a SHA-256 hash in the database.
    // eslint-disable-next-line security/detect-possible-timing-attacks
    if (token !== undefined) await logout(tenantOf(request).db, token);
    void reply.header('set-cookie', CLEAR_SESSION_COOKIE);
    return { ok: true };
  });

  // ─── passwords ───────────────────────────────────────────────────────────────────────
  const refuseWeak = async (password: string, login: string): Promise<void> => {
    const problem = await passwordProblem(password, passwordPolicy, login);
    if (problem !== undefined) throw new HttpError(400, 'weak_password', problem);
  };

  app.post('/auth/password/change', async (request, reply) => {
    const body = changeBody.parse(request.body);
    const tenant = tenantOf(request);
    const user = await userOf(request);
    await refuseWeak(body.next, await loginOf(tenant.db, user.id));
    try {
      await changePassword(
        tenant.db,
        user.id,
        body.current,
        body.next,
        readSessionCookie(request.headers.cookie),
        session.cost,
      );
    } catch (error) {
      if (error instanceof LoginError) {
        throw new HttpError(403, 'invalid_credentials', 'The current password is wrong.');
      }
      throw error;
    }
    await journal(request, { userId: user.id, kind: 'password_changed', details: {} });
    // A new session token after the change: the one seen before is no longer valid.
    const current = readSessionCookie(request.headers.cookie);
    const fresh = current === undefined ? undefined : await rotateSession(tenant.db, current);
    if (fresh === undefined) return { ok: true };
    void reply.header('set-cookie', sessionCookie(fresh, session.absoluteMs));
    return { ok: true, csrfToken: csrfToken(fresh) };
  });

  // Always the same answer, whether the account exists or not.
  app.post('/auth/password/forgot', async (request) => {
    const body = forgotBody.parse(request.body);
    const found = await requestPasswordReset(tenantOf(request).db, body.login);
    const send = options.sendPasswordReset;
    if (found && send) {
      const host = request.headers.host ?? '';
      // Not awaited: the answer must not depend on the mail server's speed.
      send({ login: body.login.toLowerCase(), token: found.token, host }).catch(
        (error: unknown) => {
          request.log.error({ err: error }, 'password reset mail failed');
        },
      );
    }
    return { ok: true };
  });

  app.post('/auth/password/reset', async (request) => {
    const body = resetBody.parse(request.body);
    const tenant = tenantOf(request);
    const loginName = await resetTokenLogin(tenant.db, body.token);
    if (loginName === undefined) {
      throw new HttpError(400, 'invalid_token', 'This link is invalid or has expired.');
    }
    await refuseWeak(body.password, loginName);
    const userId = await tenant.db
      .transaction()
      .execute((trx) => resetPassword(trx, body.token, body.password, session.cost));
    if (userId === undefined) {
      throw new HttpError(400, 'invalid_token', 'This link is invalid or has expired.');
    }
    await journal(request, { userId, kind: 'password_reset', details: {} });
    return { ok: true };
  });

  // ─── RPC ─────────────────────────────────────────────────────────────────────────────
  app.post<{ Params: { model: string; method: string } }>(
    '/rpc/:model/:method',
    async (request) => {
      const tenant = tenantOf(request);
      const { model, method } = request.params;
      if (!Object.hasOwn(RPC, method)) throw new HttpError(404, 'not_found', 'Unknown method.');
      if (!tenant.registry.has(model) || tenant.registry.get(model).abstract) {
        throw new HttpError(404, 'not_found', 'Unknown model.');
      }
      const params = RPC[method as RpcMethod].parse(request.body ?? {});
      const user = await userOf(request);
      return runner(
        tenant,
        user,
        request,
      )(({ env }) =>
        rpc(
          env,
          effectiveGroups(tenant.security, user.groupIds),
          model,
          method as RpcMethod,
          params,
        ),
      );
    },
  );

  // ─── attachments ─────────────────────────────────────────────────────────────────────
  if (options.mfa) {
    registerMfaRoutes(app, { options: options.mfa, tenantOf, userOf, journal, finishLogin });
  }

  if (options.oidc) {
    registerOidcRoutes(app, {
      options: options.oidc,
      tenantOf,
      journal,
      afterPrimaryAuth,
      cost: session.cost,
    });
  }

  if (options.passkeys) {
    registerPasskeyRoutes(app, {
      options: { ...options.passkeys, mfa: options.passkeys.mfa ?? options.mfa },
      tenantOf,
      userOf,
      journal,
      finishLogin,
    });
  }

  if (options.attachments) {
    registerAttachmentRoutes(app, { tenantOf, userOf, runner }, options.attachments);
  }

  // ─── synchronisation (§6.3) ──────────────────────────────────────────────────────────
  app.post('/sync/devices', async (request) => {
    const body = deviceBody.parse(request.body);
    const user = await userOf(request);
    await registerDevice(tenantOf(request).db, {
      id: body.id,
      userId: user.id,
      publicKey: body.publicKey,
    });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/sync/devices/:id', async (request) => {
    await userOf(request);
    return { status: await deviceStatus(tenantOf(request).db, request.params.id) };
  });

  app.get('/sync/pull', async (request) => {
    const query = pullQuery.parse(request.query);
    const tenant = tenantOf(request);
    const user = await userOf(request);
    return pullChanges({
      run: runner(tenant, user, request),
      cursor: query.cursor,
      limit: query.limit,
      rights: await rightsFingerprint(user),
      deviceRights: query.rights ?? null,
      canSeeField: fieldVisibility(tenant, user),
    });
  });

  app.post('/sync/push', async (request) => {
    const body = pushBody.parse(request.body);
    const tenant = tenantOf(request);
    const user = await userOf(request);
    return {
      results: await pushMutations({
        run: runner(tenant, user, request),
        userId: user.id,
        deviceId: body.deviceId,
        mutations: body.mutations,
        canSeeField: fieldVisibility(tenant, user),
      }),
    };
  });

  return app;
}

/** The standard RPC methods; business methods decorated as public come later. */
async function rpc(
  env: Environment,
  groups: ReadonlySet<string>,
  model: string,
  method: RpcMethod,
  params: unknown,
): Promise<unknown> {
  const meta = env.registry.get(model);
  const readable = [...meta.fields]
    .filter(([name, definition]) => canSeeField(groups, definition) && name !== 'id')
    .map(([name]) => name);
  const checkFields = (requested: readonly string[] | undefined): string[] => {
    if (requested === undefined) return readable;
    for (const name of requested) {
      if (!meta.fields.has(name)) throw new HttpError(400, 'invalid', `Unknown field "${name}".`);
      if (!readable.includes(name))
        throw new AccessError(`Field "${name}" is not visible for this user.`);
    }
    return [...requested];
  };
  const records = env.model(model);

  switch (method) {
    case 'search': {
      const p = RPC.search.parse(params);
      return {
        ids: (
          await records.search(p.domain as never, {
            order: p.order,
            limit: p.limit,
            offset: p.offset,
          })
        ).ids,
      };
    }
    case 'searchCount':
      return { count: await records.searchCount(RPC.searchCount.parse(params).domain as never) };
    case 'read': {
      const p = RPC.read.parse(params);
      return { records: await records.browse(p.ids).read(['id', ...checkFields(p.fields)]) };
    }
    case 'searchRead': {
      const p = RPC.searchRead.parse(params);
      const found = await records.search(p.domain as never, {
        order: p.order,
        limit: p.limit,
        offset: p.offset,
      });
      return { records: await found.read(['id', ...checkFields(p.fields)]) };
    }
    case 'create': {
      const p = RPC.create.parse(params);
      const list = Array.isArray(p.values) ? p.values : [p.values];
      for (const entry of list) checkFields(Object.keys(entry));
      return { ids: (await records.create(list)).ids };
    }
    case 'write': {
      const p = RPC.write.parse(params);
      checkFields(Object.keys(p.values));
      await records.browse(p.ids).write(p.values);
      return { ok: true };
    }
    case 'unlink': {
      await records.browse(RPC.unlink.parse(params).ids).unlink();
      return { ok: true };
    }
  }
}
