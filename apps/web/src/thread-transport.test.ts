// SPDX-License-Identifier: LGPL-3.0-only
import { buildModelRegistry, defineModel, f } from '@socle/framework';
import { describe, expect, it } from 'vitest';

import { connectRpcDataSource } from './rpc-data-source.js';

const registry = buildModelRegistry(
  [{ module: 'test', models: [defineModel({ name: 'res.partner', fields: { name: f.char() } })] }],
  { side: 'client' },
);
const id = '018f0000-0000-7000-8000-000000000001';
const csrfToken = 'a'.repeat(43);
const message = {
  id,
  kind: 'comment',
  body: 'Texte',
  authorId: 'user',
  createdAt: '2026-10-02T12:00:00.000Z',
  changes: null,
};
describe('same-session mail transport', () => {
  it('uses validated relative routes and the source CSRF token without a second session', async () => {
    const calls: { path: string; csrf: string | null; body: unknown }[] = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
      const path =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({
        path,
        csrf: new Headers(init?.headers).get('x-csrf-token'),
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
      });
      return Promise.resolve(
        Response.json(
          path === '/auth/session'
            ? { userId: 'user', csrfToken }
            : path.endsWith('/messages')
              ? { message }
              : {
                  messages: [message],
                  before: null,
                  activities: [],
                  types: [],
                  following: false,
                  internal: true,
                  canPost: true,
                },
        ),
      );
    };
    const source = await connectRpcDataSource({ registry, fetch });
    if (!source.thread) throw new Error('Missing thread adapter.');
    expect((await source.thread.read('res.partner', id)).messages[0]?.body).toBe('Texte');
    await source.thread.post('res.partner', id, 'Texte', 'comment');
    expect(calls).toEqual([
      { path: '/auth/session', csrf: null, body: null },
      { path: `/mail/res.partner/${id}/read`, csrf: csrfToken, body: {} },
      {
        path: `/mail/res.partner/${id}/messages`,
        csrf: csrfToken,
        body: { body: 'Texte', kind: 'comment' },
      },
    ]);
    await expect(source.thread.post('../evil', id, 'Texte', 'comment')).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(source.thread.post('res.partner', id, ' ', 'comment')).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(calls).toHaveLength(3);
    source.dispose();
  });
  it('closes the entire source when a conversation detects session expiration', async () => {
    const fetch: typeof globalThis.fetch = (input) =>
      Promise.resolve(
        input === '/auth/session'
          ? Response.json({ userId: 'user', csrfToken })
          : Response.json({ error: 'unauthenticated' }, { status: 401 }),
      );
    const source = await connectRpcDataSource({ registry, fetch });
    if (!source.thread) throw new Error('Missing thread adapter.');
    await expect(source.thread.read('res.partner', id)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    await expect(source.read('res.partner', [id], ['name'])).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });
});
