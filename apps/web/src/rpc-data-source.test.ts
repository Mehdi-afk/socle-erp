// SPDX-License-Identifier: LGPL-3.0-only
import { buildModelRegistry, defineModel, f } from '@socle/framework';
import { WriteFailure } from '@socle/view-engine/data-source';
import { describe, expect, it, vi } from 'vitest';

import { connectRpcDataSource, RpcDataError } from './index.js';

const registry = buildModelRegistry(
  [
    {
      module: 'test',
      models: [
        defineModel({
          name: 'res.partner',
          fields: {
            name: f.char(),
            code: f.char(),
            email: f.char(),
            secret: f.char({ sensitive: true }),
          },
        }),
        defineModel({
          name: 'test.coded',
          fields: { name: f.char({ sensitive: true }), code: f.char() },
        }),
        defineModel({
          name: 'test.restricted',
          fields: { name: f.char({ groups: ['base.group_manager'] }), code: f.char() },
        }),
        defineModel({ name: 'test.text_name', fields: { name: f.text() } }),
        defineModel({ name: 'test.unnamed', fields: { title: f.char() } }),
        defineModel({
          name: 'test.private_name',
          fields: {
            name: f.char({ sensitive: true }),
            code: f.char({ groups: ['base.group_manager'] }),
          },
        }),
        defineModel({
          name: 'test.numeric_name',
          fields: { name: f.integer(), code: f.integer() },
        }),
      ],
    },
  ],
  { side: 'client' },
);

