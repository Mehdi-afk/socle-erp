// SPDX-License-Identifier: LGPL-3.0-only
export { buildServer } from './app.js';
export type { AttachmentOptions } from './attachments.js';
export type { ServerOptions } from './app.js';
export {
  authenticate,
  changePassword,
  CLEAR_SESSION_COOKIE,
  createUser,
  DEFAULT_COST,
  DEFAULT_SESSION_POLICY,
  hashPassword,
  login,
  LoginError,
  logout,
  needsRehash,
  readSessionCookie,
  requestPasswordReset,
  resetPassword,
  SESSION_COOKIE,
  sessionCookie,
  verifyPassword,
} from './auth.js';
export {
  DEFAULT_PASSWORD_POLICY,
  MIN_PASSWORD_LENGTH,
  passwordProblem,
  pwnedPasswords,
} from './password-policy.js';
export type { BreachCheck, PasswordPolicy } from './password-policy.js';
export type { PasswordCost, SessionPolicy } from './auth.js';
export { corsHeaders, SECURITY_HEADERS } from './headers.js';
export { createRateLimiter, takeToken } from './rate-limit.js';
export type { Bucket, BucketPolicy } from './rate-limit.js';
export { createTenantDirectory, tenantFromHost } from './tenants.js';
export type { TenantDirectory, TenantRuntime, TenantSource } from './tenants.js';
