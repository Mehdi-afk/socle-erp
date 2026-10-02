// SPDX-License-Identifier: LGPL-3.0-only
// Bootstrap the browser catalog from authenticated, user-filtered server metadata over real PostgreSQL.
import type { RegistrySnapshot, ViewNode } from '@socle/framework';
import { connectWebClient } from '@socle/web';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import { createWebRpcFixture, FIRST_COMPANY, type BrowserSession } from './web-rpc.support.js';

let fixture: Awaited<ReturnType<typeof createWebRpcFixture>>;
let ready = false;
const clients: Awaited<ReturnType<typeof connectWebClient>>[] = [];
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

async function connect(session: BrowserSession = fixture.viewer, host: 'acme' | 'globex' = 'acme') {
  const browser = fixture.browser(host, session);
  const client = await connectWebClient({ fetch: browser.fetch, language: 'fr' });
  clients.push(client);
  return { client, calls: browser.calls };
}

function fieldNames(node: ViewNode): string[] {
  return [
    ...(node.type === 'field' && typeof node.attrs.name === 'string' ? [node.attrs.name] : []),
    ...node.children.flatMap(fieldNames),
  ];
}

describe('web metadata bootstrap with real sessions and PostgreSQL', () => {
  it('uses one session and filters models, fields, views and permissions for each user', async () => {
    // Ask as a manager first: its richer projection must never populate the viewer's catalog.
    const manager = await connect(fixture.manager);
    const viewer = await connect();
    expect(viewer.calls).toEqual([
      expect.objectContaining({ url: '/auth/session', method: 'GET', status: 200 }),
      expect.objectContaining({
        url: '/web/metadata',
        method: 'POST',
        body: {},
        sentCsrf: true,
        status: 200,
      }),
    ]);
    expect(viewer.client.userId).toBe('web-viewer');
    expect(viewer.client.companyId).toBe(FIRST_COMPANY);
    expect(manager.client.userId).toBe('web-manager');
    expect(viewer.client.registry.has('acc.partner')).toBe(true);
    expect(viewer.client.registry.has('acc.note')).toBe(false);
    expect(manager.client.registry.has('acc.note')).toBe(true);
    expect(viewer.client.registry.get('acc.partner').fields.has('internalMargin')).toBe(false);
    expect(manager.client.registry.get('acc.partner').fields.has('internalMargin')).toBe(true);
    expect(viewer.client.permissions.get('acc.partner')).toEqual({
      create: false,
      write: false,
      unlink: false,
    });
    expect(manager.client.permissions.get('acc.partner')).toEqual({
      create: true,
      write: true,
      unlink: true,
    });
    for (const view of ['acc_base.partner_form', 'rpc_test.partner_list']) {
      expect(fieldNames(viewer.client.views.get(view).arch)).not.toContain('internalMargin');
      expect(fieldNames(manager.client.views.get(view).arch)).toContain('internalMargin');
      expect(fieldNames(viewer.client.views.get(view).arch)).toContain('computedName');
    }
    const computed = viewer.client.registry.get('acc.partner').fields.get('computedName');
    expect(computed).toMatchObject({ type: 'char', readonly: true, stored: false });
    expect(computed).not.toHaveProperty('compute');
  });

  it('uses the hydrated catalog for real reads, writes and server-calculated fields', async () => {
    const { client, calls } = await connect(fixture.manager);
    expect(client.views.default('acc.partner', 'form')?.id).toBe('acc_base.partner_form');
    expect(
      await client.data.read(
        'acc.partner',
        [fixture.alphaId],
        ['name', 'computedName', 'internalMargin'],
      ),
    ).toEqual([
      {
        id: fixture.alphaId,
        name: 'Client Alpha',
        computedName: 'CLIENT ALPHA',
        internalMargin: 777,
      },
    ]);
    await client.data.write('acc.partner', fixture.editId, {
      name: 'Bootstrap saved',
      amount: 12346,
    });
    const fresh = await connect(fixture.manager);
    expect(
      await fresh.client.data.read(
        'acc.partner',
        [fixture.editId],
        ['name', 'computedName', 'amount'],
      ),
    ).toEqual([
      {
        id: fixture.editId,
        name: 'Bootstrap saved',
        computedName: 'BOOTSTRAP SAVED',
        amount: 12346,
      },
    ]);
    expect(calls.filter((call) => call.url === '/auth/session')).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'POST').every((call) => call.sentCsrf)).toBe(
      true,
    );
  });

  it('keeps server authorization authoritative after local metadata permissions are forged', async () => {
    const browser = fixture.browser('acme', fixture.viewer);
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const response = await browser.fetch(input, init);
      if (input !== '/web/metadata') return response;
      const snapshot = (await response.json()) as RegistrySnapshot;
      return new Response(
        JSON.stringify({
          ...snapshot,
          models: snapshot.models.map((model) =>
            model.name === 'acc.partner'
              ? {
                  ...model,
                  permissions: { create: true, write: true, unlink: true },
                  fields: model.fields.map((field) =>
                    field.name === 'city' ? { ...field, readonly: false } : field,
                  ),
                }
              : model,
          ),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const client = await connectWebClient({ fetch });
    clients.push(client);
    expect(client.permissions.get('acc.partner')?.write).toBe(true);
    await expect(
      client.data.write('acc.partner', fixture.alphaId, { city: 'Forbidden update' }),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    expect(browser.calls.at(-1)).toMatchObject({ url: '/rpc/acc.partner/write', status: 403 });
    const manager = await connect(fixture.manager);
    expect(await manager.client.data.read('acc.partner', [fixture.alphaId], ['city'])).toEqual([
      { id: fixture.alphaId, city: 'Alger' },
    ]);
  });

  it('does not turn catalog write permissions into access to another company record', async () => {
    const { client } = await connect(fixture.reader);
    expect(client.permissions.get('acc.partner')?.write).toBe(true);
    await expect(
      client.data.write('acc.partner', fixture.hiddenId, { city: 'Forbidden company' }),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    const manager = await connect(fixture.manager);
    expect(await manager.client.data.read('acc.partner', [fixture.hiddenId], ['city'])).toEqual([
      { id: fixture.hiddenId, city: 'Secret company' },
    ]);
  });

  it('isolates catalogs and sessions between tenants even when user identifiers are equal', async () => {
    const acme = await connect(fixture.manager);
    const globex = await connect(fixture.other, 'globex');
    expect(acme.client.userId).toBe(globex.client.userId);
    expect(acme.client.registry.has('rpc.acme_only')).toBe(true);
    expect(acme.client.registry.has('rpc.globex_only')).toBe(false);
    expect(globex.client.registry.has('rpc.globex_only')).toBe(true);
    expect(globex.client.registry.has('rpc.acme_only')).toBe(false);
    expect(
      await globex.client.data.search('acc.partner', { fields: ['name'], limit: 10, offset: 0 }),
    ).toEqual({ records: [{ id: fixture.otherId, name: 'Globex only' }], total: 1 });
    const wrongTenant = fixture.browser('globex', fixture.manager);
    await expect(connectWebClient({ fetch: wrongTenant.fetch })).rejects.toMatchObject({
      code: 'unauthenticated',
      status: 401,
    });
    expect(wrongTenant.calls.map((call) => call.url)).toEqual(['/auth/session']);
  });

  it('requires CSRF on metadata and does not attempt RPCs or silently reconnect after refusal', async () => {
    const browser = fixture.browser('acme', fixture.viewer, { stripCsrf: true });
    await expect(connectWebClient({ fetch: browser.fetch })).rejects.toMatchObject({
      code: 'csrf',
      status: 403,
    });
    expect(browser.calls.map((call) => call.url)).toEqual(['/auth/session', '/web/metadata']);
    expect(browser.calls.at(-1)).toMatchObject({ sentCsrf: false, status: 403 });
  });
});