function id(number: number): string {
  return `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
}

const firstId = id(1);
const secondId = id(2);
const userId = id(99);
const csrfToken = 'x'.repeat(43);

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fetchWithSession() {
  return vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ userId, csrfToken }));
}

function cyclicValue(): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  value.self = value;
  return value;
}

const nonJsonValues = [
  { label: 'undefined', value: undefined },
  { label: 'NaN', value: NaN },
  { label: 'Infinity', value: Infinity },
  { label: 'BigInt', value: 1n },
  { label: 'cycle', value: cyclicValue() },
];

function body(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
  return JSON.parse(init.body) as unknown;
}

async function failure(result: Promise<unknown>): Promise<RpcDataError> {
  try {
    await result;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcDataError);
    expect(error).toBeInstanceOf(WriteFailure);
    if (error instanceof RpcDataError) return error;
    throw error;
  }
  throw new Error('Expected the RPC operation to fail');
}

describe('connectRpcDataSource', () => {
  it('gets one session and uses fixed same-origin requests with CSRF on every RPC', async () => {
    const fetch = fetchWithSession()
      .mockResolvedValueOnce(json({ records: [{ id: firstId, name: 'Alice' }] }))
      .mockResolvedValueOnce(json({ ok: true }));
    const source = await connectRpcDataSource({ registry, fetch });
    expect(source.userId).toBe(userId);
    await source.read('res.partner', [firstId], ['name']);
    await source.write('res.partner', firstId, { name: 'Updated' });

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/auth/session',
      '/rpc/res.partner/read',
      '/rpc/res.partner/write',
    ]);
    for (const [, init] of fetch.mock.calls) {
      expect(init).toMatchObject({
        credentials: 'same-origin',
        mode: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(fetch.mock.calls[0]?.[1]?.method ?? 'GET').toBe('GET');
    for (const [, init] of fetch.mock.calls.slice(1)) {
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      expect(headers.get('content-type')).toContain('application/json');
      expect(headers.get('x-csrf-token')).toBe(csrfToken);
    }
    expect(body(fetch.mock.calls[2]?.[1])).toEqual({ ids: [firstId], values: { name: 'Updated' } });
    source.dispose();
  });

  it.each([
    null,
    {},
    { userId, csrfToken: '' },
    { userId: '', csrfToken },
    { userId, csrfToken: 42 },
    { userId: 42, csrfToken },
  ])('rejects an invalid session payload: %j', async (payload) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(payload));
    expect((await failure(connectRpcDataSource({ registry, fetch }))).code).toBe(
      'invalid_response',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a session error without retrying or exposing its body', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        json({ error: 'unauthenticated', message: 'RAW SESSION SECRET' }, 401),
      );
    const error = await failure(connectRpcDataSource({ registry, fetch }));
    expect(error).toMatchObject({ code: 'unauthenticated', status: 401, fieldErrors: {} });
    expect(error.message).not.toContain('RAW SESSION SECRET');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('RPC reads and searches', () => {
  it('short-circuits empty reads and names without making an RPC request', async () => {
    const fetch = fetchWithSession();
    const source = await connectRpcDataSource({ registry, fetch });
    await expect(source.read('res.partner', [], ['name'])).resolves.toEqual([]);
    await expect(source.displayNames('res.partner', [])).resolves.toEqual(new Map());
    expect(fetch).toHaveBeenCalledTimes(1);
    source.dispose();
  });

  it('deduplicates IDs, strips id from fields, projects fields and restores requested order', async () => {
    const fetch = fetchWithSession().mockResolvedValueOnce(
      json({
        records: [
          { id: secondId, name: 'Bob', secret: 'HIDDEN', injected: true },
          { id: firstId, name: 'Alice', email: 'hidden@example.test' },
        ],
      }),
    );
    const source = await connectRpcDataSource({ registry, fetch });
    await expect(
      source.read('res.partner', [firstId, secondId, firstId], ['id', 'name']),
    ).resolves.toEqual([
      { id: firstId, name: 'Alice' },
      { id: secondId, name: 'Bob' },
    ]);
    expect(body(fetch.mock.calls[1]?.[1])).toEqual({ ids: [firstId, secondId], fields: ['name'] });
    source.dispose();
  });

  it('canonicalizes mixed-case UUIDs before deduplication, reads, writes and label fallback', async () => {
    const canonicalId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
    const upperId = canonicalId.toUpperCase();
    const fetch = fetchWithSession()
      .mockResolvedValueOnce(json({ records: [{ id: canonicalId, name: 'Alice' }] }))
      .mockResolvedValueOnce(json({ ok: true }));
    const source = await connectRpcDataSource({ registry, fetch });
    await expect(source.read('res.partner', [upperId, canonicalId], ['name'])).resolves.toEqual([
      { id: canonicalId, name: 'Alice' },
    ]);
    expect(body(fetch.mock.calls[1]?.[1])).toEqual({ ids: [canonicalId], fields: ['name'] });
    await source.write('res.partner', upperId, { name: 'Updated' });
    expect(body(fetch.mock.calls[2]?.[1])).toEqual({
      ids: [canonicalId],
      values: { name: 'Updated' },
    });
    await expect(source.displayNames('test.unnamed', [upperId, canonicalId])).resolves.toEqual(
      new Map([[canonicalId, canonicalId]]),
    );
    expect(fetch).toHaveBeenCalledTimes(3);
    source.dispose();
  });

  it('reads batches of at most 1000 sequentially while preserving global ID order', async () => {
    const ids = Array.from({ length: 1002 }, (_, index) => id(index + 1));
    const firstBatch = Promise.withResolvers<Response>();
    const fetch = fetchWithSession()
      .mockImplementationOnce(() => firstBatch.promise)
      .mockResolvedValueOnce(
        json({ records: ids.slice(1000).map((recordId) => ({ id: recordId, name: recordId })) }),
      );
    const source = await connectRpcDataSource({ registry, fetch });
    const reading = source.read('res.partner', ids, ['name']);
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
    });
    expect(body(fetch.mock.calls[1]?.[1])).toEqual({ ids: ids.slice(0, 1000), fields: ['name'] });
    firstBatch.resolve(
      json({
        records: ids
          .slice(0, 1000)
          .reverse()
          .map((recordId) => ({ id: recordId, name: recordId })),
      }),
    );
    expect((await reading).map((record) => record.id)).toEqual(ids);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(body(fetch.mock.calls[2]?.[1])).toEqual({ ids: ids.slice(1000), fields: ['name'] });
    source.dispose();
  });

  it('starts searchRead and searchCount in parallel and forwards pagination and domain', async () => {
    const records = Promise.withResolvers<Response>();
    const count = Promise.withResolvers<Response>();
    const fetch = fetchWithSession().mockImplementation((url) => {
      if (url === '/rpc/res.partner/searchRead') return records.promise;
      if (url === '/rpc/res.partner/searchCount') return count.promise;
      return Promise.reject(new Error('Unexpected RPC path'));
    });
    const source = await connectRpcDataSource({ registry, fetch });
    const domain = [['name', 'ilike', 'Ali']];
    const searching = source.search('res.partner', {
      fields: ['id', 'name'],
      domain,
      order: 'name desc',
      limit: 5,
      offset: 10,
    });
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(3);
    });
    expect(
      body(fetch.mock.calls.find(([url]) => url === '/rpc/res.partner/searchRead')?.[1]),
    ).toEqual({
      fields: ['name'],
      domain,
      order: 'name desc',
      limit: 5,
      offset: 10,
    });
    expect(
      body(fetch.mock.calls.find(([url]) => url === '/rpc/res.partner/searchCount')?.[1]),
    ).toEqual({ domain });
    count.resolve(json({ count: 24 }));
    records.resolve(json({ records: [{ id: firstId, name: 'Alice', secret: 'hidden' }] }));
    await expect(searching).resolves.toEqual({
      records: [{ id: firstId, name: 'Alice' }],
      total: 24,
    });
    source.dispose();
  });

  it.each([
    ['missing.model', firstId],
    ['res.partner/../auth', firstId],
    ['https://remote.test', firstId],
    ['res.partner', 'not-a-uuid'],
    ['res.partner', `${firstId}/write`],
  ])('rejects invalid model/ID parameters before fetching: %s %s', async (model, recordId) => {
    const fetch = fetchWithSession();
    const source = await connectRpcDataSource({ registry, fetch });
    expect((await failure(source.read(model, [recordId], ['name']))).code).toBe('invalid');
    expect((await failure(source.write(model, recordId, { name: 'Alice' }))).code).toBe('invalid');
    expect(fetch).toHaveBeenCalledTimes(1);
    source.dispose();
  });

  it.each([
    null,
    {},
    { records: {} },
    { records: [{ id: 'not-a-uuid', name: 'Bad' }] },
    {
      records: [
        { id: firstId, name: 'Alice' },
        { id: firstId, name: 'Duplicate' },
      ],
    },
    { records: [{ id: secondId, name: 'Unrequested' }] },
    { records: [{ id: firstId }] },
  ])('rejects malformed, duplicate or unrequested read records: %j', async (payload) => {
    const fetch = fetchWithSession().mockResolvedValueOnce(json(payload));
    const source = await connectRpcDataSource({ registry, fetch });
    expect((await failure(source.read('res.partner', [firstId], ['name']))).code).toBe(
      'invalid_response',
    );
    source.dispose();
  });

  it.each([-1, 1.5, '10', null])('rejects an invalid search count: %j', async (count) => {
    const fetch = fetchWithSession().mockImplementation((url) =>
      Promise.resolve(
        url === '/rpc/res.partner/searchCount' ? json({ count }) : json({ records: [] }),
      ),
    );
    const source = await connectRpcDataSource({ registry, fetch });
    expect(
      (await failure(source.search('res.partner', { fields: ['name'], limit: 1, offset: 0 }))).code,
    ).toBe('invalid_response');
    source.dispose();
  });

  it('accepts an explicitly undefined optional sort without sending it', async () => {
    const fetch = fetchWithSession().mockImplementation((url) =>
      Promise.resolve(
        url === '/rpc/res.partner/searchCount' ? json({ count: 0 }) : json({ records: [] }),
      ),
    );
    const source = await connectRpcDataSource({ registry, fetch });
    await expect(
      source.search('res.partner', { fields: ['name'], order: undefined, limit: 1, offset: 0 }),
    ).resolves.toEqual({ records: [], total: 0 });
    expect(
      body(fetch.mock.calls.find(([url]) => url === '/rpc/res.partner/searchRead')?.[1]),
    ).toEqual({ fields: ['name'], domain: [], limit: 1, offset: 0 });
    source.dispose();
  });

  it.each(nonJsonValues)(
    'rejects a non-JSON domain value before fetching: $label',
    async ({ value }) => {
      const fetch = fetchWithSession();
      const source = await connectRpcDataSource({ registry, fetch });
      const error = await failure(
        source.search('res.partner', {
          fields: ['name'],
          domain: [['name', '=', value]],
          limit: 1,
          offset: 0,
        }),
      );
      expect(error.code).toBe('invalid');
      expect(fetch).toHaveBeenCalledTimes(1);
      source.dispose();
    },
  );

  it('rejects search results that exceed the requested limit', async () => {
    const fetch = fetchWithSession().mockImplementation((url) =>
      Promise.resolve(
        url === '/rpc/res.partner/searchCount'
          ? json({ count: 2 })
          : json({
              records: [
                { id: firstId, name: 'Alice' },
                { id: secondId, name: 'Bob' },
              ],
            }),
      ),
    );
    const source = await connectRpcDataSource({ registry, fetch });
    expect(
      (await failure(source.search('res.partner', { fields: ['name'], limit: 1, offset: 0 }))).code,
    ).toBe('invalid_response');
    source.dispose();
  });

  it('rejects non-JSON success responses without surfacing their contents', async () => {
    const fetch = fetchWithSession().mockResolvedValueOnce(
      new Response('<html>PRIVATE TRACE</html>'),
    );
    const source = await connectRpcDataSource({ registry, fetch });
    const error = await failure(source.read('res.partner', [firstId], ['name']));
    expect(error.code).toBe('invalid_response');
    expect(error.message).not.toContain('PRIVATE TRACE');
    source.dispose();
  });
});

describe('RPC display names', () => {
  it.each([
    ['res.partner', 'name'],
    ['test.text_name', 'name'],
    ['test.coded', 'code'],
    ['test.restricted', 'code'],
  ])('chooses a public text label for %s', async (model, field) => {
    const fetch = fetchWithSession().mockResolvedValueOnce(
      json({ records: [{ id: firstId, [field]: 'Visible label', secret: 'Hidden' }] }),
    );
    const source = await connectRpcDataSource({ registry, fetch });
    await expect(source.displayNames(model, [firstId])).resolves.toEqual(
      new Map([[firstId, 'Visible label']]),
    );
    expect(fetch.mock.calls[1]?.[0]).toBe(`/rpc/${model}/read`);
    expect(body(fetch.mock.calls[1]?.[1])).toEqual({ ids: [firstId], fields: [field] });
    source.dispose();
  });

  it.each(['test.unnamed', 'test.private_name', 'test.numeric_name'])(
    'uses IDs without fetching when %s has no safe label',
    async (model) => {
      const fetch = fetchWithSession();
      const source = await connectRpcDataSource({ registry, fetch });
      await expect(source.displayNames(model, [firstId, secondId])).resolves.toEqual(
        new Map([
          [firstId, firstId],
          [secondId, secondId],
        ]),
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      source.dispose();
    },
  );

  it.each([null, '', '   '])('uses the record ID when the label is empty: %j', async (name) => {
    const fetch = fetchWithSession().mockResolvedValueOnce(
      json({ records: [{ id: firstId, name }] }),
    );
    const source = await connectRpcDataSource({ registry, fetch });
    await expect(source.displayNames('res.partner', [firstId])).resolves.toEqual(
      new Map([[firstId, firstId]]),
    );
    source.dispose();
  });

  it('rejects non-text labels instead of coercing an untrusted object', async () => {
    const fetch = fetchWithSession().mockResolvedValueOnce(
      json({ records: [{ id: firstId, name: { html: 'PRIVATE' } }] }),
    );
    const source = await connectRpcDataSource({ registry, fetch });
    expect((await failure(source.displayNames('res.partner', [firstId]))).code).toBe(
      'invalid_response',
    );
    source.dispose();
  });
});

describe('RPC failures and lifecycle', () => {
  it.each(nonJsonValues)(
    'rejects a non-JSON write value before fetching: $label',
    async ({ value }) => {
      const fetch = fetchWithSession();
      const source = await connectRpcDataSource({ registry, fetch });
      expect((await failure(source.write('res.partner', firstId, { name: value }))).code).toBe(
        'invalid',
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      source.dispose();
    },
  );

  it.each([
    [400, 'invalid_request', 'invalid'],
    [403, 'forbidden', 'forbidden'],
    [404, 'not_found', 'not_found'],
    [429, 'rate_limit', 'rate_limited'],
    [500, 'internal', 'unavailable'],
  ])('maps HTTP %s to a safe error and never retries a write', async (status, serverCode, code) => {
    const fetch = fetchWithSession().mockResolvedValueOnce(
      json(
        {
          error: serverCode,
          message: 'RAW SERVER SECRET',
          fieldErrors: { name: 'RAW FIELD SECRET' },
        },
        status,
      ),
    );
    const source = await connectRpcDataSource({ registry, fetch });
    const error = await failure(source.write('res.partner', firstId, { name: 'Updated' }));
    expect(error).toMatchObject({ code, status, fieldErrors: {} });
    expect(error.message).not.toContain('RAW');
    expect(fetch).toHaveBeenCalledTimes(2);
    source.dispose();
  });

  it('does not retry a write after a network failure with an uncertain outcome', async () => {
    const fetch = fetchWithSession().mockRejectedValueOnce(new Error('PRIVATE NETWORK DETAILS'));
    const source = await connectRpcDataSource({ registry, fetch });
    const error = await failure(source.write('res.partner', firstId, { name: 'Updated' }));
    expect(error).toMatchObject({ code: 'unavailable', status: undefined });
    expect(error.message).not.toContain('PRIVATE NETWORK DETAILS');
    expect(fetch).toHaveBeenCalledTimes(2);
    source.dispose();
  });

  it.each([null, {}, { ok: false }, { ok: 'true' }])(
    'rejects an invalid write acknowledgement: %j',
    async (payload) => {
      const fetch = fetchWithSession().mockResolvedValueOnce(json(payload));
      const source = await connectRpcDataSource({ registry, fetch });
      expect((await failure(source.write('res.partner', firstId, { name: 'Updated' }))).code).toBe(
        'invalid_response',
      );
      expect(fetch).toHaveBeenCalledTimes(2);
      source.dispose();
    },
  );

  it.each([
    [401, 'unauthenticated'],
    [403, 'csrf'],
  ])('invalidates the source after %s %s without refreshing identity', async (status, code) => {
    const pending = Promise.withResolvers<Response>();
    const fetch = fetchWithSession()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(json({ error: code }, status));
    const source = await connectRpcDataSource({ registry, fetch });
    const failedRead = failure(source.read('res.partner', [firstId], ['name']));
    expect((await failure(source.write('res.partner', firstId, { name: 'Updated' }))).code).toBe(
      code,
    );
    expect(fetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    pending.resolve(json({ records: [{ id: firstId, name: 'Stale' }] }));
    expect((await failedRead).code).toBe(code);
    expect((await failure(source.read('res.partner', [firstId], ['name']))).code).toBe(code);
    expect((await failure(source.write('res.partner', firstId, { name: 'Again' }))).code).toBe(
      code,
    );
    expect(fetch).toHaveBeenCalledTimes(3);
    source.dispose();
  });

  it.each(['dispose', 'external abort'])(
    'rejects late replies after %s even when fetch ignores cancellation',
    async (action) => {
      const pending = Promise.withResolvers<Response>();
      const abort = new AbortController();
      const fetch = fetchWithSession().mockImplementationOnce(() => pending.promise);
      const source = await connectRpcDataSource({ registry, fetch, signal: abort.signal });
      const failedRead = failure(source.read('res.partner', [firstId], ['name']));
      await vi.waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(2);
      });
      if (action === 'dispose') source.dispose();
      else abort.abort();
      expect(fetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
      pending.resolve(json({ records: [{ id: firstId, name: 'Stale' }] }));
      expect((await failedRead).code).toBe('disposed');
      await failure(source.read('res.partner', [firstId], ['name']));
      expect(fetch).toHaveBeenCalledTimes(2);
      source.dispose();
    },
  );

  it('uses localized, safe error messages in French, English and Arabic', async () => {
    const messages: string[] = [];
    for (const language of ['fr-DZ', 'en-US', 'ar-DZ']) {
      const fetch = fetchWithSession().mockResolvedValueOnce(
        json({ error: 'forbidden', message: 'RAW SERVER MESSAGE' }, 403),
      );
      const source = await connectRpcDataSource({ registry, fetch, language });
      const error = await failure(source.write('res.partner', firstId, { name: 'Updated' }));
      expect(error.message).not.toContain('RAW SERVER MESSAGE');
      expect(error.message.length).toBeGreaterThan(10);
      messages.push(error.message);
      source.dispose();
    }
    expect(new Set(messages).size).toBe(3);
    expect(messages[2]).toMatch(/[\u0600-\u06ff]/u);
  });
});
