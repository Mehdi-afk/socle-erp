// SPDX-License-Identifier: LGPL-3.0-only
//
// Loads source modules from disk (ARCHITECTURE.md §3.3). The framework stays isomorphic and
// never reads the disk: this is the Node side of discovery. Each file of a known place
// default-exports what that place holds:
//
//   manifest.ts                      defineManifest({...})
//   models/*.ts                      a model definition or extension, or an array of them
//   views/*.ts                       a view definition or extension, or an array of them
//   security/groups.ts|access.ts|rules.ts   an array of groups, access rights or record rules
//   migrations/<version>/pre.ts|post.ts     an async function (context) => void
//   data/*.ts                        defineData(model, records), or an array of them (in file order)
//   demo/*.ts                        same, loaded only when demo data is asked for explicitly
//
// Only local, trusted source modules are loaded here (their code runs in this process);
// signed third-party packages go through framework/trust (marketplace, later phase).
import { existsSync } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createCatalog,
  SocleError,
  type AccessDefinition,
  type DiscoveredModule,
  type GroupDefinition,
  type ModelDefinition,
  type ModelExtension,
  type ModuleCatalog,
  type ModuleData,
  type ModuleManifest,
  type ModuleModels,
  type ModuleSecurity,
  type ModuleViews,
  type RuleDefinition,
  type ViewDefinition,
  type ViewExtension,
} from '@socle/framework';
import type { MigrationContext, ModuleMigration } from '@socle/orm-pg';
import semver from 'semver';

export class ModuleLoadError extends SocleError {
  constructor(message: string, options?: ErrorOptions) {
    super('cli.module_load', message, options);
  }
}

export interface LoadedModule {
  readonly manifest: ModuleManifest;
  /** Absolute, real path of the module directory. */
  readonly path: string;
  readonly models: ModuleModels;
  readonly views: ModuleViews;
  readonly security: ModuleSecurity;
  /** Hand-written migrations, by version. */
  readonly migrations: readonly ModuleMigration[];
  /** Records loaded at installation and kept up to date (`data/`, in file order). */
  readonly data: readonly ModuleData[];
  /** Demonstration records (`demo/`), never loaded unless asked for. */
  readonly demo: readonly ModuleData[];
}

export interface ModuleSet {
  readonly catalog: ModuleCatalog;
  /** @throws {@link ModuleLoadError} for a module that is not available. */
  get(name: string): LoadedModule;
}

const SOURCE = /^[a-z0-9][a-z0-9._-]*\.ts$/;
const NOT_SOURCE = /\.(test|spec|d)\.ts$/;

/** The real path of `path`, refused when it leaves `root` (e.g. through a symbolic link). */
async function confined(root: string, path: string): Promise<string> {
  const real = await realpath(path);
  const rel = relative(root, real);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new ModuleLoadError(`${path} resolves outside of the module directory ${root}.`);
  }
  return real;
}

async function defaultExport(root: string, path: string): Promise<unknown> {
  const real = await confined(root, path);
  let loaded: { default?: unknown };
  try {
    loaded = (await import(pathToFileURL(real).href)) as { default?: unknown };
  } catch (error) {
    throw new ModuleLoadError(`Cannot load ${real}.`, { cause: error });
  }
  if (loaded.default === undefined) throw new ModuleLoadError(`${real} has no default export.`);
  return loaded.default;
}

/** The TypeScript sources directly in `dir` (not recursive), sorted; none if it does not exist. */
async function sources(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  // Links are listed too: loading them checks that they stay inside the root (never skipped).
  return entries
    .filter(
      (e) => (e.isFile() || e.isSymbolicLink()) && SOURCE.test(e.name) && !NOT_SOURCE.test(e.name),
    )
    .map((e) => join(dir, e.name))
    .sort();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function items(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [value];
}

/** Checks the shape shared by definitions and extensions; the framework validates the rest. */
function checkKind(file: string, what: string, value: unknown, key: string): void {
  if (!isRecord(value) || (value.kind !== 'define' && value.kind !== 'extend')) {
    throw new ModuleLoadError(`${file}: every default export entry must be a ${what}.`);
  }
  if (typeof value[key] !== 'string') {
    throw new ModuleLoadError(`${file}: a ${what} without "${key}".`);
  }
}

function checkArray(file: string, what: string, value: unknown): readonly object[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new ModuleLoadError(`${file}: the default export must be an array of ${what}.`);
  }
  return value;
}

