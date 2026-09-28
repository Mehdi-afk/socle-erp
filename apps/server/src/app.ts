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
  type FieldDefinition,
  type UserContext,
} from '@socle/framework';
import {
  createPgSession,
  createPgStorage,
  createPgSyncBackend,
  deviceStatus,
  registerDevice,
  translateCommitError,
} from '@socle/orm-pg';
import { pullChanges, pushMutations, rightsFingerprint, type RunInTransaction } from '@socle/sync';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';

import {
  authenticate,
  CLEAR_SESSION_COOKIE,
  DEFAULT_SESSION_POLICY,
  login,
  LoginError,
  logout,
  readSessionCookie,
  sessionCookie,
  type SessionPolicy,
} from './auth.js';
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
  /** Pino logger options (false in tests). */
  readonly logger?: boolean | undefined;
}

/** HTTP errors whose message may be shown to the client. */
class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
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
    const bucket = request.url.startsWith('/auth/login') ? loginLimiter : limiter;
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
          const pg = createPgSession(trx);
          const env = createEnvironment({
            registry: tenant.registry,
            storage: createPgStorage(trx, tenant.registry, pg),
            user,
            access: tenant.access,
            audit: {
              record: (event) => {
                request.log.info({ audit: event }, 'sudo');
              },
            },
          });
          const result = await work({ env, backend: createPgSyncBackend(pg, tenant.registry) });
          await env.flush();
          return result;
        })
        .catch((error: unknown) => {
          throw translateCommitError(error);
        });

  // ─── authentication ──────────────────────────────────────────────────────────────────
  app.post('/auth/login', async (request, reply) => {
    const body = loginBody.parse(request.body);
    try {
      const { token } = await login(tenantOf(request).db, body.login, body.password, session);
      void reply.header('set-cookie', sessionCookie(token, session.absoluteMs));
      return { ok: true };
    } catch (error) {
      if (error instanceof LoginError)
        throw new HttpError(401, 'invalid_credentials', error.message);
      throw error;
    }
  });

  app.post('/auth/logout', async (request, reply) => {
    const token = readSessionCookie(request.headers.cookie);
    // Presence check only; the secret itself is compared as a SHA-256 hash in the database.
    // eslint-disable-next-line security/detect-possible-timing-attacks
    if (token !== undefined) await logout(tenantOf(request).db, token);
    void reply.header('set-cookie', CLEAR_SESSION_COOKIE);
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
