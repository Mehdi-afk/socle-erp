// SPDX-License-Identifier: LGPL-3.0-only
import type { ModelSnapshot, RegistrySnapshot, ViewSnapshot } from '@socle/framework';
import { describe, expect, it, vi } from 'vitest';

import { connectWebClient, RpcDataError } from './index.js';

const userId = 'alice';
const companyId = '00000000-0000-4000-8000-000000000001';
const recordId = '00000000-0000-4000-8000-000000000002';
const csrfToken = 'x'.repeat(43);
const partner: ModelSnapshot = {
  name: 'res.partner',
  description: { fr: 'Contacts', en: 'Contacts', ar: 'جهات الاتصال' },
  permissions: { create: false, write: true, unlink: false },
  fields: [
    { name: 'id', type: 'char', stored: true, readonly: true, required: true },
    { name: 'name', type: 'char', stored: true, readonly: false, label: { fr: 'Nom' } },
  ],
  order: [{ field: 'name', direction: 'asc' }],
};
const listView: ViewSnapshot = {
  id: 'base.partner_list',
  model: 'res.partner',
  type: 'list',
  priority: 16,
  arch: {
    type: 'list',
    attrs: {},
    children: [{ type: 'field', attrs: { name: 'name' }, children: [] }],
  },
};

function snapshot(): RegistrySnapshot {
  return { version: 1, userId, companyId, models: [partner], views: [listView] };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sessionFetch() {
  return vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ userId, csrfToken }));
}

async function failure(result: Promise<unknown>): Promise<RpcDataError> {
  try {
    await result;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcDataError);
    if (error instanceof RpcDataError) return error;
    throw error;
  }
  throw new Error('Expected the web client operation to fail');
}

