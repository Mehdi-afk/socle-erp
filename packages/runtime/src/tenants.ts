// SPDX-License-Identifier: LGPL-3.0-only
//
// Tenants at run time (ARCHITECTURE.md §0 D1): one database per client on a PostgreSQL server,
// named from the client's subdomain. The server and the worker find a tenant's database and
// its installed modules here; the CLI creates and drops them.
import { SocleError, topologicalOrder } from '@socle/framework';
import { createPgDatabase, identifier, installedModules, type Executor } from '@socle/orm-pg';
import { sql } from 'kysely';

import { compose, type Composition } from './compose.js';
import { loadModules, type ModuleSet } from './loader.js';

export class TenantNameError extends SocleError {
  constructor(message: string) {
    super('runtime.tenant', message);
  }
}

const TENANT = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;
const PREFIX = 'socle_';

/** True for a valid tenant name: a subdomain label of 2 to 32 characters. */
export function isTenantName(tenant: string): boolean {
  return TENANT.test(tenant) && !tenant.includes('--');
}

/**
 * Database of a tenant: `acme-sarl` → `socle_acme_sarl`. Tenant names are subdomain labels
 * (lowercase letters, digits, single hyphens), so the mapping is injective.
 * @throws {@link TenantNameError}
 */
export function tenantDatabase(tenant: string): string {
  if (!isTenantName(tenant)) {
    throw new TenantNameError(
      `Invalid tenant "${tenant}" (2-32 lowercase letters, digits or single hyphens, starting with a letter).`,
    );
  }
  return identifier(`${PREFIX}${tenant.replaceAll('-', '_')}`);
}

/** The tenant of a database name, or undefined for any other database. */
export function tenantOfDatabase(database: string): string | undefined {
  if (!database.startsWith(PREFIX)) return undefined;
  const tenant = database.slice(PREFIX.length).replaceAll('_', '-');
  return isTenantName(tenant) ? tenant : undefined;
}

/** The admin URL pointed at another database of the same server. */
export function databaseUrl(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${identifier(database)}`;
  return url.toString();
}

/** Every tenant of the PostgreSQL server `admin` is connected to, sorted. */
export async function listTenants(admin: Executor): Promise<string[]> {
  const result = await sql<{
    name: string;
  }>`select datname as name from pg_database where not datistemplate and starts_with(datname, ${PREFIX}) order by datname`.execute(
    admin,
  );
  return result.rows.flatMap((row) => {
    const tenant = tenantOfDatabase(row.name);
    return tenant === undefined ? [] : [tenant];
  });
}

/** What the server and the worker need to serve a tenant. */
export interface ResolvedTenant extends Composition {
  readonly connectionString: string;
  /** Installed modules, in dependency order. */
  readonly modules: readonly string[];
}

export interface TenantSource {
  /** The tenant's database and composed modules; undefined for an unknown tenant. */
  resolve(tenant: string): Promise<ResolvedTenant | undefined>;
  close(): Promise<void>;
}

/**
 * Tenants of a PostgreSQL server whose modules are found in `moduleRoots`. Modules are loaded
 * once; the composition of each distinct set of installed modules is computed once.
 */
export function createTenantSource(options: {
  readonly adminUrl: string;
  readonly moduleRoots: readonly string[];
}): TenantSource {
  const admin = createPgDatabase({
    connectionString: options.adminUrl,
    max: 2,
    applicationName: 'socle:tenants',
  });
  let modules: Promise<ModuleSet> | undefined;
  const compositions = new Map<string, Composition>();

  return {
    async resolve(tenant) {
      if (!isTenantName(tenant)) return undefined;
      const database = tenantDatabase(tenant);
      const found = await sql`select 1 from pg_database where datname = ${database}`.execute(admin);
      if (found.rows.length === 0) return undefined;
      const connectionString = databaseUrl(options.adminUrl, database);
      const db = createPgDatabase({ connectionString, max: 1, applicationName: 'socle:tenants' });
      let installed: ReadonlyMap<string, string>;
      try {
        installed = await installedModules(db);
      } finally {
        await db.destroy();
      }
      modules ??= loadModules(options.moduleRoots);
      const set = await modules;
      const order = topologicalOrder(set.catalog, installed.keys());
      const key = order.join(',');
      let composition = compositions.get(key);
      if (!composition) {
        composition = compose(set, order);
        compositions.set(key, composition);
      }
      return { connectionString, modules: order, ...composition };
    },
    close: () => admin.destroy(),
  };
}
