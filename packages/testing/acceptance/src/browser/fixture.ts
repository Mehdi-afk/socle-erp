// SPDX-License-Identifier: LGPL-3.0-only
// Public demonstration data only. This harness never loads application environment files.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { main } from '@socle/cli';
import {
  buildSecurityPolicy,
  createAccessControl,
  createEnvironment,
  type UserContext,
} from '@socle/framework';
import { applySchema, createPgDatabase, createPgStorage, type Executor } from '@socle/orm-pg';
import { compose, databaseUrl, loadModules, tenantDatabase } from '@socle/runtime';
import { runCron, type CronRunStatus } from '@socle/worker';
import {
  buildServer,
  createTenantDirectory,
  createUser,
  listSessions,
  revokeSession,
} from '@socle/server';
import { sql } from 'kysely';
import { createServer, type ViteDevServer } from 'vite';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');
const MODULES = join(ROOT, 'modules');
const WEB = join(ROOT, 'apps', 'web');
const FAST = { memoryKiB: 1024, passes: 1, parallelism: 1 };
const HOST = 'demo.erp.test';
const READER_GROUP = 'browser_demo.group_reader';

export const DEMO_CREDENTIALS = {
  manager: { login: 'manager@demo.test', password: 'public-web-demo-password' },
  reader: { login: 'reader@demo.test', password: 'public-web-demo-password' },
  colleague: { login: 'colleague@demo.test', password: 'public-web-demo-password' },
} as const;

export interface WebBrowserFixture {
  readonly url: string;
  readonly contactId: string;
  readonly foreignContactId: string;
  readonly credentials: typeof DEMO_CREDENTIALS;
  readContact(): Promise<{ name: string; city: string | null }>;
  revokeManagerSessions(): Promise<void>;
  runActivityReminders(): Promise<CronRunStatus>;
  close(): Promise<void>;
}

