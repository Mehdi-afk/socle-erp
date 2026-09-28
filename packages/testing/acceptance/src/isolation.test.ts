// SPDX-License-Identifier: LGPL-3.0-only
//
// Cross-tenant isolation (ARCHITECTURE.md §9.3 "tests automatisés d'isolation croisée"): two
// tenants behind the same server, one database each. Nothing crosses the boundary, whatever
// the way in: session, RPC, synchronisation, record id.
import { exportPublicKey, generateSigningKeyPair, uuidv7 } from '@socle/crypto';
import { signMutation } from '@socle/sync';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { installTenant, testServer, type InstalledTenant } from './harness.js';

let acme: InstalledTenant;
let globex: InstalledTenant;
let server: ReturnType<typeof testServer>;

beforeAll(async () => {
  const pgUrl = inject('pgUrl');
  acme = await installTenant(pgUrl, { login: 'alice@acme.test', password: 'alice-pass' });
  globex = await installTenant(pgUrl, { login: 'gina@globex.test', password: 'gina-pass' });
  server = testServer({ acme, globex });
});
afterAll(async () => {
  await server.close();
  await acme.db.destroy();
  await globex.db.destroy();
});

const secretName = 'Acme secret supplier';

describe('cross-tenant isolation', () => {
  it('keeps each tenant in its own database', async () => {
    const name = async (db: InstalledTenant['db']) =>
      (await sql<{ name: string }>`select current_database() as name`.execute(db)).rows[0]?.name;
    expect(await name(acme.db)).not.toBe(await name(globex.db));
  });

  it('never lets a session, a record or a device of one tenant reach the other', async () => {
    const alice = await server.signIn('acme', 'alice@acme.test', 'alice-pass');
    const gina = await server.signIn('globex', 'gina@globex.test', 'gina-pass');

    // A user of one tenant does not exist in the other.
    const wrongTenant = await server.inject('globex', 'POST', '/auth/login', undefined, {
      login: 'alice@acme.test',
      password: 'alice-pass',
    });
    expect(wrongTenant.statusCode).toBe(401);

    // A session of acme is unknown to globex.
    const created = await server.inject('acme', 'POST', '/rpc/acc.partner/create', alice, {
      values: { name: secretName },
    });
    expect(created.statusCode, created.body).toBe(200);
    const [id] = created.json<{ ids: string[] }>().ids;
    const stolenSession = await server.inject(
      'globex',
      'POST',
      '/rpc/acc.partner/search',
      alice,
      {},
    );
    expect(stolenSession.statusCode).toBe(401);

    // Globex's own user sees nothing of acme, by search, by id or by synchronisation.
    const search = await server.inject('globex', 'POST', '/rpc/acc.partner/searchRead', gina, {
      fields: ['name'],
    });
    expect(search.statusCode).toBe(200);
    expect(search.body).not.toContain(secretName);
    const byId = await server.inject('globex', 'POST', '/rpc/acc.partner/read', gina, {
      ids: [id],
      fields: ['name'],
    });
    expect(byId.body).not.toContain(secretName);
    expect([200, 404]).toContain(byId.statusCode);
    if (byId.statusCode === 200) expect(byId.json()).toEqual({ records: [] });
    const pull = await server.inject('globex', 'GET', '/sync/pull?cursor=0', gina);
    expect(pull.statusCode).toBe(200);
    expect(pull.body).not.toContain(secretName);
    expect(pull.body).not.toContain(String(id));

    // Globex cannot change acme's record through its id either.
    const write = await server.inject('globex', 'POST', '/rpc/acc.partner/write', gina, {
      ids: [id],
      values: { name: 'overwritten' },
    });
    expect(write.statusCode).not.toBe(200);
    const still = await sql<{
      name: string;
    }>`select name from acc_partner where id = ${String(id)}::uuid`.execute(acme.db);
    expect(still.rows).toEqual([{ name: secretName }]);

    // A device registered on acme is unknown to globex: its mutations are refused there.
    const keys = await generateSigningKeyPair();
    const deviceId = `tablet-${uuidv7().slice(-12)}`;
    const registered = await server.inject('acme', 'POST', '/sync/devices', alice, {
      id: deviceId,
      publicKey: await exportPublicKey(keys.publicKey),
    });
    expect(registered.statusCode).toBe(200);
    const mutation = await signMutation(keys.privateKey, {
      mutationId: uuidv7(),
      deviceId,
      model: 'acc.partner',
      op: 'create',
      recordId: uuidv7(),
      changes: { name: 'smuggled' },
      clientTs: new Date().toISOString(),
    });
    const push = await server.inject('globex', 'POST', '/sync/push', gina, {
      deviceId,
      mutations: [mutation],
    });
    expect(push.statusCode).toBe(200);
    expect(push.json()).toMatchObject({ results: [{ status: 'rejected' }] });
    const smuggled = await sql<{
      count: number;
    }>`select count(*)::int as count from acc_partner where name = 'smuggled'`.execute(globex.db);
    expect(smuggled.rows).toEqual([{ count: 0 }]);
  });

  it('refuses an unknown or malformed tenant', async () => {
    for (const host of ['initech', 'www', 'ac--me']) {
      const response = await server.inject(host, 'POST', '/auth/login', undefined, {
        login: 'alice@acme.test',
        password: 'alice-pass',
      });
      expect(response.statusCode, host).toBe(404);
    }
  });
});
