// SPDX-License-Identifier: LGPL-3.0-only
import type { ModuleManifest } from '../registry/manifest.js';
import { CapabilityDeniedError } from './errors.js';

/**
 * A capability without parameter.
 * @public
 */
export type SimpleCapability = 'sudo' | 'cron' | 'files';

/**
 * Called every time a capability check is denied, for the audit log.
 * @public
 */
export type CapabilityAuditHook = (event: {
  readonly moduleName: string;
  readonly capability: string;
}) => void;

/**
 * The capabilities a module is allowed to use at runtime, derived from its manifest.
 * @public
 */
export interface CapabilityGuard {
  readonly moduleName: string;
  /** Hosts the module may call over HTTPS. */
  readonly networkHosts: readonly string[];
  allows(capability: SimpleCapability): boolean;
  /** @throws {@link CapabilityDeniedError} (and reports it to the audit hook). */
  require(capability: SimpleCapability): void;
  /** @throws {@link CapabilityDeniedError} when `host` is not declared. */
  requireHost(host: string): void;
}

/**
 * Builds the runtime capability guard of a module.
 * @public
 */
export function createCapabilityGuard(
  manifest: ModuleManifest,
  onDenied: CapabilityAuditHook = () => undefined,
): CapabilityGuard {
  const simple = new Set<string>();
  const hosts = new Set<string>();
  for (const capability of manifest.capabilities) {
    if (typeof capability === 'string') simple.add(capability);
    else for (const host of capability.network) hosts.add(host);
  }
  const networkHosts = Object.freeze([...hosts].sort());

  const deny = (capability: string): never => {
    onDenied({ moduleName: manifest.name, capability });
    throw new CapabilityDeniedError(manifest.name, capability);
  };

  return Object.freeze({
    moduleName: manifest.name,
    networkHosts,
    allows: (capability: SimpleCapability) => simple.has(capability),
    require: (capability: SimpleCapability) => {
      if (!simple.has(capability)) deny(capability);
    },
    requireHost: (host: string) => {
      if (!hosts.has(host)) deny(`network:${host}`);
    },
  });
}
