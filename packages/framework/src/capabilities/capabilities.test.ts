// SPDX-License-Identifier: LGPL-3.0-only
import { utf8 } from '@socle/crypto';
import { describe, expect, it, vi } from 'vitest';

import { defineManifest } from '../registry/manifest.js';
import { CapabilityDeniedError, OutboundRequestError } from './errors.js';
import { createCapabilityGuard } from './guard.js';
import { createHttpClient, type FetchLike, type FetchResponseLike } from './http.js';

const manifest = defineManifest({
  name: 'acme_crm',
  version: '1.0.0',
  label: { fr: 'CRM' },
  license: 'LicenseRef-Acme',
  edition: 'pro',
  engines: { socle: '^0.1' },
  capabilities: ['cron', { network: ['api.acme.fr'] }],
});

function response(
  status: number,
  headers: Record<string, string> = {},
  body = 'ok',
): FetchResponseLike {
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    arrayBuffer: () => Promise.resolve(utf8(body).slice().buffer),
  };
}

describe('createCapabilityGuard', () => {
  it('allows declared capabilities and denies the others, with an audit event', () => {
    const onDenied = vi.fn();
    const guard = createCapabilityGuard(manifest, onDenied);
    expect(guard.allows('cron')).toBe(true);
    expect(() => {
      guard.require('cron');
    }).not.toThrow();
    expect(() => {
      guard.require('sudo');
    }).toThrow(CapabilityDeniedError);
    expect(onDenied).toHaveBeenCalledWith({ moduleName: 'acme_crm', capability: 'sudo' });
    expect(guard.networkHosts).toEqual(['api.acme.fr']);
  });
});

describe('createHttpClient', () => {
  it('lets a module call a declared host', async () => {
    const fetch = vi.fn<FetchLike>(() => Promise.resolve(response(200)));
    const http = createHttpClient({ fetch, allow: createCapabilityGuard(manifest) });
    const result = await http.request('https://api.acme.fr/v1/leads');
    expect(result.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('blocks a module calling an undeclared host, before any network access', async () => {
    const fetch = vi.fn<FetchLike>(() => Promise.resolve(response(200)));
    const http = createHttpClient({ fetch, allow: createCapabilityGuard(manifest) });
    await expect(http.request('https://exfil.example.com/')).rejects.toThrow(CapabilityDeniedError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['plain HTTP', 'http://api.acme.fr/'],
    ['another port', 'https://api.acme.fr:8443/'],
    ['credentials in the URL', 'https://user:pass@api.acme.fr/'],
    ['an IP address', 'https://169.254.169.254/latest/meta-data'],
    ['a look-alike host', 'https://api.acme.fr.evil.com/'],
    ['an invalid URL', 'not a url'],
  ])('refuses %s', async (_case, url) => {
    const fetch = vi.fn<FetchLike>(() => Promise.resolve(response(200)));
    const http = createHttpClient({ fetch, allow: ['api.acme.fr'] });
    await expect(http.request(url)).rejects.toThrow(OutboundRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('checks every redirect target', async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(response(302, { location: 'https://169.254.169.254/' }));
    const http = createHttpClient({ fetch, allow: ['api.acme.fr'] });
    await expect(http.request('https://api.acme.fr/')).rejects.toThrow(OutboundRequestError);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('follows an allowed redirect and bounds the number of hops', async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(response(301, { location: '/v2' }))
      .mockResolvedValueOnce(response(200));
    const http = createHttpClient({ fetch, allow: ['api.acme.fr'] });
    expect((await http.request('https://api.acme.fr/v1')).url).toBe('https://api.acme.fr/v2');

    const loop = vi.fn<FetchLike>(() => Promise.resolve(response(302, { location: '/again' })));
    const looping = createHttpClient({ fetch: loop, allow: ['api.acme.fr'], maxRedirects: 2 });
    await expect(looping.request('https://api.acme.fr/')).rejects.toThrow(/Too many redirects/);
  });

  it('refuses oversized responses', async () => {
    const fetch = vi.fn<FetchLike>(() => Promise.resolve(response(200, {}, 'x'.repeat(100))));
    const http = createHttpClient({ fetch, allow: ['api.acme.fr'], maxResponseBytes: 10 });
    await expect(http.request('https://api.acme.fr/')).rejects.toThrow(/too large/);
  });
});
