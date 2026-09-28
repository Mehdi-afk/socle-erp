// SPDX-License-Identifier: LGPL-3.0-only
import { OutboundRequestError } from './errors.js';
import type { CapabilityGuard } from './guard.js';

/**
 * The subset of `fetch` the client relies on; injected so that the core stays isomorphic
 * (server adapters add DNS checks against private addresses, see ARCHITECTURE.md §9.2).
 * @public
 */
export type FetchLike = (
  url: string,
  init: {
    readonly method: string;
    readonly headers?: Readonly<Record<string, string>> | undefined;
    readonly body?: string | Uint8Array | undefined;
    readonly redirect: 'manual';
    readonly signal?: unknown;
  },
) => Promise<FetchResponseLike>;

/** @public */
export interface FetchResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** @public */
export interface OutboundRequest {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | Uint8Array | undefined;
}

/** @public */
export interface OutboundResponse {
  readonly status: number;
  readonly url: string;
  readonly headers: { get(name: string): string | null };
  readonly body: Uint8Array;
}

/**
 * The single outgoing HTTP client (anti-SSRF).
 * @public
 */
export interface HttpClient {
  request(url: string, request?: OutboundRequest): Promise<OutboundResponse>;
}

/** @public */
export interface HttpClientOptions {
  /** Performs the actual request. */
  readonly fetch: FetchLike;
  /** Exact hostnames allowed, or a capability guard (hosts declared by a module). */
  readonly allow: readonly string[] | CapabilityGuard;
  readonly maxRedirects?: number | undefined;
  readonly maxResponseBytes?: number | undefined;
}

interface UrlLike {
  readonly protocol: string;
  readonly hostname: string;
  readonly port: string;
  readonly username: string;
  readonly password: string;
  readonly href: string;
}

type UrlConstructor = new (input: string, base?: string) => UrlLike;

function parseUrl(input: string, base?: string): UrlLike {
  const Url = (globalThis as { URL?: UrlConstructor }).URL;
  if (!Url) throw new Error('The runtime must provide the WHATWG URL API.');
  try {
    return new Url(input, base);
  } catch {
    throw new OutboundRequestError('Invalid URL.');
  }
}

/**
 * Creates the allow-list HTTP client. Every request, and every redirect hop, must be HTTPS on
 * port 443 to an exact allowed hostname, without credentials in the URL. Redirects are
 * followed manually so that each target is checked; response size is bounded.
 * @public
 */
export function createHttpClient(options: HttpClientOptions): HttpClient {
  const maxRedirects = options.maxRedirects ?? 3;
  const maxResponseBytes = options.maxResponseBytes ?? 10 * 1024 * 1024;
  const guard = Array.isArray(options.allow) ? undefined : (options.allow as CapabilityGuard);
  const allowed = new Set<string>(
    guard ? guard.networkHosts : (options.allow as readonly string[]),
  );

  const check = (url: UrlLike): void => {
    if (url.protocol !== 'https:') throw new OutboundRequestError('Only HTTPS is allowed.');
    if (url.username !== '' || url.password !== '') {
      throw new OutboundRequestError('Credentials in the URL are not allowed.');
    }
    if (url.port !== '' && url.port !== '443') {
      throw new OutboundRequestError('Only the default HTTPS port is allowed.');
    }
    if (guard) guard.requireHost(url.hostname);
    else if (!allowed.has(url.hostname)) {
      throw new OutboundRequestError(`Host "${url.hostname}" is not in the allow-list.`);
    }
  };

  return Object.freeze({
    async request(input: string, request: OutboundRequest = {}): Promise<OutboundResponse> {
      let url = parseUrl(input);
      let method = request.method ?? 'GET';
      let body = request.body;
      for (let hop = 0; ; hop++) {
        check(url);
        const response = await options.fetch(url.href, {
          method,
          headers: request.headers,
          body,
          redirect: 'manual',
        });
        const location = response.headers.get('location');
        if (response.status >= 300 && response.status < 400 && location !== null) {
          if (hop >= maxRedirects) throw new OutboundRequestError('Too many redirects.');
          url = parseUrl(location, url.href);
          if (
            response.status === 303 ||
            ((response.status === 301 || response.status === 302) && method === 'POST')
          ) {
            method = 'GET';
            body = undefined;
          }
          continue;
        }
        const declared = Number(response.headers.get('content-length') ?? '0');
        if (declared > maxResponseBytes) throw new OutboundRequestError('Response too large.');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > maxResponseBytes) throw new OutboundRequestError('Response too large.');
        return { status: response.status, url: url.href, headers: response.headers, body: bytes };
      }
    },
  });
}
