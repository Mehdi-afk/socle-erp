// SPDX-License-Identifier: LGPL-3.0-only
//
// Database and module commands. Every module operation goes through orm-pg's lifecycle:
// mandatory snapshot, then one transaction (ARCHITECTURE.md §4.7).
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { SocleError } from '@socle/framework';
import {
  createPgDatabase,
  createTemplateSnapshots,
  installedModules,
  uninstallModules,
  upgradeModules,
  verifyAudit,
  type DataLoadResult,
  type Executor,
  type ModuleExport,
  type SnapshotStore,
} from '@socle/orm-pg';
import { sql } from 'kysely';

import { compose, databaseUrl, loadModules, moduleData, tenantDatabase } from '@socle/runtime';

import type { CliConfig } from './config.js';
import { planInstall, planUninstall, planUpgrade } from './plan.js';

export class CommandError extends SocleError {
  constructor(message: string) {
    super('cli.command', message);
  }
}

/** Where commands write their report (the terminal, or a buffer in tests). */
export interface Output {
  line(text: string): void;
}

export interface Context {
  readonly config: CliConfig;
  readonly out: Output;
  /** Base directory of relative paths given on the command line. */
  readonly cwd: string;
}

async function withAdmin<T>(config: CliConfig, work: (admin: Executor) => Promise<T>): Promise<T> {
  const admin = createPgDatabase({
    connectionString: config.adminUrl,
    max: 2,
    applicationName: 'socle-cli',
  });
  try {
    return await work(admin);
  } finally {
    await admin.destroy();
  }
}

async function exists(admin: Executor, database: string): Promise<boolean> {
  const result = await sql<{
    found: number;
  }>`select 1 as found from pg_database where datname = ${database}`.execute(admin);
  return result.rows.length > 0;
}

interface Tenant {
  readonly name: string;
  readonly database: string;
  readonly admin: Executor;
  readonly db: Executor;
  readonly snapshots: SnapshotStore;
}

async function withTenant<T>(
  context: Context,
  tenant: string,
  work: (t: Tenant) => Promise<T>,
): Promise<T> {
  const database = tenantDatabase(tenant);
  return withAdmin(context.config, async (admin) => {
    if (!(await exists(admin, database))) {
      throw new CommandError(
        `Tenant "${tenant}" has no database (run "socle db create ${tenant}").`,
      );
    }
    const db = createPgDatabase({
      connectionString: databaseUrl(context.config.adminUrl, database),
      max: 2,
      applicationName: 'socle-cli',
    });
    try {
      return await work({
        name: tenant,
        database,
        admin,
        db,
        snapshots: createTemplateSnapshots(admin, database),
      });
    } finally {
      await db.destroy();
    }
  });
}

// ─── db ──────────────────────────────────────────────────────────────────────────────────

export async function dbCreate(context: Context, tenant: string): Promise<void> {
  const database = tenantDatabase(tenant);
  await withAdmin(context.config, async (admin) => {
    if (await exists(admin, database)) {
      throw new CommandError(`Database ${database} of tenant "${tenant}" already exists.`);
    }
    await sql`create database ${sql.id(database)}`.execute(admin);
  });
  context.out.line(`Created database ${database} for tenant "${tenant}".`);
}

/** @returns false when `--yes` is missing (nothing was done). */
export async function dbDrop(context: Context, tenant: string, yes: boolean): Promise<boolean> {
  const database = tenantDatabase(tenant);
  if (!yes) {
    context.out.line(
      `This permanently deletes database ${database} of tenant "${tenant}" (its snapshots are kept).\nRun again with --yes to confirm.`,
    );
    return false;
  }
  await withAdmin(context.config, async (admin) => {
    if (!(await exists(admin, database))) {
      throw new CommandError(`Tenant "${tenant}" has no database.`);
    }
    await sql`drop database ${sql.id(database)} with (force)`.execute(admin);
  });
  context.out.line(`Dropped database ${database} of tenant "${tenant}".`);
  return true;
}

export async function dbBackup(context: Context, tenant: string): Promise<void> {
  const ref = await withTenant(context, tenant, (t) => t.snapshots.create('manuel'));
  context.out.line(`Snapshot ${ref.name} of tenant "${tenant}" taken at ${ref.createdAt}.`);
}

/** Without `snapshot`, lists them. @returns false when `--yes` is missing. */
export async function dbRestore(
  context: Context,
  tenant: string,
  snapshot: string | undefined,
  yes: boolean,
): Promise<boolean> {
  const database = tenantDatabase(tenant);
  return withAdmin(context.config, async (admin) => {
    // The tenant database may be gone (dropped): its snapshots can still be restored.
    const snapshots = createTemplateSnapshots(admin, database);
    const refs = await snapshots.list();
    if (snapshot === undefined) {
      if (refs.length === 0) context.out.line(`No snapshot of tenant "${tenant}".`);
      for (const ref of refs) context.out.line(`${ref.name}  ${ref.createdAt}  ${ref.label}`);
      return true;
    }
    const ref = refs.find((r) => r.name === snapshot);
    if (!ref) throw new CommandError(`Tenant "${tenant}" has no snapshot "${snapshot}".`);
    if (!yes) {
      context.out.line(
        `This replaces database ${database} of tenant "${tenant}" with snapshot ${ref.name} (${ref.createdAt}, ${ref.label}).\nRun again with --yes to confirm.`,
      );
      return false;
    }
    await snapshots.restore(ref);
    context.out.line(`Restored tenant "${tenant}" from snapshot ${ref.name}.`);
    return true;
  });
}

