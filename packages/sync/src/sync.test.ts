// SPDX-License-Identifier: LGPL-3.0-only
import { generateSigningKeyPair, type JsonValue } from '@socle/crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { decideConflict, type LocalChange, type RemoteState } from './conflict.js';
import {
  deviceAction,
  offlineStatus,
  readReplica,
  ReplicaReadError,
  requireRead,
} from './guards.js';
import { acknowledge, EMPTY_OUTBOX, enqueue, nextBatch, retryDelayMs } from './outbox.js';
import {
  parseMutation,
  parsePullResponse,
  signMutation,
  verifyMutation,
  type Mutation,
  type PulledRecord,
  type UnsignedMutation,
} from './protocol.js';
import { rebase, type LocalRecord } from './replica.js';

const id = (n: number): string => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const unsigned = (overrides: Partial<UnsignedMutation> = {}): UnsignedMutation => ({
  mutationId: id(1),
  deviceId: 'device-0001',
  model: 'sale.order',
  op: 'write',
  recordId: id(2),
  changes: { note: 'hello', amount: 1200 },
  baseVersions: { note: 3, amount: 3 },
  clientTs: '2026-09-28T10:00:00.000Z',
  ...overrides,
});

describe('mutations', () => {
  it('are signed by the device and any change breaks the signature', async () => {
    const device = await generateSigningKeyPair();
    const other = await generateSigningKeyPair();
    const mutation = await signMutation(device.privateKey, unsigned());
    expect(await verifyMutation(device.publicKey, mutation)).toBe(true);
    expect(await verifyMutation(other.publicKey, mutation)).toBe(false);
    for (const tampered of [
      { ...mutation, changes: { note: 'hello', amount: 1 } },
      { ...mutation, recordId: id(3) },
      { ...mutation, baseVersions: { note: 9, amount: 3 } },
      { ...mutation, op: 'unlink' as const },
    ]) {
      expect(await verifyMutation(device.publicKey, tampered)).toBe(false);
    }
  });

  it('are validated before anything else', async () => {
    const device = await generateSigningKeyPair();
    const valid = await signMutation(device.privateKey, unsigned());
    expect(parseMutation(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
    const invalid: unknown[] = [
      { ...valid, extra: 1 },
      { ...valid, recordId: '42' },
      { ...valid, model: 'Sale Order' },
      { ...valid, changes: {} },
      { ...valid, changes: { __proto__x: 1 } },
      { ...valid, op: 'call' },
      { ...valid, method: 'actionConfirm' },
      { ...valid, clientTs: 'yesterday' },
      { ...valid, baseVersions: { note: -1 } },
      { ...valid, signature: 'x' },
    ];
    for (const value of invalid)
      expect(() => parseMutation(value), JSON.stringify(value)).toThrow();
    expect(() =>
      parsePullResponse({
        cursor: 1,
        records: [{ model: 'x', id: 'nope', version: 1, values: {}, fieldVersions: {} }],
        deletions: [],
        evictions: [],
        reset: false,
        more: false,
      }),
    ).toThrow();
  });
});

describe('decideConflict', () => {
  const remote = (
    fieldVersions: Record<string, number>,
    state: Partial<RemoteState> = {},
  ): RemoteState => ({
    exists: true,
    deleted: false,
    fieldVersions,
    ...state,
  });
  const write = (fields: string[], baseVersions: Record<string, number>): LocalChange => ({
    op: 'write',
    fields,
    baseVersions,
  });

  it('applies a change made on the current version', () => {
    expect(
      decideConflict('field-lww', write(['a'], { a: 2 }), remote({ a: 2, b: 5 })),
    ).toMatchObject({
      action: 'apply',
      archive: 'none',
      conflict: false,
    });
  });

  it('never conflicts when two devices change different fields', () => {
    // Device 2 changed b (b: 5 → 6); device 1 changed a on base a = 2.
    expect(
      decideConflict('field-lww', write(['a'], { a: 2 }), remote({ a: 2, b: 6 })).conflict,
    ).toBe(false);
  });

  it('resolves concurrent changes of the same field by policy, archiving the loser', () => {
    const concurrent = [write(['a', 'b'], { a: 1, b: 5 }), remote({ a: 2, b: 5 })] as const;
    expect(decideConflict('field-lww', ...concurrent)).toMatchObject({
      action: 'merge',
      archive: 'remote',
      conflictingFields: ['a'],
    });
    expect(decideConflict('server-wins', ...concurrent)).toMatchObject({
      action: 'reject',
      archive: 'local',
      conflict: true,
    });
    expect(decideConflict('manual', ...concurrent)).toMatchObject({
      action: 'reject',
      archive: 'local',
      conflict: true,
    });
  });

  it('keeps append-only records immutable and deletions final', () => {
    expect(decideConflict('append-only', write(['a'], { a: 1 }), remote({ a: 1 }))).toMatchObject({
      action: 'reject',
      conflict: false,
    });
    expect(
      decideConflict(
        'append-only',
        { op: 'create', fields: ['a'], baseVersions: {} },
        remote({}, { exists: false }),
      ),
    ).toMatchObject({ action: 'apply' });
    expect(
      decideConflict(
        'field-lww',
        write(['a'], { a: 1 }),
        remote({ a: 1 }, { exists: false, deleted: true }),
      ),
    ).toMatchObject({ action: 'reject', archive: 'local', conflict: true });
    expect(
      decideConflict(
        'field-lww',
        { op: 'unlink', fields: [], baseVersions: {} },
        remote({}, { exists: false, deleted: true }),
      ),
    ).toMatchObject({ action: 'apply', archive: 'none' });
    expect(
      decideConflict(
        'field-lww',
        { op: 'create', fields: ['a'], baseVersions: {} },
        remote({ a: 1 }),
      ),
    ).toMatchObject({ action: 'reject', archive: 'local' });
  });

  it('archives the server version when a deletion wins over a concurrent change', () => {
    expect(
      decideConflict(
        'field-lww',
        { op: 'unlink', fields: [], baseVersions: { a: 1, b: 1 } },
        remote({ a: 1, b: 2 }),
      ),
    ).toMatchObject({
      action: 'merge',
      archive: 'remote',
      conflictingFields: ['b'],
    });
  });

  const policies = fc.constantFrom(
    'field-lww' as const,
    'server-wins' as const,
    'append-only' as const,
    'manual' as const,
  );
  const versions = fc.dictionary(fc.constantFrom('a', 'b', 'c'), fc.nat(5));
  const localChange: fc.Arbitrary<LocalChange> = fc.record({
    op: fc.constantFrom('create' as const, 'write' as const, 'unlink' as const),
    fields: fc.subarray(['a', 'b', 'c']),
    baseVersions: versions,
  });
  const remoteState: fc.Arbitrary<RemoteState> = fc.record({
    exists: fc.boolean(),
    deleted: fc.boolean(),
    fieldVersions: versions,
  });

  it('never loses data silently: a conflict always archives one side', () => {
    fc.assert(
      fc.property(policies, localChange, remoteState, (policy, local, server) => {
        const result = decideConflict(policy, local, server);
        if (result.conflict) expect(result.archive).not.toBe('none');
        if (result.action === 'reject' && result.reason !== 'already deleted')
          expect(result.archive).toBe('local');
        if (result.action === 'merge') expect(result.archive).toBe('remote');
        // Pure: same inputs, same decision.
        expect(decideConflict(policy, local, server)).toEqual(result);
      }),
    );
  });
});

describe('outbox', () => {
  const m = (n: number) =>
    ({ ...unsigned({ mutationId: id(n) }), signature: 'x'.repeat(86) }) as Mutation;

  it('keeps order, drops what the server accepted and stops at the first temporary error', () => {
    let state = [1, 2, 3, 4].reduce((s, n) => enqueue(s, m(n)), EMPTY_OUTBOX);
    state = enqueue(state, m(1)); // idempotent
    expect(nextBatch(state, 3).map((x) => x.mutationId)).toEqual([id(1), id(2), id(3)]);
    state = acknowledge(state, [
      { mutationId: id(1), status: 'applied', conflict: false, reason: '' },
      { mutationId: id(2), status: 'rejected', conflict: true, reason: 'the server version wins' },
      { mutationId: id(3), status: 'error', conflict: false, reason: 'timeout' },
      { mutationId: id(4), status: 'applied', conflict: false, reason: '' },
    ]);
    expect(state.pending.map((x) => x.mutationId)).toEqual([id(3), id(4)]);
    expect(state.rejected).toMatchObject([{ reason: 'the server version wins', conflict: true }]);
    expect(state.failures).toBe(1);
    // A mutation without an answer is never taken for a success.
    expect(acknowledge(state, []).pending).toHaveLength(2);
  });

  it('backs off exponentially, with a cap', () => {
    expect(retryDelayMs(0)).toBe(0);
    expect(retryDelayMs(1, () => 1)).toBe(1000);
    expect(retryDelayMs(3, () => 0)).toBe(2000);
    expect(retryDelayMs(50, () => 1)).toBe(300_000);
  });
});

describe('guards', () => {
  it('never turns a failed local read into an empty result', async () => {
    const failed = await readReplica<string[]>(() => Promise.reject(new Error('disk')));
    expect(failed.ok).toBe(false);
    expect(() => requireRead(failed, 'orders')).toThrow(ReplicaReadError);
    expect(requireRead(await readReplica(() => Promise.resolve(['a'])), 'orders')).toEqual(['a']);
  });

  it('locks the local data past the maximum offline duration, and on doubtful clocks', () => {
    expect(offlineStatus('2026-09-21T10:00:00Z', '2026-09-28T09:59:59Z', 7).locked).toBe(false);
    expect(offlineStatus('2026-09-21T10:00:00Z', '2026-09-28T10:00:01Z', 7).locked).toBe(true);
    expect(offlineStatus('2026-09-29T10:00:00Z', '2026-09-28T10:00:00Z', 7).locked).toBe(true);
    expect(offlineStatus('garbage', '2026-09-28T10:00:00Z', 7).locked).toBe(true);
  });

  it('wipes a revoked or unknown device', () => {
    expect(deviceAction('active')).toBe('continue');
    expect(deviceAction('revoked')).toBe('wipe');
    expect(deviceAction('unknown')).toBe('wipe');
  });
});

// ─── convergence (§6.4: whatever the order, every replica converges, nothing is lost) ───────

interface ServerRecord {
  values: Record<string, JsonValue>;
  fieldVersions: Record<string, number>;
}

describe('convergence of replicas (field-lww)', () => {
  const FIELDS = ['a', 'b', 'c'];
  const RECORDS = [id(100), id(101)];

  type Event =
    | { kind: 'edit'; device: number; record: number; field: string; value: number }
    | { kind: 'push'; device: number }
    | { kind: 'pull'; device: number };

  const event: fc.Arbitrary<Event> = fc.oneof(
    fc.record({
      kind: fc.constant('edit' as const),
      device: fc.nat(2),
      record: fc.nat(1),
      field: fc.constantFrom(...FIELDS),
      value: fc.nat(1000),
    }),
    fc.record({ kind: fc.constant('push' as const), device: fc.nat(2) }),
    fc.record({ kind: fc.constant('pull' as const), device: fc.nat(2) }),
  );

  it('ends with identical replicas and every overwritten concurrent value archived', () => {
    fc.assert(
      fc.property(fc.array(event, { maxLength: 60 }), (events) => {
        let clock = 1;
        const server = new Map<string, ServerRecord>(
          RECORDS.map((r) => [
            r,
            { values: { a: 0, b: 0, c: 0 }, fieldVersions: { a: 1, b: 1, c: 1 } },
          ]),
        );
        const archive: { record: string; field: string; value: JsonValue }[] = [];
        // Server values overwritten by a mutation that had not seen them (concurrent changes).
        const concurrentOverwrites: { record: string; field: string; value: JsonValue }[] = [];
        const devices = [0, 1, 2].map(() => ({
          replica: new Map<string, LocalRecord>(),
          outbox: EMPTY_OUTBOX,
          seq: 0,
        }));

        const pulled = (record: string): PulledRecord => {
          const s = server.get(record) as ServerRecord;
          return {
            model: 'sale.order',
            id: record,
            version: 0,
            values: { ...s.values },
            fieldVersions: { ...s.fieldVersions },
          };
        };
        const pull = (d: (typeof devices)[number]): void => {
          for (const record of RECORDS) {
            const local = rebase(pulled(record), d.outbox.pending);
            if (local) d.replica.set(record, local);
          }
        };
        const push = (d: (typeof devices)[number]): void => {
          const results = d.outbox.pending.map((mutation) => {
            const s = server.get(mutation.recordId) as ServerRecord;
            const fields = Object.keys(mutation.changes ?? {});
            const decision = decideConflict(
              'field-lww',
              { op: 'write', fields, baseVersions: mutation.baseVersions ?? {} },
              { exists: true, deleted: false, fieldVersions: s.fieldVersions },
            );
            if (decision.archive === 'remote') {
              for (const field of decision.conflictingFields)
                archive.push({ record: mutation.recordId, field, value: s.values[field] ?? null });
            }
            if (decision.action !== 'reject') {
              clock++;
              for (const field of fields) {
                if ((s.fieldVersions[field] ?? 0) !== (mutation.baseVersions?.[field] ?? 0)) {
                  concurrentOverwrites.push({
                    record: mutation.recordId,
                    field,
                    value: s.values[field] ?? null,
                  });
                }
                s.values[field] = (mutation.changes ?? {})[field] ?? null;
                s.fieldVersions[field] = clock;
              }
            }
            return {
              mutationId: mutation.mutationId,
              status: decision.action === 'merge' ? ('merged' as const) : ('applied' as const),
              conflict: decision.conflict,
              reason: decision.reason,
            };
          });
          d.outbox = acknowledge(d.outbox, results);
        };

        devices.forEach(pull);
        for (const e of events) {
          const d = devices[e.device] as (typeof devices)[number];
          if (e.kind === 'pull') pull(d);
          else if (e.kind === 'push') push(d);
          else {
            const record = RECORDS[e.record] as string;
            const local = d.replica.get(record) as LocalRecord;
            const mutation = {
              ...unsigned({
                mutationId: id(10_000 + e.device * 1000 + d.seq++),
                recordId: record,
                changes: { [e.field]: e.value },
                baseVersions: { [e.field]: local.fieldVersions[e.field] ?? 0 },
              }),
              signature: 'x'.repeat(86),
            } as Mutation;
            d.outbox = enqueue(d.outbox, mutation);
            d.replica.set(record, { ...local, values: { ...local.values, [e.field]: e.value } });
          }
        }
        // Everyone reconnects: push everything, then pull.
        devices.forEach(push);
        devices.forEach(pull);

        for (const d of devices) {
          expect(d.outbox.pending).toEqual([]);
          for (const record of RECORDS)
            expect(d.replica.get(record)?.values).toEqual(server.get(record)?.values);
        }
        // Nothing lost silently: every server value overwritten by a concurrent change is archived.
        for (const overwritten of concurrentOverwrites) expect(archive).toContainEqual(overwritten);
      }),
      { numRuns: 300 },
    );
  });
});
