// SPDX-License-Identifier: LGPL-3.0-only
//
// Tenants (ARCHITECTURE.md §0 D1, §9.3): one database per client, chosen from the subdomain
// of the request (`acme.erp.example.com` → `acme`), with one connection pool per database.
import {
  createAccessControl,
  type AccessControl,
  type ModelRegistry,
  type SecurityPolicy,
} from '@socle/framework';
import { createPgDatabase, type Executor } from '@socle/orm-pg';

const LABEL = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;
/** Subdomains that are never tenants. */
const RESERVED = new Set(['www', 'api', 'admin', 'app', 'mail', 'static', 'status']);

/**
 * The tenant named by the `Host` header, or undefined (unknown shape, other domain, reserved
 * name). Only one label below the base domain is accepted.
 */
export function tenantFromHost(host: string | undefined, baseDomain: string): string | undefined {
  if (host === undefined || host.length > 253) return undefined;
  const name = host.toLowerCase().replace(/:\d{1,5}$/, '');
  const suffix = `.${baseDomain.toLowerCase()}`;
  if (!name.endsWith(suffix)) return undefined;
  const label = name.slice(0, -suffix.length);
  if (!LABEL.test(label) || label.includes('--') || RESERVED.has(label)) return undefined;
  return label;
}

/** What the server needs to serve one tenant. */
export interface TenantRuntime {
  readonly name: string;
  readonly db: Executor;
  readonly registry: ModelRegistry;
  readonly security: SecurityPolicy;
  readonly access: AccessControl;
}

export interface TenantDirectory {
  /** The tenant's runtime, or undefined for an unknown tenant. */
  get(name: string): Promise<TenantRuntime | undefined>;
  close(): Promise<void>;
}

/** How to reach and describe a tenant (its database and installed modules). */
export interface TenantSource {
  resolve(name: string): Promise<
    | {
        readonly connectionString: string;
        readonly registry: ModelRegistry;
        readonly security: SecurityPolicy;
      }
    | undefined
  >;
}

/**
 * Tenants with one pool per database, created on first use and closed when more than
 * `maxPools` tenants are active (least recently used first).
 */
export function createTenantDirectory(
  source: TenantSource,
  maxPools = 50,
  poolSize = 10,
): TenantDirectory {
  const runtimes = new Map<string, Promise<TenantRuntime | undefined>>();

  const evict = async (): Promise<void> => {
    while (runtimes.size > maxPools) {
      const [oldest, runtime] = runtimes.entries().next().value as [
        string,
        Promise<TenantRuntime | undefined>,
      ];
      runtimes.delete(oldest);
      await (await runtime)?.db.destroy();
    }
  };

  return {
    async get(name) {
      let runtime = runtimes.get(name);
      if (runtime) {
        runtimes.delete(name);
        runtimes.set(name, runtime);
        return runtime;
      }
      runtime = source.resolve(name).then((found) =>
        found
          ? {
              name,
              db: createPgDatabase({
                connectionString: found.connectionString,
                max: poolSize,
                applicationName: `socle:${name}`,
              }),
              registry: found.registry,
              security: found.security,
              access: createAccessControl(found.security, found.registry),
            }
          : undefined,
      );
      runtimes.set(name, runtime);
      const result = await runtime;
      // An unknown tenant is not cached: it may be created later.
      if (!result) runtimes.delete(name);
      else await evict();
      return result;
    },
    async close() {
      const all = [...runtimes.values()];
      runtimes.clear();
      for (const runtime of all) await (await runtime)?.db.destroy();
    },
  };
}
