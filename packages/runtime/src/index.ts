// SPDX-License-Identifier: LGPL-3.0-only
export { compose, moduleData } from './compose.js';
export type { Composition } from './compose.js';
export { loadModules, ModuleLoadError } from './loader.js';
export { amzDate, createS3Client, S3Error, signV4 } from './s3.js';
export type { S3Client, S3Config, SigningInput } from './s3.js';
export type { LoadedModule, ModuleSet } from './loader.js';
export {
  createTenantSource,
  databaseUrl,
  isTenantName,
  listTenants,
  tenantDatabase,
  TenantNameError,
  tenantOfDatabase,
} from './tenants.js';
export type { ResolvedTenant, TenantSource } from './tenants.js';
