// SPDX-License-Identifier: LGPL-3.0-only
//
// Attachments end to end (lot 2.1 and the security tests of phase 2): the real `base` module
// installed by the CLI, the HTTP server with SeaweedFS, the worker with ClamAV. A clean file is
// downloadable once scanned; the EICAR test file is marked infected and never downloadable;
// names with `../` are sanitised; users of another company reach nothing.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { main } from '@socle/cli';
import { createAccessControl, createEnvironment } from '@socle/framework';
import { createPgDatabase, createPgStorage, verifyAudit, type Executor } from '@socle/orm-pg';
import {
  createS3Client,
  createTenantSource,
  databaseUrl,
  tenantDatabase,
  type ResolvedTenant,
  type TenantSource,
} from '@socle/runtime';
import { buildServer, createTenantDirectory, createUser } from '@socle/server';
import {
  startClamav,
  startSeaweedfs,
  type EphemeralClamav,
  type EphemeralS3,
} from '@socle/testing';
import { scanPendingAttachments } from '@socle/worker';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { csrfHeader } from './harness.js';

const REPOSITORY_MODULES = join(import.meta.dirname, '..', '..', '..', '..', 'modules');
const FAST = { memoryKiB: 1024, passes: 1, parallelism: 1 };
// Assembled at run time so that no antivirus flags this source file.
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR', '-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join(
  '',
);
const PDF = new TextEncoder().encode('%PDF-1.4\n% Devis n° 12\n%%EOF\n');

let s3: EphemeralS3;
let clamav: EphemeralClamav;
let source: TenantSource;
let tenant: ResolvedTenant;
let db: Executor;
let app: ReturnType<typeof buildServer>;
let partnerId = '';

beforeAll(async () => {
  const pgUrl = inject('pgUrl');
  [s3, clamav] = [await startSeaweedfs(), await startClamav()];
  const name = `att${randomBytes(4).toString('hex')}`;
  const io = {
    env: { SOCLE_DATABASE_URL: pgUrl, SOCLE_MODULE_PATHS: REPOSITORY_MODULES },
    cwd: REPOSITORY_MODULES,
    out: { line: () => undefined },
    err: { line: () => undefined },
  };
  expect(await main(['db', 'create', name], io)).toBe(0);
  expect(await main(['module', 'install', name, 'base'], io)).toBe(0);
  source = createTenantSource({ adminUrl: pgUrl, moduleRoots: [REPOSITORY_MODULES] });
  tenant = (await source.resolve(name)) as ResolvedTenant;
  db = createPgDatabase({ connectionString: databaseUrl(pgUrl, tenantDatabase(name)), max: 2 });

  // Two companies, a contact of the first one, a user in each company.
  const [c1, c2] = await db.transaction().execute(async (trx) => {
    const env = createEnvironment({
      registry: tenant.registry,
      storage: createPgStorage(trx, tenant.registry),
      user: { id: 'setup', groupIds: [], companyIds: [], companyId: null, lang: 'fr', tz: 'UTC' },
      access: createAccessControl(tenant.security, tenant.registry),
      audit: { record: () => undefined },
    }).sudo('test fixtures');
    const eur = await env.model('res.currency').search([['code', '=', 'EUR']]);
    const companies = await env.model('res.company').create([
      { name: 'Acme', currencyId: eur.ids[0] as string },
      { name: 'Globex', currencyId: eur.ids[0] as string },
    ]);
    const [first, second] = companies.ids as [string, string];
    partnerId = (await env.model('res.partner').create({ name: 'Client A', companyId: first }))
      .ids[0] as string;
    await env.flush();
    return [first, second];
  });
  for (const [login, company] of [
    ['alice@acme.test', c1],
    ['bob@globex.test', c2],
  ] as const) {
    await createUser(
      db,
      {
        id: login.split('@')[0] ?? login,
        login,
        password: 'pass-word-1',
        groupIds: ['base.group_user'],
        companyIds: [company],
        companyId: company,
      },
      FAST,
    );
  }

  const bucket = createS3Client({
    endpoint: s3.endpoint,
    region: 'us-east-1',
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
    bucket: 'socle-files',
  });
  await bucket.ensureBucket();
  const tenants = createTenantDirectory({
    resolve: (host) => (host === 'acme' ? source.resolve(name) : Promise.resolve(undefined)),
  });
  app = buildServer({
    baseDomain: 'erp.test',
    tenants,
    logger: false,
    session: { idleMs: 3_600_000, absoluteMs: 86_400_000, maxFailures: 5, cost: FAST },
    rateLimit: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
    attachments: { s3: bucket, maxBytes: 64 * 1024 },
  });
}, 300_000);

