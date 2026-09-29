// SPDX-License-Identifier: LGPL-3.0-only
//
// Scheduled tasks (lot 2.1, `ir.cron`). Two steps:
// 1. `enqueueDueCrons`, on every tick of the worker and for each tenant: the active tasks whose
//    time has come are queued (pg-boss, one job at most per task, queued or running) and their
//    next run moved forward on their grid.
// 2. `runCron`, for each job: the task row stays locked while it runs (FOR UPDATE SKIP LOCKED:
//    a second worker, or a second job of the same task, skips it), the method is called as the
//    system in one transaction, and the outcome is logged in `ir.cron.run`. A failure rolls the
//    task's work back; only the log line remains.
// A task runs only if it was declared by a module with the `cron` capability, and only a
// server method of the model, without argument.
import {
  buildSecurityPolicy,
  createAccessControl,
  createCapabilityGuard,
  createEnvironment,
  type AuditEvent,
  type Environment,
  type ModelRegistry,
  type ModuleManifest,
  type SecurityPolicy,
} from '@socle/framework';
import {
  appendAudit,
  auditEntry,
  createPgStorage,
  EXTERNAL_ID_TABLE,
  type Executor,
} from '@socle/orm-pg';
import { isCronInterval, nextCallAfter, type CronIntervalUnit } from '@socle/runtime';
import { sql } from 'kysely';

/** Where due tasks are queued (pg-boss in production). */
export interface CronQueue {
  /** Queues a run of the task; false when one is already queued or running. */
  send(tenant: string, cronId: string): Promise<boolean>;
}

export interface EnqueueOptions {
  readonly tenant: string;
  readonly db: Executor;
  readonly registry: ModelRegistry;
  readonly queue: CronQueue;
  readonly now?: Date | undefined;
  /** Tasks per call (default 50). */
  readonly batch?: number | undefined;
}

/** Queues the due tasks of a tenant; returns how many were queued. */
export async function enqueueDueCrons(options: EnqueueOptions): Promise<number> {
  if (!options.registry.has('ir.cron')) return 0;
  const now = options.now ?? new Date();
  return options.db.transaction().execute(async (trx) => {
    const due = await sql<{
      id: string;
      next_call: Date | string;
      interval_number: number | null;
      interval_type: string | null;
    }>`select id, next_call, interval_number, interval_type from ir_cron where active and next_call <= ${now.toISOString()}::timestamptz order by next_call limit ${options.batch ?? 50} for update skip locked`.execute(
      trx,
    );
    let queued = 0;
    for (const task of due.rows) {
      const interval = {
        number: task.interval_number ?? 1,
        unit: (task.interval_type ?? 'days') as CronIntervalUnit,
      };
      // A task with a broken schedule is paused rather than queued in a loop.
      if (!isCronInterval(interval)) {
        await sql`update ir_cron set active = false where id = ${task.id}`.execute(trx);
        continue;
      }
      if (await options.queue.send(options.tenant, task.id)) queued += 1;
      const next = nextCallAfter(
        new Date(task.next_call).toISOString(),
        interval,
        now.toISOString(),
      );
      await sql`update ir_cron set next_call = ${next} where id = ${task.id}`.execute(trx);
    }
    return queued;
  });
}

/** What happened to a queued run. */
export type CronRunStatus = 'success' | 'failure' | 'refused' | 'skipped';

export interface RunCronOptions {
  readonly db: Executor;
  readonly registry: ModelRegistry;
  readonly security?: SecurityPolicy | undefined;
  /** Manifests of the installed modules. */
  readonly manifests: ReadonlyMap<string, ModuleManifest>;
  readonly cronId: string;
  readonly now?: (() => Date) | undefined;
}

const MAX_MESSAGE = 500;

function systemEnvironment(
  trx: Executor,
  options: RunCronOptions,
  events: AuditEvent[],
  reason: string,
): Environment {
  return createEnvironment({
    registry: options.registry,
    storage: createPgStorage(trx, options.registry),
    user: { id: 'cron', groupIds: [], companyIds: [], companyId: null, lang: 'fr', tz: 'UTC' },
    access: createAccessControl(
      options.security ?? buildSecurityPolicy([], () => false),
      options.registry,
    ),
    audit: { record: (event) => events.push(event) },
  }).sudo(reason);
}

