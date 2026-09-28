// SPDX-License-Identifier: LGPL-3.0-only
import { SocleError } from '../errors.js';

/** @public */
export class InvalidManifestError extends SocleError {
  readonly issues: readonly string[];

  constructor(moduleHint: string, issues: readonly string[]) {
    super(
      'registry.invalid_manifest',
      `Invalid manifest for "${moduleHint}": ${issues.join('; ')}`,
    );
    this.issues = issues;
  }
}

/** @public */
export class DuplicateModuleError extends SocleError {
  readonly moduleName: string;

  constructor(moduleName: string) {
    super('registry.duplicate_module', `Module "${moduleName}" is defined more than once.`);
    this.moduleName = moduleName;
  }
}

/** @public */
export class ModuleLocationError extends SocleError {
  readonly moduleName: string;
  readonly directory: string;

  constructor(moduleName: string, directory: string) {
    super(
      'registry.module_location',
      `Module "${moduleName}" must live in a directory named "${moduleName}", found "${directory}".`,
    );
    this.moduleName = moduleName;
    this.directory = directory;
  }
}

/** @public */
export class UnknownModuleError extends SocleError {
  readonly moduleName: string;

  constructor(moduleName: string) {
    super('registry.unknown_module', `Module "${moduleName}" is not available.`);
    this.moduleName = moduleName;
  }
}

/** @public */
export class MissingDependencyError extends SocleError {
  readonly moduleName: string;
  readonly dependency: string;

  constructor(moduleName: string, dependency: string) {
    super(
      'registry.missing_dependency',
      `Module "${moduleName}" depends on "${dependency}", which is not available.`,
    );
    this.moduleName = moduleName;
    this.dependency = dependency;
  }
}

/** @public */
export class DependencyCycleError extends SocleError {
  /** The modules forming the cycle, the first one repeated at the end (e.g. a → b → a). */
  readonly cycle: readonly string[];

  constructor(cycle: readonly string[]) {
    super('registry.dependency_cycle', `Dependency cycle detected: ${cycle.join(' → ')}.`);
    this.cycle = cycle;
  }
}

/** @public */
export class IncompatibleEngineError extends SocleError {
  readonly moduleName: string;
  readonly range: string;
  readonly coreVersion: string;

  constructor(moduleName: string, range: string, coreVersion: string) {
    super(
      'registry.incompatible_engine',
      `Module "${moduleName}" requires Socle ${range}, but the core is ${coreVersion}.`,
    );
    this.moduleName = moduleName;
    this.range = range;
    this.coreVersion = coreVersion;
  }
}
