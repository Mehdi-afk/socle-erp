// SPDX-License-Identifier: LGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { main } from '@socle/cli';
import { createAccessControl, createEnvironment } from '@socle/framework';
import { createPgDatabase, createPgStorage, type Executor } from '@socle/orm-pg';
import {
  createTenantSource,
  databaseUrl,
  tenantDatabase,
  type ResolvedTenant,
  type TenantSource,
} from '@socle/runtime';
import { runCron } from '@socle/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

const MODULES = join(import.meta.dirname, '..', '..', '..', '..', 'modules');
let db: Executor;
let source: TenantSource;
let tenant: ResolvedTenant;
let cronId: string;
let activityId: string;

beforeAll(async () => {
  const pgUrl = inject('pgUrl');
  const name = `reminders${randomBytes(4).toString('hex')}`;
  const io = {
    env: { SOCLE_DATABASE_URL: pgUrl, SOCLE_MODULE_PATHS: MODULES },
    cwd: MODULES,
    out: { line: () => undefined },
    err: { line: () => undefined },
  };
  expect(await main(['db', 'create', name], io)).toBe(0);
  expect(await main(['module', 'install', name, 'mail'], io)).toBe(0);
  source = createTenantSource({ adminUrl: pgUrl, moduleRoots: [MODULES] });
  tenant = (await source.resolve(name)) as ResolvedTenant;
  db = createPgDatabase({ connectionString: databaseUrl(pgUrl, tenantDatabase(name)), max: 4 });
  const { rows } = await sql<{ record_id: string }>`select record_id from socle_external_id
    where module = 'mail' and name = 'activity_reminders'`.execute(db);
  cronId = rows[0]?.record_id as string;
  expect(cronId).toBeTruthy();
  activityId = await seedActivity();
}, 300_000);

afterAll(async () => {
  await db.destroy();
  await source.close();
});

async function seedActivity(): Promise<string> {
  return db.transaction().execute(async (trx) => {
    const env = createEnvironment({
      registry: tenant.registry,
      storage: createPgStorage(trx, tenant.registry),
      access: createAccessControl(tenant.security, tenant.registry),
      audit: { record: () => undefined },
      user: {
        id: 'public-fixture',
        groupIds: [],
        companyIds: [],
        companyId: null,
        lang: 'fr',
        tz: 'UTC',
      },
    }).sudo('Public reminder acceptance fixtures');
    const parent = await env.model('res.partner').create({ name: 'Reminder acceptance contact' });
    const types = await env.model('mail.activity.type').search([], { limit: 1 });
    const activity = await env.model('mail.activity').create({
      resModel: 'res.partner',
      resId: parent.id,
      summary: 'Public fixture reminder',
      typeId: types.id,
      assignedUserId: 'public-fixture',
      dueDate: '2000-01-01',
    });
    await env.flush();
    return activity.id;
  });
}

const run = () =>
  runCron({
    db,
    registry: tenant.registry,
    security: tenant.security,
    manifests: tenant.manifests,
    cronId,
  });
const reminders = async (id: string) =>
  (
    await sql<{ n: number }>`select count(*) as n from mail_activity_reminder
    where activity_id = ${id}::uuid`.execute(db)
  ).rows[0]?.n;

describe('mail reminder cron in PostgreSQL', () => {
  it('uses the installed cron capability and persists only one reminder under concurrent runs', async () => {
    expect(tenant.manifests.get('mail')?.capabilities).toContain('cron');
    const results = await Promise.all([run(), run()]);
    expect(results).toContain('success');
    expect(results).not.toContain('failure');
    expect(await reminders(activityId)).toBe(1);
    expect(await run()).toBe('success');
    expect(await reminders(activityId)).toBe(1);
  });
  it('rolls back the reminder and marker together, then succeeds when retried', async () => {
    const id = await seedActivity();
    // A database failure after the reminder insert exercises the actual worker transaction.
    await sql`alter table mail_activity add constraint acceptance_reject_marker
      check (reminded_at is null) not valid`.execute(db);
    try {
      expect(await run()).toBe('failure');
      expect(await reminders(id)).toBe(0);
      const { rows } = await sql<{ reminded_at: unknown }>`select reminded_at from mail_activity
        where id = ${id}::uuid`.execute(db);
      expect(rows[0]?.reminded_at).toBeNull();
      const logs = await sql<{ status: string }>`select status from ir_cron_run
        where cron_id = ${cronId}::uuid order by started_at desc limit 1`.execute(db);
      expect(logs.rows[0]?.status).toBe('failure');
    } finally {
      await sql`alter table mail_activity drop constraint acceptance_reject_marker`.execute(db);
    }
    expect(await run()).toBe('success');
    expect(await reminders(id)).toBe(1);
  });
});
