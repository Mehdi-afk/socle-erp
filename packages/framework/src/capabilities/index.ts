// SPDX-License-Identifier: LGPL-3.0-only
export { CapabilityDeniedError, OutboundRequestError } from './errors.js';
export { createCapabilityGuard } from './guard.js';
export type { CapabilityAuditHook, CapabilityGuard, SimpleCapability } from './guard.js';
export { createHttpClient } from './http.js';
export type {
  FetchLike,
  FetchResponseLike,
  HttpClient,
  HttpClientOptions,
  OutboundRequest,
  OutboundResponse,
} from './http.js';
