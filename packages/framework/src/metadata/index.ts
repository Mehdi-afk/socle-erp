// SPDX-License-Identifier: LGPL-3.0-only
export { isStoredMetadata } from './types.js';
export type {
  FieldMetadata,
  FieldSnapshot,
  HydratedRegistrySnapshot,
  ModelCatalog,
  ModelMetadata,
  ModelPermissions,
  ModelSnapshot,
  RegistrySnapshot,
  ViewCatalog,
  ViewSnapshot,
} from './types.js';
export { createRegistrySnapshot } from './projection.js';
export { parseRegistrySnapshot, hydrateRegistrySnapshot } from './snapshot.js';
