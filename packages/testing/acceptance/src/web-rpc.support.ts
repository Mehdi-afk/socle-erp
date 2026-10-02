// SPDX-License-Identifier: LGPL-3.0-only
// Real tenant databases and HTTP routes for the web adapter. Credentials below are public test data.
import {
  buildModelRegistry,
  buildSecurityPolicy,
  defineModel,
  extendModel,
  f,
} from '@socle/framework';
import { applySchema } from '@socle/orm-pg';
import { loadModules } from '@socle/runtime';
import { buildServer, createTenantDirectory, createUser } from '@socle/server';
import { expect } from 'vitest';

import { installTenant, MODULES, type InstalledTenant } from './harness.js';

export const FIRST_COMPANY = '0190a000-0000-7000-8000-0000000000c1';
export const SECOND_COMPANY = '0190a000-0000-7000-8000-0000000000c2';
const PASSWORD = 'public-web-rpc-fixture-password';
const FAST = { memoryKiB: 1024, passes: 1, parallelism: 1 };

export interface BrowserSession {
  readonly cookie: string;
  readonly csrf: string;
}

export interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly sentCsrf: boolean;
  readonly status: number;
}

/** Keep the established module-installation harness, adding only fixtures specific to this test. */
async function installRpcTenant(pgUrl: string): Promise<InstalledTenant> {
  const installed = await installTenant(pgUrl);
  try {
    const set = await loadModules([MODULES]);
    const loaded = ['acc_base', 'acc_ext'].map((name) => set.get(name));
    const models = [
      ...loaded.map((module) => module.models),
      {
        module: 'rpc_test',
        models: [
          defineModel({ name: 'rpc.currency', fields: { code: f.char({ required: true }) } }),
          extendModel('acc.partner', {
            fields: {
              companyId: f.char(),
              amount: f.monetary(),
              currencyId: f.many2one('rpc.currency'),
              internalMargin: f.integer({ groups: ['rpc_test.group_manager'] }),
            },
          }),
        ],
      },
    ];
    const serverRegistry = buildModelRegistry(models, { side: 'server' });
    const clientRegistry = buildModelRegistry(models, { side: 'client' });
    const security = buildSecurityPolicy(
      [
        ...loaded.map((module) => module.security),
        {
          module: 'rpc_test',
          groups: [
            {
              id: 'rpc_test.group_manager',
              name: { fr: 'Gestionnaire de test' },
              implies: ['acc_base.group_user'],
            },
          ],
          access: [
            {
              model: 'rpc.currency',
              group: 'acc_base.group_user',
              read: true,
              create: true,
              write: true,
              unlink: true,
            },
          ],
          rules: [
            {
              id: 'rpc_test.company',
              model: 'acc.partner',
              domain: [['companyId', 'in', { $user: 'companyIds' }]],
            },
          ],
        },
      ],
      (model) => serverRegistry.has(model),
    );
    await applySchema(installed.db, serverRegistry, { security });
    for (const manager of [false, true]) {
      await createUser(
        installed.db,
        {
          id: manager ? 'web-manager' : 'web-reader',
          login: manager ? 'manager@web.test' : 'reader@web.test',
          password: PASSWORD,
          groupIds: [manager ? 'rpc_test.group_manager' : 'acc_base.group_user'],
          companyIds: manager ? [FIRST_COMPANY, SECOND_COMPANY] : [FIRST_COMPANY],
          companyId: FIRST_COMPANY,
        },
        FAST,
      );
    }
    return { ...installed, serverRegistry, clientRegistry, security };
  } catch (error) {
    await installed.db.destroy();
    throw error;
  }
}

