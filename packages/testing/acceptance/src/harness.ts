// SPDX-License-Identifier: LGPL-3.0-only
//
// The acceptance setting: a tenant whose modules were installed by the `socle` CLI, the real
// HTTP server in front of it, and devices each holding a SQLite replica synchronised through
// the device engine of @socle/sync.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { main } from '@socle/cli';
import { compose, databaseUrl, loadModules, tenantDatabase } from '@socle/runtime';
import { exportPublicKey, generateSigningKeyPair } from '@socle/crypto';
import {
  buildModelRegistry,
  createAccessControl,
  createEnvironment,
  type DomainNode,
  type Environment,
  type ModelRegistry,
  type SecurityPolicy,
  type Storage,
  type UserContext,
  type ViewRegistry,
} from '@socle/framework';
import { createPgDatabase, type Executor } from '@socle/orm-pg';
import {
  applyLocalSchema,
  createSqliteDatabase,
  createSqliteStorage,
  registerFunctions,
} from '@socle/orm-sqlite';
import { openNodeSqlite } from '@socle/orm-sqlite/node';
import {
  buildServer,
  createTenantDirectory,
  createUser,
  csrfToken,
  readSessionCookie,
} from '@socle/server';
import {
  memoryDeviceStateStore,
  openDevice,
  parsePullResponse,
  parsePushResults,
  syncableFields,
  type Device,
  type SyncTransport,
} from '@socle/sync';
import { expect } from 'vitest';

export const MODULES = join(import.meta.dirname, '..', 'modules');
const FAST = { memoryKiB: 1024, passes: 1, parallelism: 1 };

/** The anti-CSRF header a browser client would send with this session cookie. */
export const csrfHeader = (cookie: string): Record<string, string> => {
  const token = readSessionCookie(cookie);
  return token === undefined ? {} : { 'x-csrf-token': csrfToken(token) };
};
const EVERYTHING: DomainNode = { kind: 'true' };

export const ALICE: UserContext = {
  id: 'alice',
  groupIds: ['acc_base.group_user'],
  companyIds: [],
  companyId: null,
  lang: 'fr_FR',
  tz: 'Europe/Paris',
};

type Snapshot = Record<string, Record<string, unknown>>;

export interface Tenant {
  readonly serverRegistry: ModelRegistry;
  readonly clientRegistry: ModelRegistry;
  /** The server tenant database (to check the bookkeeping). */
  readonly db: Executor;
  device(name: string): Promise<TestDevice>;
  /** Everything the user may read on the server, as a device receives it. */
  serverState(): Promise<Snapshot>;
  close(): Promise<void>;
}

export interface TestDevice {
  readonly name: string;
  readonly engine: Device;
  /** A fresh ORM environment on the device (reads and writes the local replica only). */
  env(): Environment;
  /** Everything the replica holds, in the same shape as {@link Tenant.serverState}. */
  replica(): Promise<Snapshot>;
}

const normalize = (value: unknown): unknown =>
  Array.isArray(value) ? [...(value as string[])].sort() : (value ?? null);

async function readAll(storage: Storage, registry: ModelRegistry): Promise<Snapshot> {
  const snapshot: Snapshot = {};
  for (const name of registry.names()) {
    const meta = registry.get(name);
    if (meta.abstract || !meta.offline.syncable) continue;
    const fields = syncableFields(meta);
    const ids = await storage.search(meta, EVERYTHING, {});
    const rows = await storage.read(meta, ids, fields);
    for (const [id, values] of rows) {
      snapshot[`${name}:${id}`] = Object.fromEntries(
        fields.map((field) => [field, normalize(values[field])]),
      );
    }
  }
  return snapshot;
}

export interface InstalledTenant {
  readonly connectionString: string;
  readonly serverRegistry: ModelRegistry;
  readonly clientRegistry: ModelRegistry;
  readonly security: SecurityPolicy;
  readonly views: ViewRegistry;
  /** A pool on the tenant database (to check it directly). */
  readonly db: Executor;
}

/**
 * A tenant database created and filled by the CLI (`db create`, `module install acc_ext`:
 * acc_base comes first as its dependency), with one user.
 */
export async function installTenant(
  pgUrl: string,
  user: { readonly login: string; readonly password: string } = {
    login: 'alice@acme.test',
    password: 'alice-pass',
  },
): Promise<InstalledTenant> {
  const name = `acc${randomBytes(4).toString('hex')}`;
  const cli = async (...argv: string[]): Promise<void> => {
    const lines: string[] = [];
    const out = { line: (text: string) => lines.push(text) };
    const code = await main(argv, {
      env: { SOCLE_DATABASE_URL: pgUrl, SOCLE_MODULE_PATHS: MODULES },
      cwd: MODULES,
      out,
      err: out,
    });
    expect(code, lines.join('\n')).toBe(0);
  };
  await cli('db', 'create', name);
  await cli('module', 'install', name, 'acc_ext');

  const set = await loadModules([MODULES]);
  const modules = ['acc_base', 'acc_ext'];
  const { registry: serverRegistry, views, security } = compose(set, modules);
  const clientRegistry = buildModelRegistry(
    modules.map((module) => set.get(module).models),
    { side: 'client' },
  );
  const connectionString = databaseUrl(pgUrl, tenantDatabase(name));
  const db = createPgDatabase({ connectionString, max: 2 });
  await createUser(
    db,
    {
      id: ALICE.id,
      login: user.login,
      password: user.password,
      groupIds: [...ALICE.groupIds],
      companyIds: [],
      companyId: null,
    },
    FAST,
  );
  return { connectionString, serverRegistry, clientRegistry, views, security, db };
}

