// SPDX-License-Identifier: LGPL-3.0-only
//
// Response headers of the API (ARCHITECTURE.md §9.3) and CORS with an allow-list of origins.
// The API only returns JSON: nothing may be framed, sniffed, cached or embedded elsewhere.

export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-security-policy':
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cache-control': 'no-store',
});

/**
 * CORS decision for a request: no `Origin` (same origin, tools) passes; an origin in the
 * allow-list gets the matching headers; any other origin is refused.
 */
export function corsHeaders(
  origin: string | undefined,
  allowed: readonly string[],
): { readonly allowed: boolean; readonly headers: Readonly<Record<string, string>> } {
  if (origin === undefined) return { allowed: true, headers: {} };
  if (!allowed.includes(origin)) return { allowed: false, headers: {} };
  return {
    allowed: true,
    headers: {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET, POST',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
      vary: 'Origin',
    },
  };
}
