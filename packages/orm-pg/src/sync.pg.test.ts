// SPDX-License-Identifier: LGPL-3.0-only
//
// Synchronisation end to end on PostgreSQL: devices push signed mutations, the server replays
// them through the ORM and decides conflicts, devices pull what they may see.
import {
  exportPublicKey,
  generateSigningKeyPair,
  uuidv7,
  type SigningKeyPair,
} from '@socle/crypto';
import {
  buildModelRegistry,
  buildSecurityPolicy,
  createAccessControl,
  createEnvironment,
  defineModel,
  f,
  type UserContext,
} from '@socle/framework';
import {
  pullChanges as pullAll,
  pushMutations as pushAll,
  rightsFingerprint,
  signMutation,
  type Mutation,
  type RunInTransaction,
  type UnsignedMutation,
} from '@socle/sync';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { applySchema } from './apply.js';
import type { Executor } from './database.js';
import { createPgSession } from './session.js';
import { createPgStorage } from './storage.js';
import { createPgSyncBackend, deviceStatus, registerDevice, revokeDevice } from './sync-backend.js';
import { useTestDatabases } from './test-support.js';

const C1 = '0190a000-0000-7000-8000-0000000000c1';
const C2 = '0190a000-0000-7000-8000-0000000000c2';

// These models have no field restricted to groups: every field is visible here (field-level
// visibility is tested through the HTTP server).
const everyField = { canSeeField: () => true };
const pushMutations = (options: Omit<Parameters<typeof pushAll>[0], 'canSeeField'>) =>
  pushAll({ ...options, ...everyField });
const pullChanges = (options: Omit<Parameters<typeof pullAll>[0], 'canSeeField'>) =>
  pullAll({ ...options, ...everyField });

const note = defineModel({
  name: 'syn.note',
  fields: {
    title: f.char(),
    body: f.text(),
    companyId: f.char(),
    secret: f.char({ offline: false }),
    size: f.integer({ compute: 'computeSize', store: true, depends: ['body'] }),
  },
  methods: (Base) =>
    class extends Base {
      computeSize(): void {
        for (const n of this) n.size = (n.body ?? '').length;
      }
    },
  serverMethods: (Base) =>
    class extends Base {
      async archiveNote(): Promise<void> {
        await this.prefetch(['title']);
        for (const n of this) n.title = `[archived] ${n.title ?? ''}`;
      }
    },
});
const ledger = defineModel({
  name: 'syn.ledger',
  fields: { label: f.char(), amount: f.monetary() },
  offline: { conflict: 'append-only' },
});
const registry = buildModelRegistry([{ module: 'syn', models: [note, ledger] }], {
  side: 'server',
});
const policy = buildSecurityPolicy(
  [
    {
      module: 'syn',
      access: [
        { model: 'syn.note', group: null, read: true, create: true, write: true, unlink: true },
        { model: 'syn.ledger', group: null, read: true, create: true, write: true },
      ],
      rules: [
        {
          id: 'syn.note_company',
          model: 'syn.note',
          domain: [['companyId', 'in', { $user: 'companyIds' }]],
        },
      ],
    },
  ],
  (model) => registry.has(model),
);
const access = createAccessControl(policy, registry);

const user = (companyIds: string[]): UserContext => ({
  id: 'alice',
  groupIds: [],
  companyIds,
  companyId: companyIds[0] ?? null,
  lang: 'fr',
  tz: 'UTC',
});

/** The server's transaction runner for a user (as the HTTP layer will do). */
const runner =
  (db: Executor, u: UserContext): RunInTransaction =>
  (work) =>
    db.transaction().execute(async (trx) => {
      const session = createPgSession(trx);
      const env = createEnvironment({
        registry,
        storage: createPgStorage(trx, registry, session),
        user: u,
        access,
        audit: { record: () => undefined },
      });
      const result = await work({ env, backend: createPgSyncBackend(session, registry) });
      await env.flush();
      return result;
    });