/** The module that declared a task in its data, if any. */
async function ownerOf(trx: Executor, cronId: string): Promise<string | undefined> {
  const result = await sql<{
    module: string;
  }>`select module from ${sql.table(EXTERNAL_ID_TABLE)} where model = 'ir.cron' and record_id = ${cronId}::uuid`.execute(
    trx,
  );
  return result.rows[0]?.module;
}

/** Why a task may not run, or undefined when it may. */
function refusal(
  options: RunCronOptions,
  owner: string | undefined,
  modelName: string,
  method: string,
): string | undefined {
  if (owner === undefined) return 'The task was not declared by a module.';
  const manifest = options.manifests.get(owner);
  if (manifest === undefined || !createCapabilityGuard(manifest).allows('cron')) {
    return `Module "${owner}" did not declare the capability "cron".`;
  }
  if (
    !options.registry.has(modelName) ||
    !options.registry.get(modelName).serverMethodNames.includes(method)
  ) {
    return `"${modelName}.${method}" is not a server method.`;
  }
  return undefined;
}

const truncate = (text: string): string =>
  text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text;

/** Runs one queued task, under its lock, and logs the outcome. */
export async function runCron(options: RunCronOptions): Promise<CronRunStatus> {
  if (!options.registry.has('ir.cron')) return 'skipped';
  const clock = options.now ?? (() => new Date());
  const startedAt = clock().toISOString();

  const log = async (
    trx: Executor,
    events: AuditEvent[],
    env: Environment,
    status: Exclude<CronRunStatus, 'skipped'>,
    message: string | null,
  ): Promise<void> => {
    const endedAt = clock().toISOString();
    await env.model('ir.cron').browse([options.cronId]).write({ lastCall: startedAt });
    await env
      .model('ir.cron.run')
      .create({ cronId: options.cronId, startedAt, endedAt, status, message });
    await env.flush();
    await appendAudit(trx, events.map(auditEntry));
  };

  let failure: string;
  try {
    return await options.db.transaction().execute(async (trx): Promise<CronRunStatus> => {
      const locked =
        await sql`select id from ir_cron where id = ${options.cronId}::uuid and active for update skip locked`.execute(
          trx,
        );
      // Missing, paused, or running elsewhere.
      if (locked.rows.length === 0) return 'skipped';

      const events: AuditEvent[] = [];
      const system = systemEnvironment(trx, options, events, 'scheduled task');
      const [task] = (await system
        .model('ir.cron')
        .browse([options.cronId])
        .read(['name', 'modelName', 'method'])) as [
        { name: string; modelName: string; method: string },
      ];
      const reason = refusal(
        options,
        await ownerOf(trx, options.cronId),
        task.modelName,
        task.method,
      );
      if (reason !== undefined) {
        await log(trx, events, system, 'refused', reason);
        return 'refused';
      }

      const env = systemEnvironment(trx, options, events, `scheduled task: ${task.name}`);
      const target = env.model(task.modelName) as unknown as Record<string, () => unknown>;
      await (target[task.method] as () => unknown).call(target);
      await env.flush();
      await log(trx, events, env, 'success', null);
      return 'success';
    });
  } catch (error) {
    failure = truncate(error instanceof Error ? error.message : String(error));
  }

  // The task's work was rolled back; the failure is logged in a transaction of its own.
  return options.db.transaction().execute(async (trx): Promise<CronRunStatus> => {
    const locked =
      await sql`select id from ir_cron where id = ${options.cronId}::uuid for update skip locked`.execute(
        trx,
      );
    if (locked.rows.length === 0) return 'failure';
    const events: AuditEvent[] = [];
    await log(
      trx,
      events,
      systemEnvironment(trx, options, events, 'scheduled task'),
      'failure',
      failure,
    );
    return 'failure';
  });
}
