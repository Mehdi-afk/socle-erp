// SPDX-License-Identifier: LGPL-3.0-only
//
// What a module command will do, computed without touching the database (pure functions).
import {
  buildModelRegistry,
  buildSecurityPolicy,
  buildViewRegistry,
  resolveInstallation,
  SocleError,
  topologicalOrder,
  type ModelRegistry,
  type ModuleCatalog,
  type SecurityPolicy,
} from '@socle/framework';
import semver from 'semver';

import type { ModuleSet } from './loader.js';

export class PlanError extends SocleError {
  constructor(message: string) {
    super('cli.plan', message);
  }
}

export interface InstallPlan {
  /** Every module installed once done, in dependency order. */
  readonly modules: readonly string[];
  /** Modules to install now (requested, their missing dependencies, bridge modules). */
  readonly install: readonly string[];
}

export interface UpgradePlan {
  readonly modules: readonly string[];
  readonly upgrade: readonly {
    readonly name: string;
    readonly from: string;
    readonly to: string;
  }[];
}

export interface UninstallPlan {
  /** Modules to remove, dependents first. */
  readonly remove: readonly string[];
  /** Modules that remain installed, in dependency order. */
  readonly modules: readonly string[];
}

function checkInstalled(installed: ReadonlyMap<string, string>, names: readonly string[]): void {
  for (const name of names) {
    if (!installed.has(name)) throw new PlanError(`Module "${name}" is not installed.`);
  }
}

export function planInstall(
  catalog: ModuleCatalog,
  requested: readonly string[],
  installed: ReadonlyMap<string, string>,
): InstallPlan {
  const modules = resolveInstallation(catalog, requested, installed.keys());
  return { modules, install: modules.filter((name) => !installed.has(name)) };
}

/** Upgrades `requested` (default: every installed module) whose available version is newer. */
export function planUpgrade(
  catalog: ModuleCatalog,
  requested: readonly string[],
  installed: ReadonlyMap<string, string>,
): UpgradePlan {
  checkInstalled(installed, requested);
  const modules = topologicalOrder(catalog, installed.keys());
  const selected = requested.length > 0 ? new Set(requested) : new Set(installed.keys());
  const upgrade = modules.flatMap((name) => {
    const from = installed.get(name) ?? '';
    const to = catalog.get(name).version;
    if (!selected.has(name) || from === to) return [];
    if (semver.valid(from) === null || semver.lt(to, from)) {
      throw new PlanError(`Module "${name}" is installed at ${from}; ${to} would be a downgrade.`);
    }
    return [{ name, from, to }];
  });
  return { modules, upgrade };
}

/** Removes `requested` and every installed module that depends on them, even indirectly. */
export function planUninstall(
  catalog: ModuleCatalog,
  requested: readonly string[],
  installed: ReadonlyMap<string, string>,
): UninstallPlan {
  checkInstalled(installed, requested);
  const order = topologicalOrder(catalog, installed.keys());
  const removed = new Set(requested);
  for (const name of order) {
    if (catalog.get(name).depends.some((dependency) => removed.has(dependency))) removed.add(name);
  }
  return {
    remove: order.filter((name) => removed.has(name)).reverse(),
    modules: order.filter((name) => !removed.has(name)),
  };
}

export interface Composition {
  readonly registry: ModelRegistry;
  readonly security: SecurityPolicy;
}

/**
 * The registry and security policy of `modules` (dependency order). Views are composed too,
 * so that a view extension whose selector finds nothing fails before any database change.
 */
export function compose(set: ModuleSet, modules: readonly string[]): Composition {
  const loaded = modules.map((name) => set.get(name));
  const registry = buildModelRegistry(
    loaded.map((m) => m.models),
    { side: 'server' },
  );
  const security = buildSecurityPolicy(
    loaded.map((m) => m.security),
    (model) => registry.has(model),
  );
  buildViewRegistry(
    loaded.map((m) => m.views),
    registry,
  );
  return { registry, security };
}