interface Device {
  readonly id: string;
  readonly keys: SigningKeyPair;
  mutation(
    change: Omit<UnsignedMutation, 'mutationId' | 'deviceId' | 'clientTs'>,
  ): Promise<Mutation>;
}

async function device(db: Executor, id: string, userId = 'alice'): Promise<Device> {
  const keys = await generateSigningKeyPair();
  await registerDevice(db, { id, userId, publicKey: await exportPublicKey(keys.publicKey) });
  return {
    id,
    keys,
    mutation: (change) =>
      signMutation(keys.privateKey, {
        ...change,
        mutationId: uuidv7(),
        deviceId: id,
        clientTs: new Date().toISOString(),
      }),
  };
}

const databases = useTestDatabases();

async function setup() {
  const db = await databases.create();
  await applySchema(db, registry, { security: policy });
  return {
    db,
    run: runner(db, user([C1])),
    phone: await device(db, 'phone-0001'),
    laptop: await device(db, 'laptop-0001'),
  };
}

describe('synchronisation on PostgreSQL', () => {
  it('merges changes of different fields and archives the loser of a concurrent change', async () => {
    const { db, run, phone, laptop } = await setup();
    const id = uuidv7();
    const push = (d: Device, mutation: Mutation) =>
      pushMutations({ run, userId: 'alice', deviceId: d.id, mutations: [mutation] });

    expect(
      await push(
        phone,
        await phone.mutation({
          model: 'syn.note',
          op: 'create',
          recordId: id,
          changes: { title: 'T0', body: 'B0', companyId: C1 },
        }),
      ),
    ).toMatchObject([{ status: 'applied' }]);
    const rights = await rightsFingerprint(user([C1]));
    const first = await pullChanges({ run, cursor: 0, limit: 100, rights, deviceRights: null });
    const pulled = first.records.find((r) => r.id === id);
    expect(pulled?.values).toMatchObject({ title: 'T0', body: 'B0', size: 2 });
    expect(pulled?.values).not.toHaveProperty('secret');
    const base = pulled?.fieldVersions ?? {};

    // Different fields, same base: no conflict.
    expect(
      await push(
        phone,
        await phone.mutation({
          model: 'syn.note',
          op: 'write',
          recordId: id,
          changes: { title: 'T-phone' },
          baseVersions: { title: base.title ?? 0 },
        }),
      ),
    ).toMatchObject([{ status: 'applied', conflict: false }]);
    expect(
      await push(
        laptop,
        await laptop.mutation({
          model: 'syn.note',
          op: 'write',
          recordId: id,
          changes: { body: 'B-laptop' },
          baseVersions: { body: base.body ?? 0 },
        }),
      ),
    ).toMatchObject([{ status: 'applied', conflict: false }]);
    // Same field, stale base: last writer wins, the overwritten value is archived.
    expect(
      await push(
        laptop,
        await laptop.mutation({
          model: 'syn.note',
          op: 'write',
          recordId: id,
          changes: { title: 'T-laptop' },
          baseVersions: { title: base.title ?? 0 },
        }),
      ),
    ).toMatchObject([{ status: 'merged', conflict: true }]);

    const next = await pullChanges({
      run,
      cursor: first.cursor,
      limit: 100,
      rights,
      deviceRights: rights,
    });
    expect(next.records.find((r) => r.id === id)?.values).toMatchObject({
      title: 'T-laptop',
      body: 'B-laptop',
      size: 8,
    });
    const archived = await sql<{
      side: string;
      values: unknown;
    }>`select side, "values" from socle_archive order by id`.execute(db);
    expect(archived.rows).toEqual([{ side: 'remote', values: { title: 'T-phone' } }]);
  });

  it('applies a mutation once, and refuses forged, foreign and revoked devices', async () => {
    const { db, run, phone, laptop } = await setup();
    const create = await phone.mutation({
      model: 'syn.note',
      op: 'create',
      recordId: uuidv7(),
      changes: { title: 'once', companyId: C1 },
    });
    const results = await pushMutations({
      run,
      userId: 'alice',
      deviceId: phone.id,
      mutations: [create, create],
    });
    expect(results.map((r) => r.status)).toEqual(['applied', 'duplicate']);
    expect((await sql`select count(*)::int as n from syn_note`.execute(db)).rows).toEqual([
      { n: 1 },
    ]);

    const forged = {
      ...(await phone.mutation({
        model: 'syn.note',
        op: 'create',
        recordId: uuidv7(),
        changes: { title: 'x', companyId: C1 },
      })),
      changes: { title: 'forged', companyId: C1 },
    };
    expect(
      await pushMutations({ run, userId: 'alice', deviceId: phone.id, mutations: [forged] }),
    ).toMatchObject([{ status: 'rejected', reason: 'Invalid device signature.' }]);
    // A device of another user.
    const mallory = await device(db, 'mallory-001', 'mallory');
    const theirs = await mallory.mutation({
      model: 'syn.note',
      op: 'create',
      recordId: uuidv7(),
      changes: { title: 'x', companyId: C1 },
    });
    expect(
      await pushMutations({ run, userId: 'alice', deviceId: mallory.id, mutations: [theirs] }),
    ).toMatchObject([{ status: 'rejected' }]);
    // Revoked device: refused, and told to wipe.
    await revokeDevice(db, laptop.id);
    const late = await laptop.mutation({
      model: 'syn.note',
      op: 'create',
      recordId: uuidv7(),
      changes: { title: 'late', companyId: C1 },
    });
    expect(
      await pushMutations({ run, userId: 'alice', deviceId: laptop.id, mutations: [late] }),
    ).toMatchObject([{ status: 'rejected' }]);
    expect(await deviceStatus(db, laptop.id)).toBe('revoked');
    expect(await deviceStatus(db, 'never-seen')).toBe('unknown');
    // Malformed input never reaches the ORM.
    expect(
      await pushMutations({
        run,
        userId: 'alice',
        deviceId: phone.id,
        mutations: [{ mutationId: 'x', op: 'drop' }],
      }),
    ).toMatchObject([{ status: 'rejected', reason: 'malformed mutation' }]);
  });

  it('enforces the model policies, writable fields and server methods', async () => {
    const { run, phone } = await setup();
    const push = async (m: Omit<UnsignedMutation, 'mutationId' | 'deviceId' | 'clientTs'>) =>
      (
        await pushMutations({
          run,
          userId: 'alice',
          deviceId: phone.id,
          mutations: [await phone.mutation(m)],
        })
      )[0];
    const entry = uuidv7();
    expect(
      await push({
        model: 'syn.ledger',
        op: 'create',
        recordId: entry,
        changes: { label: 'sale', amount: 100 },
      }),
    ).toMatchObject({ status: 'applied' });
    expect(
      await push({
        model: 'syn.ledger',
        op: 'write',
        recordId: entry,
        changes: { amount: 1 },
        baseVersions: { amount: 0 },
      }),
    ).toMatchObject({ status: 'rejected' });

    const id = uuidv7();
    await push({
      model: 'syn.note',
      op: 'create',
      recordId: id,
      changes: { title: 'n', companyId: C1 },
    });
    expect(
      await push({
        model: 'syn.note',
        op: 'write',
        recordId: id,
        changes: { secret: 'x' },
        baseVersions: {},
      }),
    ).toMatchObject({ status: 'rejected' });
    expect(
      await push({
        model: 'syn.note',
        op: 'write',
        recordId: id,
        changes: { size: 99 },
        baseVersions: {},
      }),
    ).toMatchObject({ status: 'rejected' });
    // Writing into a company the user does not belong to: refused by the record rules.
    expect(
      await push({
        model: 'syn.note',
        op: 'create',
        recordId: uuidv7(),
        changes: { title: 'x', companyId: C2 },
      }),
    ).toMatchObject({ status: 'rejected' });

    expect(
      await push({ model: 'syn.note', op: 'call', recordId: id, method: 'archiveNote', args: [] }),
    ).toMatchObject({ status: 'applied' });
    expect(
      await push({ model: 'syn.note', op: 'call', recordId: id, method: 'computeSize', args: [] }),
    ).toMatchObject({ status: 'rejected' });
    const pulled = await pullChanges({
      run,
      cursor: 0,
      limit: 100,
      rights: 'r',
      deviceRights: null,
    });
    expect(pulled.records.find((r) => r.id === id)?.values.title).toBe('[archived] n');
  });

  it("propagates deletions, keeps them final and evicts records that leave the user's scope", async () => {
    const { db, run, phone, laptop } = await setup();
    const push = async (
      d: Device,
      m: Omit<UnsignedMutation, 'mutationId' | 'deviceId' | 'clientTs'>,
    ) =>
      (
        await pushMutations({
          run,
          userId: 'alice',
          deviceId: d.id,
          mutations: [await d.mutation(m)],
        })
      )[0];
    const gone = uuidv7();
    const moved = uuidv7();
    await push(phone, {
      model: 'syn.note',
      op: 'create',
      recordId: gone,
      changes: { title: 'gone', companyId: C1 },
    });
    await push(phone, {
      model: 'syn.note',
      op: 'create',
      recordId: moved,
      changes: { title: 'moved', companyId: C1 },
    });
    const rights = await rightsFingerprint(user([C1]));
    const start = await pullChanges({ run, cursor: 0, limit: 100, rights, deviceRights: null });
    const known = start.records.find((r) => r.id === gone)?.fieldVersions ?? {};

    // The device deletes the version it knew: no concurrent change, nothing to archive.
    expect(
      await push(phone, { model: 'syn.note', op: 'unlink', recordId: gone, baseVersions: known }),
    ).toMatchObject({ status: 'applied', conflict: false });
    expect(
      await push(laptop, {
        model: 'syn.note',
        op: 'write',
        recordId: gone,
        changes: { title: 'too late' },
        baseVersions: {},
      }),
    ).toMatchObject({ status: 'rejected', conflict: true });
    // An administrator moves a record to another company (outside the user's scope).
    await runner(
      db,
      user([C1, C2]),
    )(async ({ env }) => {
      await env.model('syn.note').browse([moved]).write({ companyId: C2 });
    });

    const next = await pullChanges({
      run,
      cursor: start.cursor,
      limit: 100,
      rights,
      deviceRights: rights,
    });
    expect(next.deletions).toEqual([{ model: 'syn.note', id: gone }]);
    expect(next.evictions).toEqual([{ model: 'syn.note', id: moved }]);
    expect(next.records).toEqual([]);
    // Rights changed (new company): the device must reset and pull from zero.
    const wider = await rightsFingerprint(user([C1, C2]));
    expect(
      await pullChanges({
        run,
        cursor: next.cursor,
        limit: 100,
        rights: wider,
        deviceRights: rights,
      }),
    ).toMatchObject({ reset: true, cursor: 0 });
  });

  it('pages changes in version order', async () => {
    const { run, phone } = await setup();
    const mutations = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        phone.mutation({
          model: 'syn.note',
          op: 'create',
          recordId: uuidv7(),
          changes: { title: `n${String(n)}`, companyId: C1 },
        }),
      ),
    );
    await pushMutations({ run, userId: 'alice', deviceId: phone.id, mutations });
    const titles: string[] = [];
    let cursor = 0;
    for (;;) {
      const page = await pullChanges({ run, cursor, limit: 2, rights: 'r', deviceRights: null });
      titles.push(...page.records.map((r) => r.values.title as string));
      cursor = page.cursor;
      if (!page.more) break;
    }
    expect(titles).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
  });
});
