// SPDX-License-Identifier: LGPL-3.0-only
/** Browser authentication entry point, separate from the DOM-free RPC adapters. */
export { AuthError, createAuthClient, oidcStartPath, parseAuthCallback } from './auth-client.js';
export type {
  AuthAnswer,
  AuthClient,
  AuthClientOptions,
  AuthErrorCode,
  AuthMethod,
  AuthProvider,
  AuthResult,
} from './auth-client.js';
