// SPDX-License-Identifier: LGPL-3.0-only
//
// The device engine against a scripted server: every path of push, pull and rebuild.
import { generateSigningKeyPair, type JsonValue } from '@socle/crypto';
import {
  buildModelRegistry,
  createMemoryStorage,
  defineModel,
  f,
  type ModelMeta,
} from '@socle/framework';
import { describe, expect, it } from 'vitest';

import {
  memoryDeviceStateStore,
  openDevice,
  recordKey,
  type Device,
  type SyncTransport,
} from './device.js';
import {
  verifyMutation,
  type Mutation,
  type PulledRecord,
  type PullResponse,
  type PushResult,
} from './protocol.js';

const id = (n: number): string => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const registry = buildModelRegistry(
  [
    {
      module: 't',
      models: [
        defineModel({
          name: 't.item',
          fields: { name: f.char(), qty: f.integer(), total: f.integer({ readonly: true }) },
        }),
      ],
    },
  ],
  { side: 'client' },
);
const item: ModelMeta = registry.get('t.item');

const EMPTY_PULL: PullResponse = {
  cursor: 0,
  records: [],
  deletions: [],
  evictions: [],
  reset: false,
  more: false,
};

const pulled = (n: number, values: Record<string, JsonValue>, versions: Record<string, number>) =>
  ({
    model: 't.item',
    id: id(n),
    version: Math.max(0, ...Object.values(versions)),
    values,
    fieldVersions: versions,
  }) satisfies PulledRecord;

/** A server scripted by the test: answers are computed from what was pushed. */
function scriptedServer(
  answer: (mutation: Mutation) => Omit<PushResult, 'mutationId'> | undefined,
): SyncTransport & { pushes: Mutation[][]; pulls: PullResponse[] } {
  const server = {
    pushes: [] as Mutation[][],
    pulls: [] as PullResponse[],
    push(_deviceId: string, mutations: readonly Mutation[]) {
      server.pushes.push([...mutations]);
      return Promise.resolve(
        mutations.flatMap((m) => {
          const result = answer(m);
          return result ? [{ mutationId: m.mutationId, ...result }] : [];
        }),
      );
    },
    pull() {
      return Promise.resolve({ response: server.pulls.shift() ?? EMPTY_PULL, rights: 'r1' });
    },
  };
  return server;
}

const applied = (fieldVersions?: Record<string, number>) => ({
  status: 'applied' as const,
  conflict: false,
  reason: 'ok',
  ...(fieldVersions ? { fieldVersions } : {}),
});

async function setup(transport: SyncTransport) {
  const keys = await generateSigningKeyPair();
  const storage = createMemoryStorage(registry);
  const device: Device = await openDevice({
    deviceId: 'device-0001',
    key: keys.privateKey,
    storage,
    registry,
    store: memoryDeviceStateStore(),
    transport,
    now: () => '2026-09-28T10:00:00.000Z',
  });
  const local = async (n: number) =>
    (await storage.read(item, [id(n)], ['name', 'qty'])).get(id(n));
  return { keys, storage, device, local };
}