export async function createWebRpcFixture(pgUrl: string) {
  const acme = await installRpcTenant(pgUrl);
  let globex: InstalledTenant;
  try {
    globex = await installRpcTenant(pgUrl);
  } catch (error) {
    await acme.db.destroy();
    throw error;
  }
  const tenants = createTenantDirectory({
    resolve: (host) => {
      const found = host === 'acme' ? acme : host === 'globex' ? globex : undefined;
      return Promise.resolve(
        found === undefined
          ? undefined
          : {
              connectionString: found.connectionString,
              registry: found.serverRegistry,
              security: found.security,
            },
      );
    },
  });
  const app = buildServer({
    baseDomain: 'erp.test',
    tenants,
    logger: false,
    session: { idleMs: 3_600_000, absoluteMs: 86_400_000, maxFailures: 5, cost: FAST },
    rateLimit: { capacity: 100_000, refillPerSecond: 100_000 },
    loginRateLimit: { capacity: 1000, refillPerSecond: 1000 },
  });
  const close = async (): Promise<void> => {
    await app.close();
    await tenants.close();
    await Promise.all([acme.db.destroy(), globex.db.destroy()]);
  };

  const signIn = async (host: string, manager = false): Promise<BrowserSession> => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { host: `${host}.erp.test`, origin: `https://${host}.erp.test` },
      payload: { login: manager ? 'manager@web.test' : 'reader@web.test', password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ csrfToken: string }>();
    expect(typeof body.csrfToken).toBe('string');
    return {
      cookie: String(response.headers['set-cookie']).split(';')[0] ?? '',
      csrf: body.csrfToken,
    };
  };
  const rpc = async (
    host: string,
    session: BrowserSession,
    model: string,
    method: string,
    payload: Record<string, unknown>,
  ) => {
    const response = await app.inject({
      method: 'POST',
      url: `/rpc/${model}/${method}`,
      headers: {
        host: `${host}.erp.test`,
        origin: `https://${host}.erp.test`,
        cookie: session.cookie,
        'x-csrf-token': session.csrf,
      },
      payload,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<unknown>();
  };

  /** Browser transport: forward the adapter's headers verbatim; never invent or repair CSRF. */
  const browser = (
    host: 'acme' | 'globex',
    session?: BrowserSession,
    options: { readonly stripCsrf?: boolean } = {},
  ) => {
    const calls: FetchCall[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (typeof input !== 'string' || !input.startsWith('/') || input.startsWith('//'))
        throw new Error('Only relative API paths are accepted in this fixture.');
      expect(init?.credentials).toBe('same-origin');
      expect(init?.mode).toBe('same-origin');
      expect(init?.redirect).toBe('error');
      expect(init?.cache).toBe('no-store');
      init?.signal?.throwIfAborted();
      const method = init?.method ?? 'GET';
      if (method !== 'GET' && method !== 'POST') throw new Error('Unexpected HTTP method.');
      const headers = new Headers(init?.headers);
      if (options.stripCsrf) headers.delete('x-csrf-token');
      headers.set('host', `${host}.erp.test`);
      headers.set('origin', `https://${host}.erp.test`);
      headers.set('sec-fetch-site', 'same-origin');
      if (session) headers.set('cookie', session.cookie);
      const body = typeof init?.body === 'string' ? init.body : undefined;
      const response = await app.inject({
        method,
        url: input,
        headers: Object.fromEntries(headers),
        ...(body === undefined ? {} : { payload: body }),
      });
      calls.push({
        url: input,
        method,
        body: body === undefined ? undefined : (JSON.parse(body) as unknown),
        sentCsrf: headers.has('x-csrf-token'),
        status: response.statusCode,
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { 'content-type': response.headers['content-type'] ?? 'application/json' },
      });
    };
    return { fetch, calls };
  };

  try {
    const reader = await signIn('acme');
    const manager = await signIn('acme', true);
    const other = await signIn('globex', true);
    const createdIds = (value: unknown): string[] => {
      const ids = (value as { ids: string[] }).ids;
      expect(Array.isArray(ids) && ids.every((id) => typeof id === 'string')).toBe(true);
      return ids;
    };
    const firstId = (value: unknown): string => {
      const id = createdIds(value)[0];
      if (id === undefined) throw new Error('Expected one created fixture record.');
      return id;
    };
    const currencyId = firstId(
      await rpc('acme', manager, 'rpc.currency', 'create', { values: { code: 'DZD' } }),
    );
    const [alphaId, betaId, hiddenId, editId] = createdIds(
      await rpc('acme', manager, 'acc.partner', 'create', {
        values: [
          {
            name: 'Client Alpha',
            city: 'Alger',
            companyId: FIRST_COMPANY,
            currencyId,
            amount: 12345,
            internalMargin: 777,
          },
          { name: 'Client Beta', city: 'Oran', companyId: FIRST_COMPANY },
          { name: 'Client Hidden', city: 'Secret company', companyId: SECOND_COMPANY },
          {
            name: 'Client Edit',
            city: 'Alger',
            companyId: FIRST_COMPANY,
            currencyId,
            amount: 12345,
          },
        ],
      }),
    ) as [string, string, string, string];
    const otherId = firstId(
      await rpc('globex', other, 'acc.partner', 'create', {
        values: { name: 'Globex only', companyId: FIRST_COMPANY },
      }),
    );
    return {
      acme,
      globex,
      reader,
      manager,
      other,
      currencyId,
      alphaId,
      betaId,
      hiddenId,
      editId,
      otherId,
      browser,
      signIn,
      rpc,
      logout: async (host: string, session: BrowserSession) => {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/logout',
          headers: {
            host: `${host}.erp.test`,
            origin: `https://${host}.erp.test`,
            cookie: session.cookie,
          },
        });
        expect(response.statusCode).toBe(200);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
