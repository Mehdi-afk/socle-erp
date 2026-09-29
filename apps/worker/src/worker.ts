// SPDX-License-Identifier: LGPL-3.0-only
//
// The worker process: on every tick, for each tenant of the PostgreSQL server, the pending
// attachments are scanned and the due scheduled tasks queued; pg-boss hands the queued runs
// to `runCron`. The pg-boss tables live in the queue database (by default the administration
// database of the server), never in a tenant's database. Several workers may run side by side:
// every step takes its rows with FOR UPDATE SKIP LOCKED.
import { createPgDatabase, type Executor } from '@socle/orm-pg';
import {
  createTenantSource,
  isTenantName,
  listTenants,
  type ClamavConfig,
  type S3Client,
} from '@socle/runtime';
import { PgBoss } from 'pg-boss';
import { z } from 'zod';

import { enqueueDueCrons, runCron, type CronQueue } from './cron.js';
import { scanPendingAttachments } from './scan.js';

/** The pg-boss queue of scheduled task runs. */
export const CRON_QUEUE = 'socle-cron';

export interface WorkerOptions {
  /** Administration URL of the PostgreSQL server (lists the tenants). */
  readonly adminUrl: string;
  /** Database of the pg-boss tables (default: `adminUrl`). */
  readonly queueUrl?: string | undefined;
  readonly moduleRoots: readonly string[];
  /** Antivirus scanning of attachments, when both are given. */
  readonly s3?: S3Client | undefined;
  readonly clamav?: ClamavConfig | undefined;
  /** Milliseconds between ticks (default 60 000); 0 disables the timer (tests call `tick`). */
  readonly tickMs?: number | undefined;
  /** Seconds between two polls of the queue (default 2). */
  readonly pollingSeconds?: number | undefined;
  /** Called for every error that does not stop the worker. */
  readonly onError?: ((error: unknown, context: string) => void) | undefined;
}

export interface Worker {
  /** One pass over every tenant (what the timer does). */
  tick(): Promise<void>;
  stop(): Promise<void>;
}

const cronJob = z.object({
  tenant: z.string().refine(isTenantName),
  cronId: z.uuid(),
});

/** Starts the worker: pg-boss, the queue consumer and the tick timer. */
export async function startWorker(options: WorkerOptions): Promise<Worker> {
  const onError = options.onError ?? (() => undefined);
  const admin = createPgDatabase({
    connectionString: options.adminUrl,
    max: 2,
    applicationName: 'socle:worker',
  });
  const source = createTenantSource({
    adminUrl: options.adminUrl,
    moduleRoots: options.moduleRoots,
  });
  const pools = new Map<string, Executor>();
  const tenantDb = (tenant: string, connectionString: string): Executor => {
    let db = pools.get(tenant);
    if (!db) {
      db = createPgDatabase({ connectionString, max: 2, applicationName: 'socle:worker' });
      pools.set(tenant, db);
    }
    return db;
  };

  const boss = new PgBoss({
    connectionString: options.queueUrl ?? options.adminUrl,
    schema: 'pgboss',
    application_name: 'socle:worker',
    max: 4,
  });
  boss.on('error', (error) => {
    onError(error, 'queue');
  });
  await boss.start();
  // One run per task at most, queued or running.
  if ((await boss.getQueue(CRON_QUEUE)) === null) {
    await boss.createQueue(CRON_QUEUE, { policy: 'exclusive' });
  }
  const queue: CronQueue = {
    send: async (tenant, cronId) =>
      (await boss.send(CRON_QUEUE, { tenant, cronId }, { singletonKey: `${tenant}:${cronId}` })) !==
      null,
  };

  await boss.work(
    CRON_QUEUE,
    { pollingIntervalSeconds: options.pollingSeconds ?? 2 },
    async (jobs) => {
      for (const job of jobs) {
        const data = cronJob.safeParse(job.data);
        if (!data.success) continue;
        const tenant = await source.resolve(data.data.tenant);
        if (!tenant) continue;
        await runCron({
          db: tenantDb(data.data.tenant, tenant.connectionString),
          registry: tenant.registry,
          security: tenant.security,
          manifests: tenant.manifests,
          cronId: data.data.cronId,
        });
      }
    },
  );

  let running: Promise<void> | undefined;
  const pass = async (): Promise<void> => {
    for (const name of await listTenants(admin)) {
      try {
        const tenant = await source.resolve(name);
        if (!tenant) continue;
        const db = tenantDb(name, tenant.connectionString);
        if (options.s3 && options.clamav) {
          await scanPendingAttachments({
            db,
            registry: tenant.registry,
            security: tenant.security,
            s3: options.s3,
            clamav: options.clamav,
          });
        }
        await enqueueDueCrons({ tenant: name, db, registry: tenant.registry, queue });
      } catch (error) {
        // One tenant in trouble never stops the others.
        onError(error, `tenant ${name}`);
      }
    }
  };
  // Ticks never overlap: a slow pass delays the next one.
  const tick = (): Promise<void> => {
    running ??= pass().finally(() => {
      running = undefined;
    });
    return running;
  };
  const timer =
    (options.tickMs ?? 60_000) > 0
      ? setInterval(() => {
          tick().catch((error: unknown) => {
            onError(error, 'tick');
          });
        }, options.tickMs ?? 60_000)
      : undefined;

  return {
    tick,
    async stop() {
      if (timer) clearInterval(timer);
      await running?.catch(() => undefined);
      await boss.stop({ graceful: true, close: true });
      await Promise.all([...pools.values()].map((db) => db.destroy()));
      await source.close();
      await admin.destroy();
    },
  };
}
