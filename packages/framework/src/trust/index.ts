// SPDX-License-Identifier: LGPL-3.0-only
export {
  IntegrityError,
  InvalidPackageError,
  RevocationRollbackError,
  RevokedModuleError,
  SignatureError,
  UnsignedModuleError,
} from './errors.js';
export { countersignPackage, createPackageIndex, signPackage, verifyPackage } from './package.js';
export type {
  InstallationPolicy,
  ModulePackageIndex,
  PackageSource,
  SignedModulePackage,
  VerifiedModulePackage,
  VerifyPackageOptions,
} from './package.js';
export { isSafeRelativePath } from './paths.js';
export {
  findRevocation,
  modulesToDisable,
  signRevocationList,
  verifyRevocationList,
} from './revocation.js';
export type {
  RevocationEntry,
  RevocationList,
  RevocationSubject,
  SignedRevocationList,
} from './revocation.js';
export { createTrustStore } from './trust-store.js';
export type { TrustStore } from './trust-store.js';
