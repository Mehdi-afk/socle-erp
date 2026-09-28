// SPDX-License-Identifier: LGPL-3.0-only
//
// Phase 1 acceptance (ARCHITECTURE.md §13): "a test module extends another module; both work
// offline and converge". acc_ext extends acc.partner (a field, a view) and adds acc.note; two
// devices work offline on both modules' models, synchronise in any order, and end up with
// exactly what the server holds.
import { uuidv7 } from '@socle/crypto';
import { SYNC_TABLES } from '@socle/orm-pg';
import fc from 'fast-check';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createTenant, type Tenant, type TestDevice } from './harness.js';

let tenant: Tenant;
let ready = false;
beforeAll(async () => {
  tenant = await createTenant(inject('pgUrl'));
  ready = true;
});
afterAll(async () => {
  if (ready) await tenant.close();
});

async function expectConverged(...devices: TestDevice[]): Promise<void> {
  const server = await tenant.serverState();
  for (const device of devices) expect(await device.replica(), device.name).toEqual(server);
}

/** Everyone pushes, then everyone pulls what the others pushed. */
async function syncAll(...devices: TestDevice[]): Promise<void> {
  for (const device of devices) await device.engine.sync();
  for (const device of devices) await device.engine.sync();
}

async function conflicts(): Promise<number> {
  const result = await sql<{
    count: number;
  }>`select count(*)::int as count from ${sql.table(SYNC_TABLES.mutation)} where conflict`.execute(
    tenant.db,
  );
  return result.rows[0]?.count ?? -1;
}

