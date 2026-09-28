// SPDX-License-Identifier: LGPL-3.0-only
export { createCatalog } from './catalog.js';
export type { CatalogOptions, DiscoveredModule, ModuleCatalog } from './catalog.js';
export {
  DependencyCycleError,
  DuplicateModuleError,
  IncompatibleEngineError,
  InvalidManifestError,
  MissingDependencyError,
  ModuleLocationError,
  UnknownModuleError,
} from './errors.js';
export { defineManifest, parseManifest } from './manifest.js';
export type { Capability, ManifestInput, ModuleManifest } from './manifest.js';
export { resolveInstallation, topologicalOrder } from './resolve.js';