describe('device engine', () => {
  it('captures local writes as signed mutations, except fields a device may not send', async () => {
    const server = scriptedServer(() => undefined);
    const { keys, device } = await setup(server);
    await device.storage.insert(item, [{ id: id(1), values: { name: 'A', qty: 1, total: 9 } }]);
    await device.storage.update(item, id(1), { qty: 2 });
    await device.storage.update(item, id(1), { total: 3 });
    await device.storage.delete(item, [id(1)]);

    const pending = device.state().outbox.pending;
    expect(pending.map((m) => [m.op, m.changes, m.baseVersions])).toEqual([
      ['create', { name: 'A', qty: 1 }, undefined],
      ['write', { qty: 2 }, { qty: 0 }],
      ['unlink', undefined, {}],
    ]);
    for (const mutation of pending)
      expect(await verifyMutation(keys.publicKey, mutation)).toBe(true);
  });

  it('pushes one change per record per round and rebases the next ones on the new versions', async () => {
    let version = 10;
    const server = scriptedServer((m) => {
      version += 1;
      return applied(m.op === 'unlink' ? undefined : { name: version, qty: version });
    });
    const { keys, device } = await setup(server);
    await device.storage.insert(item, [
      { id: id(1), values: { name: 'A', qty: 1 } },
      { id: id(2), values: { name: 'B', qty: 1 } },
    ]);
    await device.storage.update(item, id(1), { qty: 2 });
    await device.storage.update(item, id(1), { qty: 3 });
    await device.storage.delete(item, [id(2)]);

    const report = await device.sync();
    expect(report).toMatchObject({ pushed: 5, rejected: [], retryLater: false });
    // A batch is a strict prefix of the outbox that stops before a second change of a record.
    expect(
      server.pushes.map((batch) => batch.map((m) => `${m.op}:${m.recordId.slice(-1)}`)),
    ).toEqual([['create:1', 'create:2'], ['write:1'], ['write:1', 'unlink:2']]);
    const [round2, round3] = [server.pushes[1] ?? [], server.pushes[2] ?? []];
    // Based on the versions the server returned for the device's own earlier change.
    expect(round2[0]?.baseVersions).toEqual({ qty: 11 });
    expect(round3[0]?.baseVersions).toEqual({ qty: 13 });
    expect(round3[1]?.baseVersions).toEqual({ name: 12, qty: 12 });
    for (const mutation of [...round2, ...round3])
      expect(await verifyMutation(keys.publicKey, mutation)).toBe(true);
  });

  it('rebuilds a refused change from the last known server state', async () => {
    const server = scriptedServer((m) =>
      m.op === 'write' || m.recordId === id(2)
        ? { status: 'rejected', conflict: true, reason: 'server wins' }
        : applied({ name: 1, qty: 1 }),
    );
    const { device, local } = await setup(server);
    server.pulls.push({
      ...EMPTY_PULL,
      cursor: 1,
      records: [pulled(1, { name: 'A', qty: 1 }, { name: 1, qty: 1 })],
    });
    await device.sync();
    expect(await local(1)).toEqual({ name: 'A', qty: 1 });

    await device.storage.update(item, id(1), { qty: 50 });
    await device.storage.insert(item, [{ id: id(2), values: { name: 'refused' } }]);
    expect(await local(1)).toMatchObject({ qty: 50 });
    const report = await device.sync();
    expect(report.rejected.map((r) => r.reason)).toEqual(['server wins', 'server wins']);
    // Nothing changed on the server (empty pull): the replica is rebuilt from its last state.
    expect(await local(1)).toEqual({ name: 'A', qty: 1 });
    expect(await local(2)).toBeUndefined();
    expect(device.state().outbox.rejected).toHaveLength(2);
  });

  it('stops pushing on a temporary error or an incomplete answer, keeping the order', async () => {
    const errors = scriptedServer(() => ({ status: 'error', conflict: false, reason: 'retry' }));
    const first = await setup(errors);
    await first.device.storage.insert(item, [{ id: id(1), values: { name: 'A' } }]);
    await first.device.storage.insert(item, [{ id: id(2), values: { name: 'B' } }]);
    errors.pulls.push({
      ...EMPTY_PULL,
      cursor: 5,
      records: [pulled(9, { name: 'X' }, { name: 5 })],
    });
    expect(await first.device.sync()).toMatchObject({ pushed: 0, retryLater: true, pulled: 1 });
    expect(errors.pushes).toHaveLength(1);
    expect(first.device.state().outbox.pending.map((m) => m.recordId)).toEqual([id(1), id(2)]);
    // The pull still ran: the local changes waiting stay as they are.
    expect(first.device.state().cursor).toBe(5);
    expect(await first.local(9)).toEqual({ name: 'X', qty: null });
    expect(await first.local(1)).toEqual({ name: 'A', qty: null });

    const silent = scriptedServer(() => undefined);
    const second = await setup(silent);
    await second.device.storage.insert(item, [{ id: id(1), values: { name: 'A' } }]);
    expect(await second.device.sync()).toMatchObject({ retryLater: true });
    expect(silent.pushes).toHaveLength(1);
    expect(second.device.state().outbox.pending).toHaveLength(1);
  });

  it('applies pulled records, deletions and evictions under the pending local changes', async () => {
    // The server cannot take the device's changes for now: they stay pending.
    const server = scriptedServer(() => ({ status: 'error', conflict: false, reason: 'busy' }));
    const { device, local } = await setup(server);
    server.pulls.push(
      {
        ...EMPTY_PULL,
        cursor: 2,
        more: true,
        records: [pulled(1, { name: 'A', qty: 1 }, { name: 1, qty: 1 })],
      },
      {
        ...EMPTY_PULL,
        cursor: 3,
        records: [
          pulled(2, { name: 'B', qty: 1 }, { name: 2, qty: 2 }),
          pulled(3, { name: 'C', qty: 1 }, { name: 3, qty: 3 }),
        ],
      },
    );
    await device.sync();
    expect([await local(1), await local(2), await local(3)]).toEqual([
      { name: 'A', qty: 1 },
      { name: 'B', qty: 1 },
      { name: 'C', qty: 1 },
    ]);
    expect(device.state()).toMatchObject({ cursor: 3, rights: 'r1' });

    // Offline edit of 1 (not answered by the server yet), while the server changes 1 and
    // deletes 2 and hides 3.
    await device.storage.update(item, id(1), { qty: 7 });
    server.pulls.push({
      ...EMPTY_PULL,
      cursor: 6,
      records: [pulled(1, { name: 'A2', qty: 4 }, { name: 4, qty: 4 })],
      deletions: [{ model: 't.item', id: id(2) }],
      evictions: [{ model: 't.item', id: id(3) }],
    });
    await device.sync();
    expect(await local(1)).toEqual({ name: 'A2', qty: 7 });
    expect(await local(2)).toBeUndefined();
    expect(await local(3)).toBeUndefined();
    expect(Object.keys(device.state().server)).toEqual([recordKey('t.item', id(1))]);
  });

  it('drops what the server no longer sends after a reset of the rights', async () => {
    const server = scriptedServer(() => undefined);
    const { device, local } = await setup(server);
    server.pulls.push({
      ...EMPTY_PULL,
      cursor: 2,
      records: [
        pulled(1, { name: 'A', qty: 1 }, { name: 1, qty: 1 }),
        pulled(2, { name: 'B', qty: 1 }, { name: 2, qty: 2 }),
      ],
    });
    await device.sync();
    server.pulls.push(
      { ...EMPTY_PULL, reset: true },
      {
        ...EMPTY_PULL,
        cursor: 9,
        records: [pulled(1, { name: 'A', qty: 1 }, { name: 1, qty: 1 })],
      },
    );
    expect(await device.sync()).toMatchObject({ reset: true, pulled: 1 });
    expect(await local(1)).toEqual({ name: 'A', qty: 1 });
    expect(await local(2)).toBeUndefined();
    expect(device.state().cursor).toBe(9);
  });
});
