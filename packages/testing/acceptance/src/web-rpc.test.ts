// SPDX-License-Identifier: LGPL-3.0-only
// The browser data source against real Fastify routes, installed modules and PostgreSQL.
import { AUDIT_TABLE, verifyAudit } from '@socle/orm-pg';
import { connectRpcDataSource, RpcDataError, type RpcDataSource } from '@socle/web';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import { createWebRpcFixture, type BrowserSession } from './web-rpc.support.js';

let fixture: Awaited<ReturnType<typeof createWebRpcFixture>>;
let ready = false;
const clients: RpcDataSource[] = [];
beforeAll(async () => {
  fixture = await createWebRpcFixture(inject('pgUrl'));
  ready = true;
});
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
});
afterAll(async () => {
  if (ready) await fixture.close();
});

async function connect(
  session: BrowserSession = fixture.reader,
  options: { readonly stripCsrf?: boolean } = {},
) {
  const browser = fixture.browser('acme', session, options);
  const source = await connectRpcDataSource({
    registry: fixture.acme.clientRegistry,
    fetch: browser.fetch,
    language: 'fr',
  });
  clients.push(source);
  return { source, calls: browser.calls };
}

describe('web RPC data source with real sessions and PostgreSQL', () => {
  it('searches a page and counts the same authorised domain through authenticated POSTs', async () => {
    const { source, calls } = await connect();
    expect(source.userId).toBe('web-reader');
    const domain = [['id', 'in', [fixture.alphaId, fixture.betaId, fixture.hiddenId]]];
    const page = await source.search('acc.partner', {
      fields: ['id', 'name', 'city'],
      domain,
      order: 'name',
      offset: 0,
      limit: 1,
    });
    expect(page).toEqual({
      records: [{ id: fixture.alphaId, name: 'Client Alpha', city: 'Alger' }],
      total: 2,
    });
    expect(calls.map((call) => call.url).sort()).toEqual([
      '/auth/session',
      '/rpc/acc.partner/searchCount',
      '/rpc/acc.partner/searchRead',
    ]);
    expect(
      calls
        .filter((call) => call.method === 'POST')
        .every((call) => call.sentCsrf && call.status === 200),
    ).toBe(true);
    expect(calls.find((call) => call.url.endsWith('/searchCount'))?.body).toEqual({ domain });
    expect(calls.find((call) => call.url.endsWith('/searchRead'))?.body).toMatchObject({
      domain,
      fields: ['name', 'city'],
    });
  });

  it('reads distinct IDs with the implicit id field and obtains relation names and code-only labels', async () => {
    const { source, calls } = await connect();
    const rows = await source.read(
      'acc.partner',
      [fixture.alphaId.toUpperCase(), fixture.alphaId, fixture.betaId],
      ['id', 'name'],
    );
    expect(rows).toEqual([
      { id: fixture.alphaId, name: 'Client Alpha' },
      { id: fixture.betaId, name: 'Client Beta' },
    ]);
    expect(calls.at(-1)?.body).toEqual({
      ids: [fixture.alphaId, fixture.betaId],
      fields: ['name'],
    });
    expect(await source.displayNames('acc.partner', [fixture.alphaId])).toEqual(
      new Map([[fixture.alphaId, 'Client Alpha']]),
    );
    expect(await source.displayNames('res.currency', [fixture.currencyId])).toEqual(
      new Map([[fixture.currencyId, 'DZD']]),
    );
    const before = calls.length;
    expect(await source.read('acc.partner', [], ['name'])).toEqual([]);
    expect(calls).toHaveLength(before);
  });

  it('persists a write for another adapter instance and appends a valid audit entry', async () => {
    const { source } = await connect();
    await source.write('acc.partner', fixture.editId, {
      city: 'Constantine',
      score: 17,
      amount: 12346,
    });
    const second = await connect();
    expect(
      await second.source.read('acc.partner', [fixture.editId], ['city', 'score', 'amount']),
    ).toEqual([{ id: fixture.editId, city: 'Constantine', score: 17, amount: 12346 }]);
    const stored = await sql<{
      city: string;
      score: number;
      amount: number;
    }>`select city, score, amount from acc_partner where id = ${fixture.editId}::uuid`.execute(
      fixture.acme.db,
    );
    expect(stored.rows).toEqual([{ city: 'Constantine', score: 17, amount: 12346 }]);
    const entries = await sql<{
      user_id: string;
      details: { fields: string[] };
    }>`select user_id, details from ${sql.table(AUDIT_TABLE)} where kind = 'write' and model = 'acc.partner' and record_ids @> ${JSON.stringify([fixture.editId])}::jsonb order by seq desc limit 1`.execute(
      fixture.acme.db,
    );
    expect(entries.rows[0]?.user_id).toBe('web-reader');
    expect(entries.rows[0]?.details.fields).toEqual(
      expect.arrayContaining(['city', 'score', 'amount']),
    );
    expect(await verifyAudit(fixture.acme.db)).toMatchObject({ ok: true });
  });

  it('refuses another company and a restricted field without changing stored values', async () => {
    const { source, calls } = await connect();
    await expect(
      source.write('acc.partner', fixture.hiddenId, { city: 'Intrusion' }),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    await expect(
      source.read('acc.partner', [fixture.alphaId], ['internalMargin']),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    await expect(
      source.write('acc.partner', fixture.alphaId, { internalMargin: 0 }),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    const stored = await sql<{
      id: string;
      city: string;
      internal_margin: number;
    }>`select id, city, internal_margin from acc_partner where id in (${fixture.alphaId}::uuid, ${fixture.hiddenId}::uuid)`.execute(
      fixture.acme.db,
    );
    expect(stored.rows.find((row) => row.id === fixture.hiddenId)?.city).toBe('Secret company');
    expect(stored.rows.find((row) => row.id === fixture.alphaId)?.internal_margin).toBe(777);
    expect(calls.filter((call) => call.status === 403)).toHaveLength(3);
    // An ordinary permission refusal is not a lost session: an authorised read still works.
    expect(await source.read('acc.partner', [fixture.betaId], ['name'])).toEqual([
      { id: fixture.betaId, name: 'Client Beta' },
    ]);
  });

  it('reports a server validation refusal and leaves the record unchanged', async () => {
    const { source, calls } = await connect();
    let error: unknown;
    try {
      await source.write('acc.partner', fixture.betaId, { amount: 12.5 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RpcDataError);
    expect(error).toMatchObject({ code: 'invalid', status: 400 });
    expect(calls.at(-1)).toMatchObject({ url: '/rpc/acc.partner/write', status: 400 });
    expect(await source.read('acc.partner', [fixture.betaId], ['amount'])).toEqual([
      { id: fixture.betaId, amount: 0 },
    ]);
  });

  it('requires a session and never repairs a missing CSRF header on a reading POST', async () => {
    const anonymous = fixture.browser('acme');
    await expect(
      connectRpcDataSource({ registry: fixture.acme.clientRegistry, fetch: anonymous.fetch }),
    ).rejects.toMatchObject({ code: 'unauthenticated', status: 401 });
    expect(anonymous.calls).toHaveLength(1);
    const { source, calls } = await connect(fixture.reader, { stripCsrf: true });
    await expect(source.read('acc.partner', [fixture.alphaId], ['name'])).rejects.toMatchObject({
      code: 'csrf',
      status: 403,
    });
    expect(calls.at(-1)).toMatchObject({ sentCsrf: false, status: 403 });
    const before = calls.length;
    await expect(source.read('acc.partner', [fixture.alphaId], ['name'])).rejects.toMatchObject({
      code: 'csrf',
      status: 403,
    });
    expect(calls).toHaveLength(before);
  });

  it('invalidates a revoked session without refresh or replay and allows an explicit fresh connection', async () => {
    const session = await fixture.signIn('acme');
    const { source, calls } = await connect(session);
    await fixture.logout('acme', session);
    await expect(
      source.write('acc.partner', fixture.betaId, { city: 'Must not be saved' }),
    ).rejects.toMatchObject({ code: 'unauthenticated', status: 401 });
    const before = calls.length;
    await expect(source.read('acc.partner', [fixture.betaId], ['city'])).rejects.toMatchObject({
      code: 'unauthenticated',
      status: 401,
    });
    expect(calls).toHaveLength(before);
    const fresh = await connect(await fixture.signIn('acme'));
    expect(await fresh.source.read('acc.partner', [fixture.betaId], ['city'])).toEqual([
      { id: fixture.betaId, city: 'Oran' },
    ]);
  });

  it('keeps sessions and known record identifiers isolated between tenant databases', async () => {
    const stolen = fixture.browser('globex', fixture.reader);
    await expect(
      connectRpcDataSource({ registry: fixture.globex.clientRegistry, fetch: stolen.fetch }),
    ).rejects.toMatchObject({ code: 'unauthenticated', status: 401 });
    const browser = fixture.browser('globex', fixture.other);
    const source = await connectRpcDataSource({
      registry: fixture.globex.clientRegistry,
      fetch: browser.fetch,
    });
    clients.push(source);
    expect(await source.search('acc.partner', { fields: ['name'], offset: 0, limit: 10 })).toEqual({
      records: [{ id: fixture.otherId, name: 'Globex only' }],
      total: 1,
    });
    await expect(
      source.write('acc.partner', fixture.alphaId, { city: 'Cross-tenant write' }),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    const current = await connect();
    expect((await current.source.read('acc.partner', [fixture.alphaId], ['city']))[0]?.city).toBe(
      'Alger',
    );
  });
});