describe('phase 1 acceptance', () => {
  it('installs a module that extends another one', () => {
    // Installed by `socle module install <tenant> acc_ext` (see harness): the extension field
    // and the new model exist on both sides.
    for (const registry of [tenant.serverRegistry, tenant.clientRegistry]) {
      expect(registry.field('acc.partner', 'vip')?.type).toBe('boolean');
      expect(registry.field('acc.note', 'partnerId')?.type).toBe('many2one');
    }
  });

  it('works offline on both modules and converges', async () => {
    const a = await tenant.device('tablet');
    const b = await tenant.device('laptop');

    // Offline: each device writes its local replica only.
    const alpha = await a
      .env()
      .model('acc.partner')
      .create({ name: 'Alpha', city: 'Alger', vip: true });
    const note = await a
      .env()
      .model('acc.note')
      .create({ partnerId: alpha.ids[0] as string, body: 'first visit' });
    const beta = await b.env().model('acc.partner').create({ name: 'Beta', score: 1 });
    expect(Object.keys(await b.replica())).toHaveLength(1);

    await syncAll(a, b);
    await expectConverged(a, b);
    expect(Object.keys(await b.replica())).toHaveLength(3);

    // Concurrent changes of different fields of the same record: both kept, no conflict.
    const before = await conflicts();
    await a.env().model('acc.partner').browse(alpha.ids).write({ city: 'Oran' });
    await b.env().model('acc.partner').browse(alpha.ids).write({ score: 5, vip: false });
    await syncAll(a, b);
    await expectConverged(a, b);
    expect((await a.replica())[`acc.partner:${alpha.ids[0] as string}`]).toMatchObject({
      city: 'Oran',
      score: 5,
      vip: false,
    });
    expect(await conflicts()).toBe(before);

    // The same field on both: the last writer wins everywhere, the other value is archived.
    await a.env().model('acc.partner').browse(beta.ids).write({ name: 'Beta A' });
    await b.env().model('acc.partner').browse(beta.ids).write({ name: 'Beta B' });
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();
    await expectConverged(a, b);
    expect((await a.replica())[`acc.partner:${beta.ids[0] as string}`]).toMatchObject({
      name: 'Beta B',
    });
    expect(await conflicts()).toBe(before + 1);

    // A device's successive offline edits of one record never conflict with each other.
    const env = a.env();
    const gamma = await env.model('acc.partner').create({ name: 'Gamma' });
    for (const score of [1, 2, 3])
      await env.model('acc.partner').browse(gamma.ids).write({ score });
    const temporary = await env.model('acc.partner').create({ name: 'Temporary' });
    await env.model('acc.partner').browse(temporary.ids).write({ city: 'Blida' });
    await env.model('acc.partner').browse(temporary.ids).unlink();
    const report = await a.engine.sync();
    expect(report.rejected).toEqual([]);
    expect(await conflicts()).toBe(before + 1);
    await syncAll(a, b);
    await expectConverged(a, b);

    // Deleted on one device while edited on the other: the deletion stands, the edit is
    // refused (and archived on the server), and the editing device drops the record.
    await a.env().model('acc.note').browse(note.ids).unlink();
    await b.env().model('acc.note').browse(note.ids).write({ body: 'edited meanwhile' });
    await a.engine.sync();
    const refused = await b.engine.sync();
    expect(refused.rejected).toHaveLength(1);
    await syncAll(a, b);
    await expectConverged(a, b);
    expect(Object.keys(await b.replica())).not.toContain(`acc.note:${note.ids[0] as string}`);

    // A new device receives everything, extension fields included.
    const c = await tenant.device('phone');
    await c.engine.sync();
    await expectConverged(a, b, c);
  });

  it('converges whatever the offline edits and the synchronisation order', async () => {
    type Op =
      | { kind: 'create'; device: number; name: string; vip: boolean }
      | {
          kind: 'write';
          device: number;
          pick: number;
          field: 'name' | 'city' | 'score' | 'vip';
          value: number;
        }
      | { kind: 'note'; device: number; pick: number }
      | { kind: 'unlink'; device: number; pick: number }
      | { kind: 'sync'; device: number };
    const device = fc.integer({ min: 0, max: 1 });
    const pick = fc.nat({ max: 1000 });
    const op: fc.Arbitrary<Op> = fc.oneof(
      fc.record({
        kind: fc.constant('create' as const),
        device,
        name: fc.string({ minLength: 1, maxLength: 8 }),
        vip: fc.boolean(),
      }),
      fc.record({
        kind: fc.constant('write' as const),
        device,
        pick,
        field: fc.constantFrom('name' as const, 'city' as const, 'score' as const, 'vip' as const),
        value: fc.integer({ min: 0, max: 99 }),
      }),
      fc.record({ kind: fc.constant('note' as const), device, pick }),
      fc.record({ kind: fc.constant('unlink' as const), device, pick }),
      fc.record({ kind: fc.constant('sync' as const), device }),
    );

    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 25 }), async (ops) => {
        const devices = [await tenant.device('p0'), await tenant.device('p1')];
        for (const step of ops) {
          const current = devices[step.device] as TestDevice;
          const env = current.env();
          const partners = (await env.model('acc.partner').search([])).ids;
          const target =
            partners.length > 0
              ? partners[('pick' in step ? step.pick : 0) % partners.length]
              : undefined;
          switch (step.kind) {
            case 'create':
              await env
                .model('acc.partner')
                .create({ id: uuidv7(), name: step.name, vip: step.vip });
              break;
            case 'write':
              if (target === undefined) break;
              await env
                .model('acc.partner')
                .browse([target])
                .write(
                  step.field === 'score'
                    ? { score: step.value }
                    : step.field === 'vip'
                      ? { vip: step.value % 2 === 0 }
                      : { [step.field]: `${step.field}-${String(step.value)}` },
                );
              break;
            case 'note':
              if (target !== undefined)
                await env
                  .model('acc.note')
                  .create({ partnerId: target, body: `n${String(step.pick)}` });
              break;
            case 'unlink':
              if (target === undefined) break;
              // Notes first: the server refuses to delete a partner still referenced.
              await env
                .model('acc.note')
                .search([['partnerId', '=', target]])
                .then((notes) => notes.unlink());
              await env.model('acc.partner').browse([target]).unlink();
              break;
            case 'sync':
              await current.engine.sync();
              break;
          }
        }
        await syncAll(...devices);
        await expectConverged(...devices);
      }),
      { numRuns: 25 },
    );
  });
});