// ─── module ──────────────────────────────────────────────────────────────────────────────

function reportData(context: Context, data: Readonly<Record<string, DataLoadResult>>): void {
  for (const [module, counts] of Object.entries(data)) {
    context.out.line(
      `Data of ${module}: ${String(counts.created)} created, ${String(counts.updated)} updated, ${String(counts.kept)} kept.`,
    );
  }
}

export async function moduleList(context: Context, tenant: string): Promise<void> {
  const set = await loadModules(context.config.moduleRoots);
  const installed = await withTenant(context, tenant, (t) => installedModules(t.db));
  for (const name of set.catalog.names()) {
    const available = set.catalog.get(name).version;
    const current = installed.get(name);
    const state =
      current === undefined
        ? 'not installed'
        : current === available
          ? `installed ${current}`
          : `installed ${current}, ${available} available`;
    context.out.line(`${name.padEnd(24)} ${available.padEnd(10)} ${state}`);
  }
  for (const [name, version] of installed) {
    if (!set.catalog.has(name))
      context.out.line(`${name.padEnd(24)} ${'?'.padEnd(10)} installed ${version}, source missing`);
  }
}

export async function moduleInstall(
  context: Context,
  tenant: string,
  requested: readonly string[],
  demo = false,
): Promise<void> {
  const set = await loadModules(context.config.moduleRoots);
  await withTenant(context, tenant, async (t) => {
    const plan = planInstall(set.catalog, requested, await installedModules(t.db));
    if (plan.install.length === 0) {
      context.out.line('Nothing to install: every requested module is already installed.');
      return;
    }
    const { registry, security } = compose(set, plan.modules);
    const result = await upgradeModules({
      db: t.db,
      registry,
      security,
      snapshots: t.snapshots,
      actor: 'cli',
      modules: plan.install.map((name) => ({
        name,
        version: set.get(name).manifest.version,
        data: moduleData(set, registry, name, { demo }),
      })),
    });
    context.out.line(
      `Installed ${result.installed.join(', ')} (snapshot ${result.snapshot.name}).`,
    );
    reportData(context, result.data);
  });
}

export async function moduleUpgrade(
  context: Context,
  tenant: string,
  requested: readonly string[],
): Promise<void> {
  const set = await loadModules(context.config.moduleRoots);
  await withTenant(context, tenant, async (t) => {
    const plan = planUpgrade(set.catalog, requested, await installedModules(t.db));
    if (plan.upgrade.length === 0) {
      context.out.line('Nothing to upgrade: installed modules are up to date.');
      return;
    }
    const { registry, security } = compose(set, plan.modules);
    const result = await upgradeModules({
      db: t.db,
      registry,
      security,
      snapshots: t.snapshots,
      actor: 'cli',
      modules: plan.upgrade.map(({ name, to }) => ({
        name,
        version: to,
        migrations: set.get(name).migrations,
        data: moduleData(set, registry, name),
      })),
    });
    reportData(context, result.data);
    for (const { name, from, to } of result.upgraded) {
      context.out.line(`Upgraded ${name} ${from} → ${to}.`);
    }
    context.out.line(`Snapshot taken before: ${result.snapshot.name}.`);
  });
}

/** @returns false when `--yes` is missing (nothing was done). */
export async function moduleUninstall(
  context: Context,
  tenant: string,
  requested: readonly string[],
  yes: boolean,
  exportDir: string,
): Promise<boolean> {
  const set = await loadModules(context.config.moduleRoots);
  const directory = resolve(context.cwd, exportDir);
  return withTenant(context, tenant, async (t) => {
    const plan = planUninstall(set.catalog, requested, await installedModules(t.db));
    if (!yes) {
      context.out.line(
        `This uninstalls ${plan.remove.join(', ')} from tenant "${tenant}" and deletes their data (exported first to ${directory}).\nRun again with --yes to confirm.`,
      );
      return false;
    }
    const { registry, security } = compose(set, plan.modules);
    const written: string[] = [];
    const snapshot = await uninstallModules({
      db: t.db,
      registry,
      security,
      snapshots: t.snapshots,
      actor: 'cli',
      modules: plan.remove.map((name) => set.get(name).models),
      async exportData(data: ModuleExport) {
        await mkdir(directory, { recursive: true });
        const stamp = data.exportedAt.replace(/\D/g, '').slice(0, 14);
        const file = join(directory, `${t.name}_${data.module}_${stamp}.json`);
        // Business data: readable by the owner only, never overwritten.
        await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        written.push(file);
      },
    });
    context.out.line(`Uninstalled ${plan.remove.join(', ')} (snapshot ${snapshot.name}).`);
    for (const file of written) context.out.line(`Data exported to ${file}`);
    return true;
  });
}

// ─── audit ───────────────────────────────────────────────────────────────────────────────

/** @returns false when the chain is broken. */
export async function auditVerify(context: Context, tenant: string): Promise<boolean> {
  const result = await withTenant(context, tenant, (t) => verifyAudit(t.db));
  if (result.ok) {
    context.out.line(
      `Audit journal of "${tenant}": ${String(result.count)} entries, chain intact.`,
    );
    return true;
  }
  context.out.line(
    `Audit journal of "${tenant}" is BROKEN at entry ${String(result.seq)}: ${result.reason} (${String(result.count)} entries verified before it).`,
  );
  return false;
}
