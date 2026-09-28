// SPDX-License-Identifier: LGPL-3.0-only
import semver from 'semver';

import { SOCLE_VERSION } from '../version.js';
import {
  DependencyCycleError,
  DuplicateModuleError,
  IncompatibleEngineError,
  MissingDependencyError,
  ModuleLocationError,
  UnknownModuleError,
} from './errors.js';
import { parseManifest, type ModuleManifest } from './manifest.js';

/**
 * A module found by a discovery source (file system on the server, bundle on the client…).
 * The framework stays isomorphic: it never reads the disk itself.
 * @public
 */
export interface DiscoveredModule {
  /** Name of the directory the module lives in; must equal the manifest name. */
  readonly directory: string;
  /** The raw manifest, validated by {@link createCatalog}. */
  readonly manifest: unknown;
}

/**
 * The set of modules available to a database, indexed by name.
 * @public
 */
export interface ModuleCatalog {
  readonly coreVersion: string;
  has(name: string): boolean;
  /** @throws {@link UnknownModuleError} */
  get(name: string): ModuleManifest;
  names(): readonly string[];
}

/** @public */
export interface CatalogOptions {
  /** Core version to check `engines.socle` against. Defaults to {@link SOCLE_VERSION}. */
  readonly coreVersion?: string;
}

/**
 * Builds the catalog of available modules: validates every manifest, rejects duplicates,
 * misplaced modules, missing dependencies, dependency cycles and incompatible engines.
 * All checks happen here, so that a catalog is always consistent.
 * @public
 */
export function createCatalog(
  modules: Iterable<DiscoveredModule>,
  options: CatalogOptions = {},
): ModuleCatalog {
  const coreVersion = options.coreVersion ?? SOCLE_VERSION;
  const byName = new Map<string, ModuleManifest>();

  for (const discovered of modules) {
    const manifest = parseManifest(discovered.manifest);
    if (discovered.directory !== manifest.name) {
      throw new ModuleLocationError(manifest.name, discovered.directory);
    }
    if (byName.has(manifest.name)) throw new DuplicateModuleError(manifest.name);
    if (!semver.satisfies(coreVersion, manifest.engines.socle)) {
      throw new IncompatibleEngineError(manifest.name, manifest.engines.socle, coreVersion);
    }
    byName.set(manifest.name, manifest);
  }

  for (const manifest of byName.values()) {
    for (const dependency of manifest.depends) {
      if (!byName.has(dependency)) throw new MissingDependencyError(manifest.name, dependency);
    }
  }
  const cycle = findCycle(byName);
  if (cycle) throw new DependencyCycleError(cycle);

  const names = Object.freeze([...byName.keys()].sort());
  return Object.freeze({
    coreVersion,
    has: (name: string) => byName.has(name),
    get: (name: string) => {
      const manifest = byName.get(name);
      if (!manifest) throw new UnknownModuleError(name);
      return manifest;
    },
    names: () => names,
  });
}

/** Depth-first search; returns the first cycle found (deterministic: sorted traversal). */
function findCycle(byName: ReadonlyMap<string, ModuleManifest>): string[] | undefined {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (name: string): string[] | undefined => {
    const current = state.get(name);
    if (current === 'done') return undefined;
    if (current === 'visiting') return [...stack.slice(stack.indexOf(name)), name];
    state.set(name, 'visiting');
    stack.push(name);
    for (const dependency of [...(byName.get(name)?.depends ?? [])].sort()) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(name, 'done');
    return undefined;
  };

  for (const name of [...byName.keys()].sort()) {
    const cycle = visit(name);
    if (cycle) return cycle;
  }
  return undefined;
}
