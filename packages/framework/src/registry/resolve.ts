// SPDX-License-Identifier: LGPL-3.0-only
import type { ModuleCatalog } from './catalog.js';
import { MissingDependencyError, UnknownModuleError } from './errors.js';

/**
 * Orders modules so that every module comes after all its dependencies (Kahn's algorithm).
 * Ties are broken alphabetically, so the order is deterministic across machines.
 * Only the given modules are ordered; their dependencies must be part of `names`.
 * @public
 */
export function topologicalOrder(catalog: ModuleCatalog, names: Iterable<string>): string[] {
  const selected = new Set(names);
  const remaining = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const name of selected) {
    const manifest = catalog.get(name);
    let count = 0;
    for (const dependency of manifest.depends) {
      if (!selected.has(dependency)) {
        throw new MissingDependencyError(name, dependency);
      }
      count += 1;
      const list = dependents.get(dependency) ?? [];
      list.push(name);
      dependents.set(dependency, list);
    }
    remaining.set(name, count);
  }

  const ready = [...remaining].filter(([, count]) => count === 0).map(([name]) => name);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort();
    const name = ready.shift() as string;
    order.push(name);
    for (const dependent of dependents.get(name) ?? []) {
      const count = (remaining.get(dependent) ?? 0) - 1;
      remaining.set(dependent, count);
      if (count === 0) ready.push(dependent);
    }
  }
  // The catalog rejects cycles, so every module is always ordered.
  return order;
}

/**
 * Computes the full, ordered set of modules to have installed after installing `requested`
 * on a database where `installed` modules already are:
 * 1. the transitive dependencies of the requested modules are added;
 * 2. every `autoInstall` module whose dependencies are all present is added, until stable
 *    ("bridge" modules such as `sale_stock`).
 * @throws {@link UnknownModuleError} when a requested or installed module is not in the catalog.
 * @public
 */
export function resolveInstallation(
  catalog: ModuleCatalog,
  requested: Iterable<string>,
  installed: Iterable<string> = [],
): string[] {
  const result = new Set<string>();

  const addWithDependencies = (name: string): void => {
    if (result.has(name)) return;
    if (!catalog.has(name)) throw new UnknownModuleError(name);
    for (const dependency of catalog.get(name).depends) addWithDependencies(dependency);
    result.add(name);
  };

  for (const name of installed) addWithDependencies(name);
  for (const name of requested) addWithDependencies(name);

  let changed = true;
  while (changed) {
    changed = false;
    for (const name of catalog.names()) {
      const manifest = catalog.get(name);
      if (
        !result.has(name) &&
        manifest.autoInstall &&
        manifest.depends.length > 0 &&
        manifest.depends.every((dependency) => result.has(dependency))
      ) {
        result.add(name);
        changed = true;
      }
    }
  }

  return topologicalOrder(catalog, result);
}