describe('connectWebClient bootstrap', () => {
  it('loads the catalogues and RPC data under one session and CSRF token', async () => {
    const fetch = sessionFetch()
      .mockResolvedValueOnce(json(snapshot()))
      .mockResolvedValueOnce(json({ records: [{ id: recordId, name: 'Alice' }] }))
      .mockResolvedValueOnce(json({ ok: true }));
    const client = await connectWebClient({ fetch });
    expect(client.userId).toBe(userId);
    expect(client.companyId).toBe(companyId);
    expect(client.data.userId).toBe(userId);
    expect(client.registry.names()).toEqual(['res.partner']);
    expect(client.registry.get('res.partner')).not.toHaveProperty('recordClass');
    expect(client.registry.field('res.partner', 'name')).toMatchObject({
      type: 'char',
      stored: true,
      readonly: false,
    });
    expect(client.permissions.get('res.partner')).toEqual(partner.permissions);
    expect(client.views.ids()).toEqual(['base.partner_list']);
    expect(client.views.default('res.partner', 'list')).toEqual(listView);
    expect(client.views.default('res.partner', 'form')).toBeUndefined();

    await expect(client.data.read('res.partner', [recordId], ['name'])).resolves.toEqual([
      { id: recordId, name: 'Alice' },
    ]);
    await client.data.write('res.partner', recordId, { name: 'Updated' });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/auth/session',
      '/web/metadata',
      '/rpc/res.partner/read',
      '/rpc/res.partner/write',
    ]);
    const metadata = fetch.mock.calls[1]?.[1];
    expect(metadata?.body).toBe('{}');
    for (const [, init] of fetch.mock.calls) {
      expect(init).toMatchObject({
        mode: 'same-origin',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
      });
      expect(init?.signal).toBe(metadata?.signal);
    }
    for (const [, init] of fetch.mock.calls.slice(1)) {
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('x-csrf-token')).toBe(csrfToken);
      expect(new Headers(init?.headers).get('content-type')).toContain('application/json');
    }
    client.dispose();
  });

  it('accepts an empty catalogue for a user with no readable models', async () => {
    const fetch = sessionFetch().mockResolvedValueOnce(
      json({ ...snapshot(), companyId: null, models: [], views: [] }),
    );
    const client = await connectWebClient({ fetch });
    expect(client.registry.names()).toEqual([]);
    expect(client.views.ids()).toEqual([]);
    expect(client.permissions.size).toBe(0);
    expect(client.companyId).toBeNull();
    expect((await failure(client.data.read('res.partner', [recordId], ['name']))).code).toBe(
      'invalid',
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    client.dispose();
  });

  it('refuses metadata belonging to a different user without refreshing the session', async () => {
    const fetch = sessionFetch().mockResolvedValueOnce(json({ ...snapshot(), userId: 'bob' }));
    expect((await failure(connectWebClient({ fetch }))).code).toBe('invalid_response');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
  });

  it.each([
    { name: 'malformed envelope', payload: null },
    { name: 'unsupported version', payload: { ...snapshot(), version: 2 } },
    { name: 'unknown property', payload: { ...snapshot(), runtimeCode: 'PRIVATE CODE' } },
    {
      name: 'unknown view model',
      payload: { ...snapshot(), views: [{ ...listView, model: 'missing.model' }] },
    },
    {
      name: 'unknown field reference',
      payload: {
        ...snapshot(),
        views: [
          {
            ...listView,
            arch: {
              type: 'list',
              attrs: {},
              children: [{ type: 'field', attrs: { name: 'privateField' }, children: [] }],
            },
          },
        ],
      },
    },
    {
      name: 'missing relation target',
      payload: {
        ...snapshot(),
        models: [
          {
            ...partner,
            fields: [
              ...partner.fields,
              {
                name: 'parentId',
                type: 'many2one',
                comodel: 'missing.model',
                readonly: false,
                stored: true,
              },
            ],
          },
        ],
      },
    },
    { name: 'duplicate model', payload: { ...snapshot(), models: [partner, partner] } },
  ])('rejects $name atomically and closes the bootstrap connection', async ({ payload }) => {
    const fetch = sessionFetch().mockResolvedValueOnce(json(payload));
    const error = await failure(connectWebClient({ fetch }));
    expect(error.code).toBe('invalid_response');
    expect(error.message).not.toContain('PRIVATE CODE');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
  });

  it('does not retry a failed metadata request', async () => {
    const fetch = sessionFetch().mockRejectedValueOnce(new Error('PRIVATE NETWORK DETAILS'));
    const error = await failure(connectWebClient({ fetch }));
    expect(error.code).toBe('unavailable');
    expect(error.message).not.toContain('PRIVATE NETWORK DETAILS');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
  });

  it('honors an already aborted signal without fetching a session', async () => {
    const abort = new AbortController();
    abort.abort();
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect((await failure(connectWebClient({ fetch, signal: abort.signal }))).code).toBe(
      'disposed',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['session', 'metadata'])(
    'discards a late %s response after abort even if fetch ignores cancellation',
    async (stage) => {
      const pending = Promise.withResolvers<Response>();
      const abort = new AbortController();
      const fetch =
        stage === 'session'
          ? vi.fn<typeof globalThis.fetch>().mockImplementationOnce(() => pending.promise)
          : sessionFetch().mockImplementationOnce(() => pending.promise);
      const opening = failure(connectWebClient({ fetch, signal: abort.signal }));
      await vi.waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(stage === 'session' ? 1 : 2);
      });
      abort.abort();
      pending.resolve(json(stage === 'session' ? { userId, csrfToken } : snapshot()));
      expect((await opening).code).toBe('disposed');
      expect(fetch).toHaveBeenCalledTimes(stage === 'session' ? 1 : 2);
    },
  );

  it('discards metadata when cancellation arrives while its response body is being decoded', async () => {
    const decoding = Promise.withResolvers<unknown>();
    const response = json(snapshot());
    const decode = vi.spyOn(response, 'json').mockImplementation(() => decoding.promise);
    const fetch = sessionFetch().mockResolvedValueOnce(response);
    const abort = new AbortController();
    const opening = failure(connectWebClient({ fetch, signal: abort.signal }));
    await vi.waitFor(() => {
      expect(decode).toHaveBeenCalledTimes(1);
    });
    abort.abort();
    decoding.resolve(snapshot());
    expect((await opening).code).toBe('disposed');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('bootstrapped client lifecycle', () => {
  it.each(['client dispose', 'source dispose', 'external abort'])(
    'shares cancellation through %s',
    async (action) => {
      const pending = Promise.withResolvers<Response>();
      const abort = new AbortController();
      const fetch = sessionFetch()
        .mockResolvedValueOnce(json(snapshot()))
        .mockImplementationOnce(() => pending.promise);
      const client = await connectWebClient({ fetch, signal: abort.signal });
      const reading = failure(client.data.read('res.partner', [recordId], ['name']));
      await vi.waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(3);
      });
      if (action === 'client dispose') client.dispose();
      else if (action === 'source dispose') client.data.dispose();
      else abort.abort();
      expect(fetch.mock.calls[2]?.[1]?.signal?.aborted).toBe(true);
      pending.resolve(json({ records: [{ id: recordId, name: 'Late' }] }));
      expect((await reading).code).toBe('disposed');
      expect(
        (await failure(client.data.write('res.partner', recordId, { name: 'Changed' }))).code,
      ).toBe('disposed');
      expect(fetch).toHaveBeenCalledTimes(3);
      client.dispose();
    },
  );

  it.each([
    [401, 'unauthenticated'],
    [403, 'csrf'],
  ] as const)(
    'closes the client after HTTP %s %s without another bootstrap',
    async (status, code) => {
      const fetch = sessionFetch()
        .mockResolvedValueOnce(json(snapshot()))
        .mockResolvedValueOnce(json({ error: code }, status));
      const client = await connectWebClient({ fetch });
      expect(
        (await failure(client.data.write('res.partner', recordId, { name: 'Changed' }))).code,
      ).toBe(code);
      expect((await failure(client.data.read('res.partner', [recordId], ['name']))).code).toBe(
        code,
      );
      expect(fetch.mock.calls[2]?.[1]?.signal?.aborted).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(3);
      client.dispose();
    },
  );
});
