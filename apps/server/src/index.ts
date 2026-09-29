// SPDX-License-Identifier: LGPL-3.0-only
export { buildServer } from './app.js';
export type { AttachmentOptions } from './attachments.js';
export type { ServerOptions } from './app.js';
export {
  authenticate,
  changePassword,
  checkCredentials,
  CLEAR_SESSION_COOKIE,
  createUser,
  csrfMatches,
  csrfToken,
  DEFAULT_COST,
  DEFAULT_SESSION_POLICY,
  hashPassword,
  listSessions,
  login,
  LoginError,
  logout,
  needsRehash,
  openSession,
  readSessionCookie,
  requestPasswordReset,
  resetPassword,
  revokeSession,
  rotateSession,
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
export type { PasswordCost, SessionInfo, SessionPolicy } from './auth.js';
export { DEFAULT_MFA_GROUPS } from './mfa.js';
export type { MfaOptions, MfaState } from './mfa.js';
export { corsHeaders, SECURITY_HEADERS } from './headers.js';
export { createRateLimiter, takeToken } from './rate-limit.js';
export type { Bucket, BucketPolicy } from './rate-limit.js';
export { createTenantDirectory, tenantFromHost } from './tenants.js';
export type { TenantDirectory, TenantRuntime, TenantSource } from './tenants.js';