async function loadData(root: string, dir: string): Promise<ModuleData[]> {
  const sets: ModuleData[] = [];
  for (const file of await sources(dir)) {
    for (const item of items(await defaultExport(root, file))) {
      if (!isRecord(item) || item.kind !== 'data' || typeof item.model !== 'string') {
        throw new ModuleLoadError(
          `${file}: every default export entry must come from defineData().`,
        );
      }
      sets.push(item as unknown as ModuleData);
    }
  }
  return sets;
}

type Step = (context: MigrationContext) => Promise<void>;

async function loadMigrations(root: string, dir: string): Promise<ModuleMigration[]> {
  if (!existsSync(dir)) return [];
  const migrations: ModuleMigration[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (semver.valid(entry.name) !== entry.name) {
      throw new ModuleLoadError(`${join(dir, entry.name)}: not a SemVer version directory.`);
    }
    const steps: { pre?: Step; post?: Step } = {};
    for (const step of ['pre', 'post'] as const) {
      const file = join(dir, entry.name, `${step}.ts`);
      if (!existsSync(file)) continue;
      const value = await defaultExport(root, file);
      if (typeof value !== 'function') {
        throw new ModuleLoadError(`${file}: the default export must be an async function.`);
      }
      steps[step] = value as Step;
    }
    migrations.push({ version: entry.name, ...steps });
  }
  return migrations.sort((a, b) => semver.compare(a.version, b.version));
}

async function loadModule(root: string, path: string, manifest: ModuleManifest) {
  const name = manifest.name;
  const models: (ModelDefinition | ModelExtension)[] = [];
  for (const file of await sources(join(path, 'models'))) {
    for (const item of items(await defaultExport(root, file))) {
      checkKind(file, 'model definition or extension', item, 'name');
      models.push(item as ModelDefinition | ModelExtension);
    }
  }
  const views: (ViewDefinition | ViewExtension)[] = [];
  for (const file of await sources(join(path, 'views'))) {
    for (const item of items(await defaultExport(root, file))) {
      const key = isRecord(item) && item.kind === 'extend' ? 'view' : 'id';
      checkKind(file, 'view definition or extension', item, key);
      views.push(item as ViewDefinition | ViewExtension);
    }
  }
  const part = async (file: string, what: string): Promise<readonly object[] | undefined> =>
    existsSync(file) ? checkArray(file, what, await defaultExport(root, file)) : undefined;
  const security: ModuleSecurity = {
    module: name,
    groups: (await part(join(path, 'security', 'groups.ts'), 'groups')) as
      readonly GroupDefinition[] | undefined,
    access: (await part(join(path, 'security', 'access.ts'), 'access rights')) as
      readonly AccessDefinition[] | undefined,
    rules: (await part(join(path, 'security', 'rules.ts'), 'record rules')) as
      readonly RuleDefinition[] | undefined,
  };
  return {
    manifest,
    path,
    models: { module: name, models },
    views: { module: name, views },
    security,
    migrations: await loadMigrations(root, join(path, 'migrations')),
    data: await loadData(root, join(path, 'data')),
    demo: await loadData(root, join(path, 'demo')),
  };
}

/**
 * Loads every module found in `roots` (one module per sub-directory holding a `manifest.ts`)
 * and checks them together (catalog: names, dependencies, cycles, core version).
 */
export async function loadModules(roots: readonly string[]): Promise<ModuleSet> {
  const found: { root: string; path: string; discovered: DiscoveredModule }[] = [];
  for (const configured of roots) {
    if (!existsSync(configured)) {
      throw new ModuleLoadError(`Module directory ${configured} does not exist.`);
    }
    const root = await realpath(configured);
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      // A linked module directory is followed, then refused if it leaves the root.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const manifest = join(root, entry.name, 'manifest.ts');
      if (!existsSync(manifest)) continue;
      const path = await confined(root, join(root, entry.name));
      await confined(root, manifest);
      found.push({
        root,
        path,
        discovered: { directory: entry.name, manifest: await defaultExport(root, manifest) },
      });
    }
  }
  const catalog = createCatalog(found.map((f) => f.discovered));
  const modules = new Map<string, LoadedModule>();
  for (const { root, path, discovered } of found) {
    const manifest = catalog.get(discovered.directory);
    modules.set(manifest.name, await loadModule(root, path, manifest));
  }
  return {
    catalog,
    get(name) {
      const module = modules.get(name);
      if (!module) throw new ModuleLoadError(`Module "${name}" is not available.`);
      return module;
    },
  };
}