/** Installs real base metadata and serves the real application over loopback HTTP. */
export async function createWebBrowserFixture(pgUrl: string): Promise<WebBrowserFixture> {
  const tenant = `web${randomBytes(4).toString('hex')}`;
  const io = {
    env: { SOCLE_DATABASE_URL: pgUrl, SOCLE_MODULE_PATHS: MODULES },
    cwd: ROOT,
    out: { line: () => undefined },
    err: { line: () => undefined },
  };
  for (const argv of [
    ['db', 'create', tenant],
    ['module', 'install', tenant, 'base'],
    ['module', 'install', tenant, 'mail'],
  ]) {
    if ((await main(argv, io)) !== 0) throw new Error('Could not install the browser fixture.');
  }
  const modules = await loadModules([MODULES]);
  const { registry, views } = compose(modules, ['base', 'mail']);
  const security = buildSecurityPolicy(
    [
      modules.get('base').security,
      modules.get('mail').security,
      {
        module: 'browser_demo',
        groups: [{ id: READER_GROUP, name: { fr: 'Lecteur de démonstration' } }],
        access: [
          'res.partner',
          'res.company',
          'res.currency',
          'res.country',
          'res.country.state',
        ].map((model) => ({ model, group: READER_GROUP, read: true })),
      },
    ],
    (model) => registry.has(model),
  );
  const connectionString = databaseUrl(pgUrl, tenantDatabase(tenant));
  const db = createPgDatabase({ connectionString, max: 2 });
  const tenants = createTenantDirectory({
    resolve: (name) =>
      Promise.resolve(
        name === 'demo' ? { connectionString, registry, views, security } : undefined,
      ),
  });
  // Filled with the actual Vite port before the fixture URL is exposed to a browser.
  const allowedOrigins: string[] = [];
  const app = buildServer({
    baseDomain: 'erp.test',
    tenants,
    allowedOrigins,
    logger: false,
    passwordPolicy: { minLength: 12 },
    session: { idleMs: 3_600_000, absoluteMs: 86_400_000, maxFailures: 20, cost: FAST },
    rateLimit: { capacity: 10_000, refillPerSecond: 10_000 },
    loginRateLimit: { capacity: 1000, refillPerSecond: 1000 },
  });
  let vite: ViteDevServer | undefined;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const outcomes = await Promise.allSettled([vite?.close(), app.close()]);
    outcomes.push(...(await Promise.allSettled([tenants.close(), db.destroy()])));
    if (outcomes.some((outcome) => outcome.status === 'rejected'))
      throw new Error('Could not close every browser fixture resource.');
  };
  try {
    await applySchema(db, registry, { security });
    const administrator: UserContext = {
      id: 'demo-manager',
      groupIds: ['base.group_system'],
      companyIds: [],
      companyId: null,
      lang: 'fr',
      tz: 'Africa/Algiers',
    };
    const { companyId, contactId, foreignContactId } = await db
      .transaction()
      .execute(async (trx) => {
        const env = createEnvironment({
          registry,
          storage: createPgStorage(trx, registry),
          user: administrator,
          access: createAccessControl(security, registry),
          audit: { record: () => undefined },
        });
        const seed = env.sudo('Public browser demonstration fixtures');
        const currency = await seed.model('res.currency').search([['code', '=', 'DZD']]);
        const country = await seed.model('res.country').search([['code', '=', 'DZ']]);
        const company = await seed.model('res.company').create({
          name: 'Société de démonstration',
          currencyId: currency.ids[0],
          countryId: country.ids[0],
          city: 'Alger',
        });
        const contacts = await seed.model('res.partner').create([
          {
            name: 'Atelier Atlas',
            kind: 'company',
            email: 'atlas@example.test',
            phone: '+213 21 00 00 01',
            city: 'Alger',
            countryId: country.ids[0],
            companyId: company.id,
          },
          {
            name: 'Bureau Oran',
            kind: 'company',
            email: 'oran@example.test',
            phone: '+213 41 00 00 02',
            city: 'Oran',
            countryId: country.ids[0],
            companyId: company.id,
          },
        ]);
        await env.flush();
        const first = contacts.ids[0];
        if (!first) throw new Error('The browser contact fixture was not created.');
        const foreignCompany = await seed
          .model('res.company')
          .create({ name: 'Société étrangère de test', currencyId: currency.ids[0] });
        const foreignContact = await seed
          .model('res.partner')
          .create({ name: 'Contact hors périmètre', companyId: foreignCompany.id });
        return { companyId: company.id, contactId: first, foreignContactId: foreignContact.id };
      });
    for (const role of ['manager', 'reader', 'colleague'] as const) {
      await createUser(
        db,
        {
          id: `demo-${role}`,
          ...DEMO_CREDENTIALS[role],
          groupIds:
            role === 'manager'
              ? ['base.group_system']
              : role === 'reader'
                ? [READER_GROUP]
                : ['base.group_user'],
          companyIds: [companyId],
          companyId,
        },
        FAST,
      );
    }
    const target = await app.listen({ host: '127.0.0.1', port: 0 });
    // A single, public fixture tenant. Never rewrite Origin, cookies or the CSRF header.
    const proxy = { target, headers: { host: HOST } };
    vite = await createServer({
      configFile: join(WEB, 'vite.config.ts'),
      root: WEB,
      envFile: false,
      logLevel: 'error',
      clearScreen: false,
      server: {
        host: '127.0.0.1',
        port: 0,
        strictPort: true,
        open: false,
        allowedHosts: ['localhost'],
        proxy: {
          '/auth/': proxy,
          '/web/metadata': proxy,
          '/rpc/': proxy,
          '/mail/': proxy,
        },
      },
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === 'string')
      throw new Error('The browser web server has no TCP address.');
    const url = `http://localhost:${String(address.port)}`;
    allowedOrigins.push(url);
    return {
      url,
      credentials: DEMO_CREDENTIALS,
      contactId,
      foreignContactId,
      readContact: () => readContact(db, contactId),
      async runActivityReminders() {
        const { rows } = await sql<{ record_id: string }>`select record_id from socle_external_id
          where module = 'mail' and name = 'activity_reminders'`.execute(db);
        if (!rows[0]) throw new Error('The reminder schedule was not installed.');
        return runCron({
          db,
          registry,
          security,
          manifests: new Map(['base', 'mail'].map((name) => [name, modules.get(name).manifest])),
          cronId: rows[0].record_id,
        });
      },
      async revokeManagerSessions() {
        for (const session of await listSessions(db, administrator.id, undefined)) {
          await revokeSession(db, administrator.id, session.id);
        }
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function readContact(
  db: Executor,
  id: string,
): Promise<{ name: string; city: string | null }> {
  const result = await sql<{
    name: string;
    city: string | null;
  }>`select name, city from res_partner where id = ${id}::uuid`.execute(db);
  const row = result.rows[0];
  if (!row) throw new Error('The browser contact fixture is missing.');
  return row;
}
