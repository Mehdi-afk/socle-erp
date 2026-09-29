// SPDX-License-Identifier: LGPL-3.0-only
//
// What a set of installed modules becomes at run time: the model registry, the security policy
// (views composed too, to fail early), and the data each module loads.
import {
  buildModelRegistry,
  buildSecurityPolicy,
  buildViewRegistry,
  securityRecords,
  type ModelRegistry,
  type ModuleData,
  type ModuleManifest,
  type SecurityPolicy,
} from '@socle/framework';

import type { ModuleSet } from './loader.js';

export interface Composition {
  readonly registry: ModelRegistry;
  readonly security: SecurityPolicy;
  /** Manifests of the installed modules (their runtime capabilities). */
  readonly manifests: ReadonlyMap<string, ModuleManifest>;
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
  return {
    registry,
    security,
    manifests: new Map(loaded.map((m) => [m.manifest.name, m.manifest])),
  };
}

/**
 * The data a module loads at installation or upgrade: its security declarations mirrored as
 * records (when `base` is installed), its `data/` and, on request, its `demo/`.
 */
export function moduleData(
  set: ModuleSet,
  registry: ModelRegistry,
  name: string,
  options: { readonly demo?: boolean } = {},
): ModuleData[] {
  const module = set.get(name);
  return [
    ...securityRecords(module.security, (model) => registry.has(model)),
    ...module.data,
    ...(options.demo === true ? module.demo : []),
  ];
}