/** The HTTP server in front of `tenants` (subdomain → tenant), for tests. */
export function testServer(tenantsByName: Readonly<Record<string, InstalledTenant>>) {
  const tenants = createTenantDirectory({
    resolve: (tenant) => {
      const found = Object.hasOwn(tenantsByName, tenant) ? tenantsByName[tenant] : undefined;
      return Promise.resolve(
        found
          ? {
              connectionString: found.connectionString,
              registry: found.serverRegistry,
              views: found.views,
              security: found.security,
            }
          : undefined,
      );
    },
  });
  const app = buildServer({
    baseDomain: 'erp.test',
    tenants,
    logger: false,
    session: { idleMs: 3_600_000, absoluteMs: 86_400_000, maxFailures: 5, cost: FAST },
    rateLimit: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
    // The property tests register a new simulated device on every case.
    maxDevicesPerUser: 100_000,
  });
  const inject = (
    host: string,
    method: 'GET' | 'POST',
    url: string,
    cookie?: string,
    body?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: { host: `${host}.erp.test`, ...(cookie ? { cookie, ...csrfHeader(cookie) } : {}) },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });
  const signIn = async (host: string, login: string, password: string): Promise<string> => {
    const response = await inject(host, 'POST', '/auth/login', undefined, { login, password });
    expect(response.statusCode, response.body).toBe(200);
    return String(response.headers['set-cookie']).split(';')[0] ?? '';
  };
  return {
    inject,
    signIn,
    async close() {
      await app.close();
      await tenants.close();
    },
  };
}

/**
 * Creates a tenant with the CLI, a user, and the HTTP server in front of it (`acme.erp.test`).
 */
export async function createTenant(pgUrl: string): Promise<Tenant> {
  const { connectionString, serverRegistry, clientRegistry, security, db } =
    await installTenant(pgUrl);

  const tenants = createTenantDirectory({
    resolve: (tenant) =>
      Promise.resolve(
        tenant === 'acme' ? { connectionString, registry: serverRegistry, security } : undefined,
      ),
  });
  const app = buildServer({
    baseDomain: 'erp.test',
    tenants,
    logger: false,
    session: { idleMs: 3_600_000, absoluteMs: 86_400_000, maxFailures: 5, cost: FAST },
    rateLimit: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
    // The property tests register a new simulated device on every case.
    maxDevicesPerUser: 100_000,
  });
  const request = async (method: 'GET' | 'POST', url: string, cookie?: string, body?: unknown) => {
    const response = await app.inject({
      method,
      url,
      headers: { host: 'acme.erp.test', ...(cookie ? { cookie, ...csrfHeader(cookie) } : {}) },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });
    expect(response.statusCode, response.body).toBe(200);
    return { json: response.json<unknown>(), headers: response.headers };
  };
  const login = await request('POST', '/auth/login', undefined, {
    login: 'alice@acme.test',
    password: 'alice-pass',
  });
  const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';

  const transport = (): SyncTransport => ({
    async push(deviceId, mutations) {
      const { json } = await request('POST', '/sync/push', cookie, { deviceId, mutations });
      return parsePushResults((json as { results: unknown }).results);
    },
    async pull(cursor, rights) {
      const query = new URLSearchParams({ cursor: String(cursor) });
      if (rights !== null) query.set('rights', rights);
      const { json } = await request('GET', `/sync/pull?${query.toString()}`, cookie);
      const { rights: next, ...raw } = json as { rights: string };
      return { response: parsePullResponse(raw), rights: next };
    },
  });

  const access = createAccessControl(security, clientRegistry);

  return {
    serverRegistry,
    clientRegistry,
    db,
    async device(deviceName) {
      const keys = await generateSigningKeyPair();
      const id = `${deviceName}-${randomBytes(6).toString('hex')}`;
      await request('POST', '/sync/devices', cookie, {
        id,
        publicKey: await exportPublicKey(keys.publicKey),
      });
      const connection = openNodeSqlite();
      registerFunctions(connection);
      const local = createSqliteDatabase(connection);
      await applyLocalSchema(local, clientRegistry);
      const replica = createSqliteStorage(local, clientRegistry);
      const engine = await openDevice({
        deviceId: id,
        key: keys.privateKey,
        storage: replica,
        registry: clientRegistry,
        store: memoryDeviceStateStore(),
        transport: transport(),
      });
      return {
        name: deviceName,
        engine,
        env: () =>
          createEnvironment({
            registry: clientRegistry,
            storage: engine.storage,
            user: { ...ALICE, deviceId: id },
            access,
            audit: { record: () => undefined },
            queueServerCall: (call) => engine.queueServerCall(call),
          }),
        replica: () => readAll(replica, clientRegistry),
      };
    },
    async serverState() {
      const snapshot: Snapshot = {};
      let cursor = 0;
      for (;;) {
        const { json } = await request('GET', `/sync/pull?cursor=${String(cursor)}`, cookie);
        const raw: Record<string, unknown> = { ...(json as object) };
        Reflect.deleteProperty(raw, 'rights');
        const response = parsePullResponse(raw);
        for (const record of response.records) {
          const meta = serverRegistry.get(record.model);
          snapshot[`${record.model}:${record.id}`] = Object.fromEntries(
            syncableFields(meta).map((field) => [field, normalize(record.values[field])]),
          );
        }
        for (const gone of response.deletions)
          Reflect.deleteProperty(snapshot, `${gone.model}:${gone.id}`);
        cursor = response.cursor;
        if (!response.more) return snapshot;
      }
    },
    async close() {
      await app.close();
      await tenants.close();
      await db.destroy();
    },
  };
}
