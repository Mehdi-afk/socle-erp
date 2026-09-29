// SPDX-License-Identifier: LGPL-3.0-only
//
// Scheduled tasks end to end (lot 2.1): real `base` module and two test modules installed by the
// CLI in a real PostgreSQL database, then the worker's steps. Due tasks are queued once and moved
// forward on their grid; a task runs as the system, under a lock, and a failure rolls its work
// back and stays in the log; a module without the `cron` capability, or a method that is not a
// server method, is refused; the whole loop runs on pg-boss.
import { randomBytes } from 'node:crypto';
import { delimiter, join } from 'node:path';

import { main } from '@socle/cli';
import { createPgDatabase, verifyAudit, type Executor } from '@socle/orm-pg';
import {
  createTenantSource,
  databaseUrl,
  tenantDatabase,
  type ResolvedTenant,
  type TenantSource,
} from '@socle/runtime';
import { enqueueDueCrons, runCron, startWorker, type CronQueue } from '@socle/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

const REPOSITORY_MODULES = join(import.meta.dirname, '..', '..', '..', '..', 'modules');
const CRON_MODULES = join(import.meta.dirname, '..', 'cron-modules');

let pgUrl: string;
let name: string;
let source: TenantSource;
let tenant: ResolvedTenant;
let db: Executor;

beforeAll(async () => {
  pgUrl = inject('pgUrl');
  name = `cron${randomBytes(4).toString('hex')}`;
  const io = {
    env: {
      SOCLE_DATABASE_URL: pgUrl,
      SOCLE_MODULE_PATHS: [REPOSITORY_MODULES, CRON_MODULES].join(delimiter),
    },
    cwd: REPOSITORY_MODULES,
    out: { line: () => undefined },
    err: { line: () => undefined },
  };
  expect(await main(['db', 'create', name], io)).toBe(0);
  expect(await main(['module', 'install', name, 'base'], io)).toBe(0);
  expect(await main(['module', 'install', name, 'acc_nocron'], io)).toBe(0);
  source = createTenantSource({
    adminUrl: pgUrl,
    moduleRoots: [REPOSITORY_MODULES, CRON_MODULES],
  });
  tenant = (await source.resolve(name)) as ResolvedTenant;
  db = createPgDatabase({ connectionString: databaseUrl(pgUrl, tenantDatabase(name)), max: 4 });
}, 300_000);

afterAll(async () => {
  await db.destroy();
  await source.close();
});

const idOf = async (task: string): Promise<string> => {
  const found = await sql<{ record_id: string }>`
    select record_id from socle_external_id where model = 'ir.cron' and name = ${task}`.execute(db);
  return found.rows[0]?.record_id as string;
};

const runs = async (task: string) =>
  (
    await sql<{ status: string; message: string | null }>`
      select status, message from ir_cron_run where cron_id = ${await idOf(task)}::uuid
      order by started_at`.execute(db)
  ).rows;

const jobs = async (label: string): Promise<number> =>
  (await sql<{ n: string }>`select count(*) as n from acc_job where label = ${label}`.execute(db))
    .rows[0]?.n as unknown as number;

const run = (task: string, id: string) =>
  runCron({
    db,
    registry: tenant.registry,
    security: tenant.security,
    manifests: tenant.manifests,
    cronId: id,
  }).then((status) => ({ task, status }));

describe('scheduled tasks', () => {
  it('queue every due task once and move it forward on its grid', async () => {
    const sent: string[] = [];
    const queue: CronQueue = {
      send: (_tenant, cronId) => {
        sent.push(cronId);
        return Promise.resolve(true);
      },
    };
    const now = new Date('2026-09-29T10:00:00.000Z');
    const options = { tenant: name, db, registry: tenant.registry, queue, now };
    expect(await enqueueDueCrons(options)).toBe(4);
    expect(new Set(sent).size).toBe(4);
    const next = await sql<{ next_call: Date | string }>`select next_call from ir_cron`.execute(db);
    // Daily since 1 January at midnight: tomorrow at midnight, whatever the pause.
    expect(next.rows.map((row) => new Date(row.next_call).toISOString())).toEqual(
      Array(4).fill('2026-09-30T00:00:00.000Z'),
    );
    expect(await enqueueDueCrons(options)).toBe(0);
    // A queue that already holds the task (it returns false): nothing counted, still moved on.
    await sql`update ir_cron set next_call = '2026-01-01T00:00:00Z'`.execute(db);
    expect(
      await enqueueDueCrons({ ...options, queue: { send: () => Promise.resolve(false) } }),
    ).toBe(0);
  });

  it('run as the system and log the outcome; failures roll back, refusals are explained', async () => {
    const [bump, explode, unlink, sneaky] = await Promise.all(
      ['bump', 'explode', 'unlink', 'sneaky'].map(idOf),
    );
    expect(await run('bump', bump as string)).toEqual({ task: 'bump', status: 'success' });
    expect(await run('explode', explode as string)).toEqual({ task: 'explode', status: 'failure' });
    expect(await run('unlink', unlink as string)).toEqual({ task: 'unlink', status: 'refused' });
    expect(await run('sneaky', sneaky as string)).toEqual({ task: 'sneaky', status: 'refused' });

    expect(await runs('bump')).toEqual([{ status: 'success', message: null }]);
    expect(await jobs('bump')).toBe(1);
    // The failed task's own work was rolled back; only the log line remains.
    expect(await jobs('explode')).toBe(0);
    expect(await runs('explode')).toEqual([{ status: 'failure', message: 'boom' }]);
    expect((await runs('unlink'))[0]?.message).toContain('is not a server method');
    expect((await runs('sneaky'))[0]?.message).toContain('did not declare the capability "cron"');
    expect(await verifyAudit(db)).toMatchObject({ ok: true });
  });

  it('skip a paused task and a task another worker is running', async () => {
    const bump = await idOf('bump');
    await sql`update ir_cron set active = false where id = ${bump}::uuid`.execute(db);
    expect((await run('bump', bump)).status).toBe('skipped');
    await sql`update ir_cron set active = true where id = ${bump}::uuid`.execute(db);

    // Another worker holds the row: this run is skipped, not queued behind it.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = db.transaction().execute(async (trx) => {
      await sql`select id from ir_cron where id = ${bump}::uuid for update`.execute(trx);
      locked();
      await held;
    });
    await acquired;
    try {
      expect((await run('bump', bump)).status).toBe('skipped');
    } finally {
      release();
      await holder;
    }
    expect(await jobs('bump')).toBe(1);
  });

  it('run on the worker loop with pg-boss, once per due task', async () => {
    await sql`update ir_cron set next_call = '2026-01-01T00:00:00Z' where id = ${await idOf('bump')}::uuid`.execute(
      db,
    );
    const errors: unknown[] = [];
    const worker = await startWorker({
      adminUrl: pgUrl,
      moduleRoots: [REPOSITORY_MODULES, CRON_MODULES],
      tickMs: 0,
      pollingSeconds: 1,
      onError: (error, context) => errors.push(`${context}: ${String(error)}`),
    });
    try {
      // Two passes: the second finds nothing to queue for `bump` (already moved on).
      await worker.tick();
      await worker.tick();
      const deadline = Date.now() + 30_000;
      while ((await runs('bump')).length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect((await runs('bump')).map((entry) => entry.status)).toEqual(['success', 'success']);
      expect(await jobs('bump')).toBe(2);
      expect(errors.filter((error) => String(error).includes(name))).toEqual([]);
    } finally {
      await worker.stop();
    }
  }, 60_000);
});