afterAll(async () => {
  await app.close();
  await db.destroy();
  await source.close();
  await clamav.stop();
  await s3.stop();
});

const request = (
  method: 'GET' | 'POST',
  url: string,
  options: { cookie?: string; body?: Uint8Array; headers?: Record<string, string> } = {},
) =>
  app.inject({
    method,
    url,
    headers: {
      host: 'acme.erp.test',
      ...(options.cookie ? { cookie: options.cookie, ...csrfHeader(options.cookie) } : {}),
      ...(options.body ? { 'content-type': 'application/octet-stream' } : {}),
      ...(options.headers ?? {}),
    },
    ...(options.body ? { payload: Buffer.from(options.body) } : {}),
  });

async function signIn(login: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { host: 'acme.erp.test' },
    payload: { login, password: 'pass-word-1' },
  });
  expect(response.statusCode, response.body).toBe(200);
  return String(response.headers['set-cookie']).split(';')[0] ?? '';
}

const upload = (cookie: string, name: string, body: Uint8Array, target = partnerId) =>
  request('POST', `/attachments/res.partner/${target}`, {
    cookie,
    body,
    headers: { 'x-file-name': encodeURIComponent(name) },
  });

describe('attachments', () => {
  it('scan every file before it can be downloaded, and never serve an infected one', async () => {
    const alice = await signIn('alice@acme.test');
    const eicar = await upload(alice, '../../etc/facture.pdf', new TextEncoder().encode(EICAR));
    expect(eicar.statusCode, eicar.body).toBe(200);
    expect(eicar.json()).toMatchObject({
      name: 'facture.pdf',
      mimetype: 'text/plain',
      scanStatus: 'pending',
    });
    const quote = await upload(alice, 'Devis été.pdf', PDF);
    expect(quote.json()).toMatchObject({ name: 'Devis été.pdf', mimetype: 'application/pdf' });
    const quoteId = quote.json<{ id: string }>().id;
    const eicarId = eicar.json<{ id: string }>().id;

    const listed = await request('GET', `/attachments/res.partner/${partnerId}`, { cookie: alice });
    expect(listed.json<{ attachments: unknown[] }>().attachments).toHaveLength(2);
    const early = await request('GET', `/attachments/${quoteId}/content`, { cookie: alice });
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ error: 'not_scanned' });

    expect(
      await scanPendingAttachments({
        db,
        registry: tenant.registry,
        security: tenant.security,
        s3: createS3Client({
          endpoint: s3.endpoint,
          region: 'us-east-1',
          accessKeyId: s3.accessKeyId,
          secretAccessKey: s3.secretAccessKey,
          bucket: 'socle-files',
        }),
        clamav: { host: clamav.host, port: clamav.port },
      }),
    ).toEqual({ clean: 1, infected: 1, failed: 0 });

    const infected = await request('GET', `/attachments/${eicarId}/content`, { cookie: alice });
    expect(infected.statusCode).toBe(409);
    expect(infected.json()).toMatchObject({ error: 'infected' });
    const clean = await request('GET', `/attachments/${quoteId}/content`, { cookie: alice });
    expect(clean.statusCode).toBe(200);
    expect(clean.headers).toMatchObject({
      'content-type': 'application/pdf',
      'x-content-type-options': 'nosniff',
    });
    expect(String(clean.headers['content-disposition'])).toContain(
      "filename*=UTF-8''Devis%20%C3%A9t%C3%A9.pdf",
    );
    expect(Buffer.from(clean.rawPayload).equals(Buffer.from(PDF))).toBe(true);
    expect(await verifyAudit(db)).toMatchObject({ ok: true });
  });

  it('refuse other companies, strangers, unknown records and oversized files', async () => {
    const alice = await signIn('alice@acme.test');
    const bob = await signIn('bob@globex.test');
    const own = await upload(alice, 'note.txt', new TextEncoder().encode('bonjour'));
    const ownId = own.json<{ id: string }>().id;

    expect((await upload(bob, 'x.txt', new TextEncoder().encode('x'))).statusCode).toBe(404);
    expect(
      (await request('GET', `/attachments/res.partner/${partnerId}`, { cookie: bob })).statusCode,
    ).toBe(404);
    expect(
      (await request('GET', `/attachments/${ownId}/content`, { cookie: bob })).statusCode,
    ).toBe(404);
    expect((await upload('', 'x.txt', new TextEncoder().encode('x'))).statusCode).toBe(401);
    expect(
      (
        await upload(
          alice,
          'x.txt',
          new TextEncoder().encode('x'),
          '0190a000-0000-7000-8000-000000000999',
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await upload(alice, 'big.bin', new Uint8Array(randomBytes(70 * 1024)))).statusCode,
    ).toBe(413);
  });
});
