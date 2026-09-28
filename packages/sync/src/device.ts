// SPDX-License-Identifier: LGPL-3.0-only
//
// The device side of the synchronisation (ARCHITECTURE.md Â§6.1, Â§6.3). The interface reads and
// writes the local replica only; this engine:
// - captures every local write as a signed mutation in the outbox (a Storage decorator, so the
//   ORM works unchanged on the device);
// - pushes the outbox, at most one mutation per record per round: the server answers with the
//   record's new field versions, on which the next pending changes of that record are rebased
//   (a device never conflicts with its own earlier edits);
// - pulls the server's changes and rebuilds each affected local record as "last known server
//   state + pending local changes" (rebase), so every replica converges to the server.
// Isomorphic: the replica is any Storage (SQLite on the device), the network and the
// persistence of the engine state are interfaces.
import { uuidv7, type JsonValue, type SigningPrivateKey } from '@socle/crypto';
import {
  isStoredColumn,
  type DomainNode,
  type ModelMeta,
  type ModelRegistry,
  type SearchOptions,
  type ServerCall,
  type Storage,
  type StoredValues,
} from '@socle/framework';

import { acknowledge, EMPTY_OUTBOX, type OutboxState, type RejectedMutation } from './outbox.js';
import {
  signMutation,
  type Mutation,
  type PulledRecord,
  type PullResponse,
  type PushResult,
  type UnsignedMutation,
} from './protocol.js';
import { rebase } from './replica.js';

/**
 * How the device reaches the server (HTTP in the client, direct calls in tests).
 * @public
 */
export interface SyncTransport {
  push(deviceId: string, mutations: readonly Mutation[]): Promise<readonly PushResult[]>;
  /** `rights`: the fingerprint returned by the previous pull (null the first time). */
  pull(
    cursor: number,
    rights: string | null,
  ): Promise<{ readonly response: PullResponse; readonly rights: string }>;
}

/**
 * Everything the engine must keep across restarts, next to the replica.
 * @public
 */
export interface DeviceState {
  readonly cursor: number;
  readonly rights: string | null;
  readonly outbox: OutboxState;
  /** Last known server state of each replicated record, by {@link recordKey}. */
  readonly server: Readonly<Record<string, PulledRecord>>;
}

/** @public */
export const EMPTY_DEVICE_STATE: DeviceState = Object.freeze({
  cursor: 0,
  rights: null,
  outbox: EMPTY_OUTBOX,
  server: {},
});

/**
 * Persistence of the engine state (a SQLite table on the device).
 * @public
 */
export interface DeviceStateStore {
  load(): Promise<DeviceState>;
  save(state: DeviceState): Promise<void>;
}

/**
 * A store kept in memory (tests, or a device that never restarts).
 * @public
 */
export function memoryDeviceStateStore(
  initial: DeviceState = EMPTY_DEVICE_STATE,
): DeviceStateStore {
  let current = initial;
  return {
    load: () => Promise.resolve(current),
    save(state) {
      current = state;
      return Promise.resolve();
    },
  };
}

/** @public */
export interface DeviceOptions {
  readonly deviceId: string;
  readonly key: SigningPrivateKey;
  /** The local replica. */
  readonly storage: Storage;
  /** The client-side registry the replica was built from. */
  readonly registry: ModelRegistry;
  readonly store: DeviceStateStore;
  readonly transport: SyncTransport;
  /** ISO 8601 UTC clock (informative only for the server). */
  readonly now?: (() => string) | undefined;
  /** Mutations per push request (default 100). */
  readonly batchSize?: number | undefined;
}

/** @public */
export interface SyncReport {
  /** Mutations the server accepted (applied, merged or already processed). */
  readonly pushed: number;
  /** Mutations the server refused during this synchronisation. */
  readonly rejected: readonly RejectedMutation[];
  /** Records received. */
  readonly pulled: number;
  /** The server asked for a full reload (the user's rights changed). */
  readonly reset: boolean;
  /** The push stopped on a temporary error: synchronise again later. */
  readonly retryLater: boolean;
}

/** @public */
export interface Device {
  /** The storage to give the ORM environment on the device. */
  readonly storage: Storage;
  /**
   * The `queueServerCall` of the ORM environment on the device: a server method called offline
   * is queued as an intent (one `call` mutation per record, replayed by the server in order).
   */
  queueServerCall(call: ServerCall): Promise<{ readonly queued: number }>;
  /** Pushes the outbox, then pulls until the server has nothing more. Not reentrant. */
  sync(): Promise<SyncReport>;
  state(): DeviceState;
}

/**
 * Key of a record in {@link DeviceState.server}.
 * @public
 */
export function recordKey(model: string, id: string): string {
  return `${model}\u0000${id}`;
}

const EVERYTHING: DomainNode = { kind: 'true' };

function toJson(value: unknown, where: string): JsonValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${where}: not a finite number.`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => toJson(item, where));
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toJson(v, where)]),
    );
  }
  throw new TypeError(`${where}: value cannot be synchronised.`);
}

const syncable = (meta: ModelMeta): boolean => !meta.abstract && meta.offline.syncable;

/** Fields a device may send: what the server accepts from a device (see server.ts). */
function sendable(meta: ModelMeta, field: string): boolean {
  const definition = meta.fields.get(field);
  return (
    definition !== undefined &&
    definition.offline !== false &&
    definition.sensitive !== true &&
    definition.compute === undefined &&
    definition.readonly !== true &&
    (definition.type === 'many2many' || isStoredColumn(definition))
  );
}

/** Fields the replica stores (what the local storage accepts). */
function storable(meta: ModelMeta, field: string): boolean {
  const definition = meta.fields.get(field);
  return (
    definition !== undefined && (definition.type === 'many2many' || isStoredColumn(definition))
  );
}

function changesOf(meta: ModelMeta, values: StoredValues): Record<string, JsonValue> {
  const changes: Record<string, JsonValue> = {};
  for (const [field, value] of Object.entries(values)) {
    if (sendable(meta, field)) changes[field] = toJson(value, `${meta.name}.${field}`);
  }
  return changes;
}

/**
 * After the server applied `done` (resulting versions `versions`), a later pending change of
 * the same record whose base is the one `done` started from was made on top of `done`: its base
 * becomes the version `done` produced.
 */
function rebaseVersions(
  pending: Mutation,
  done: Mutation,
  versions: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> | undefined {
  if (pending.baseVersions === undefined) return undefined;
  if (done.op === 'create') {
    // Every version of the record comes from this device's own creation.
    if (pending.op === 'unlink') return { ...versions };
    return Object.fromEntries(
      Object.entries(pending.baseVersions).map(([field, base]) => [
        field,
        base === 0 ? (versions[field] ?? 0) : base,
      ]),
    );
  }
  const touched = new Set(Object.keys(done.changes ?? {}));
  const result: Record<string, number> = { ...pending.baseVersions };
  for (const [field, base] of Object.entries(pending.baseVersions)) {
    const version = versions[field];
    if (touched.has(field) && version !== undefined && base === (done.baseVersions?.[field] ?? 0))
      result[field] = version;
  }
  return result;
}

/** The same mutation with other base versions, to be signed again. */
function withBase(m: Mutation, baseVersions: Readonly<Record<string, number>>): UnsignedMutation {
  return {
    mutationId: m.mutationId,
    deviceId: m.deviceId,
    model: m.model,
    op: m.op,
    recordId: m.recordId,
    changes: m.changes,
    baseVersions,
    method: m.method,
    args: m.args,
    clientTs: m.clientTs,
  };
}

/**
 * Opens the synchronisation engine of a device.
 * @public
 */
export async function openDevice(options: DeviceOptions): Promise<Device> {
  const inner = options.storage;
  const now = options.now ?? (() => new Date().toISOString());
  const batchSize = options.batchSize ?? 100;
  let state = await options.store.load();
  // Captured writes are signed asynchronously: they are chained to keep their order.
  let queue: Promise<void> = Promise.resolve();

  const save = async (next: DeviceState): Promise<void> => {
    state = next;
    await options.store.save(next);
  };

  const record = (mutation: Omit<UnsignedMutation, 'mutationId' | 'deviceId' | 'clientTs'>) => {
    const unsigned: UnsignedMutation = {
      ...mutation,
      mutationId: uuidv7(),
      deviceId: options.deviceId,
      clientTs: now(),
    };
    const step = queue.then(async () => {
      const signed = await signMutation(options.key, unsigned);
      await save({
        ...state,
        outbox: { ...state.outbox, pending: [...state.outbox.pending, signed] },
      });
    });
    queue = step.catch(() => undefined);
    return step;
  };

  const baseOf = (meta: ModelMeta, id: string, fields: readonly string[]) => {
    const known = state.server[recordKey(meta.name, id)]?.fieldVersions ?? {};
    return Object.fromEntries(fields.map((field) => [field, known[field] ?? 0]));
  };

  const capturing: Storage = {
    search: (meta: ModelMeta, where: DomainNode, opts: SearchOptions) =>
      inner.search(meta, where, opts),
    count: (meta: ModelMeta, where: DomainNode) => inner.count(meta, where),
    read: (meta, ids, fields) => inner.read(meta, ids, fields),
    async insert(meta, rows) {
      await inner.insert(meta, rows);
      if (!syncable(meta)) return;
      for (const row of rows) {
        await record({
          model: meta.name,
          op: 'create',
          recordId: row.id,
          changes: changesOf(meta, row.values),
        });
      }
    },
    async update(meta, id, values) {
      await inner.update(meta, id, values);
      if (!syncable(meta)) return;
      const changes = changesOf(meta, values);
      const fields = Object.keys(changes);
      if (fields.length === 0) return;
      await record({
        model: meta.name,
        op: 'write',
        recordId: id,
        changes,
        baseVersions: baseOf(meta, id, fields),
      });
    },
    async delete(meta, ids) {
      await inner.delete(meta, ids);
      if (!syncable(meta)) return;
      for (const id of ids) {
        const known = state.server[recordKey(meta.name, id)]?.fieldVersions ?? {};
        await record({ model: meta.name, op: 'unlink', recordId: id, baseVersions: { ...known } });
      }
    },
  };

  /** Rebuilds a local record from the last known server state and the pending changes. */
  const materialize = async (key: string): Promise<void> => {
    const [model = '', id = ''] = key.split('\u0000');
    if (!options.registry.has(model)) return;
    const meta = options.registry.get(model);
    const shadow = state.server[key];
    const pending = state.outbox.pending.filter((m) => m.model === model && m.recordId === id);
    const created = pending.some((m) => m.op === 'create');
    const target =
      shadow === undefined && !created
        ? null
        : rebase(shadow ?? { model, id, version: 0, values: {}, fieldVersions: {} }, pending);
    const exists = (await inner.read(meta, [id], [])).has(id);
    if (target === null) {
      if (exists) await inner.delete(meta, [id]);
      return;
    }
    const values = Object.fromEntries(
      Object.entries(target.values).filter(([field]) => storable(meta, field)),
    );
    if (exists) await inner.update(meta, id, values);
    else await inner.insert(meta, [{ id, values }]);
  };

  const push = async (
    affected: Set<string>,
  ): Promise<{ pushed: number; rejected: RejectedMutation[]; retryLater: boolean }> => {
    let pushed = 0;
    const rejected: RejectedMutation[] = [];
    for (;;) {
      // The oldest pending mutations, stopping before a second change of the same record.
      const batch: Mutation[] = [];
      const records = new Set<string>();
      for (const mutation of state.outbox.pending) {
        const key = recordKey(mutation.model, mutation.recordId);
        if (records.has(key) || batch.length >= batchSize) break;
        records.add(key);
        batch.push(mutation);
      }
      if (batch.length === 0) return { pushed, rejected, retryLater: false };

      const results = await options.transport.push(options.deviceId, batch);
      const byId = new Map(results.map((r) => [r.mutationId, r]));
      const before = state.outbox;
      let outbox = acknowledge(before, results);
      let server = { ...state.server };
      for (const mutation of batch) {
        const result = byId.get(mutation.mutationId);
        const key = recordKey(mutation.model, mutation.recordId);
        if (result === undefined || result.status === 'error') continue;
        affected.add(key);
        if (result.status === 'rejected') continue;
        pushed += 1;
        if (result.status === 'duplicate' || result.fieldVersions === undefined) continue;
        // Accepted: the server state now holds this change, at the versions it returned.
        const versions = result.fieldVersions;
        const previous = server[key];
        server = {
          ...server,
          [key]: {
            model: mutation.model,
            id: mutation.recordId,
            version: previous?.version ?? 0,
            values: { ...(previous?.values ?? {}), ...(mutation.changes ?? {}) },
            fieldVersions: { ...(previous?.fieldVersions ?? {}), ...versions },
          },
        };
        const rebased: Mutation[] = [];
        for (const next of outbox.pending) {
          const base =
            next.model === mutation.model && next.recordId === mutation.recordId
              ? rebaseVersions(next, mutation, versions)
              : undefined;
          if (base === undefined) {
            rebased.push(next);
            continue;
          }
          // Never sent yet (one mutation per record per round): it is signed again.
          rebased.push(await signMutation(options.key, withBase(next, base)));
        }
        outbox = { ...outbox, pending: rebased };
      }
      const newlyRejected = outbox.rejected.slice(before.rejected.length);
      rejected.push(...newlyRejected);
      await save({ ...state, outbox, server });
      if (outbox.failures > 0) return { pushed, rejected, retryLater: true };
      if (outbox.pending.length === before.pending.length) {
        // No answer for any mutation: never loop on an incomplete answer.
        return { pushed, rejected, retryLater: true };
      }
    }
  };

  const pull = async (affected: Set<string>): Promise<{ pulled: number; reset: boolean }> => {
    let pulled = 0;
    let reset = false;
    for (;;) {
      const { response, rights } = await options.transport.pull(state.cursor, state.rights);
      if (response.reset) {
        // The user's rights changed: the replica may hold records they can no longer read.
        reset = true;
        for (const name of options.registry.names()) {
          const meta = options.registry.get(name);
          if (!syncable(meta)) continue;
          const ids = await inner.search(meta, EVERYTHING, {});
          for (const id of ids) affected.add(recordKey(name, id));
        }
        await save({ ...state, cursor: 0, rights, server: {} });
        continue;
      }
      const server = { ...state.server };
      for (const received of response.records) {
        const key = recordKey(received.model, received.id);
        server[key] = received;
        affected.add(key);
        pulled += 1;
      }
      for (const gone of [...response.deletions, ...response.evictions]) {
        const key = recordKey(gone.model, gone.id);
        Reflect.deleteProperty(server, key);
        affected.add(key);
      }
      await save({ ...state, cursor: response.cursor, rights, server });
      if (!response.more) return { pulled, reset };
    }
  };

  return {
    storage: capturing,
    state: () => state,
    async queueServerCall(call) {
      const args = call.args.map((arg) => toJson(arg, `${call.model}.${call.method}`));
      for (const id of call.ids) {
        await record({ model: call.model, op: 'call', recordId: id, method: call.method, args });
      }
      return { queued: call.ids.length };
    },
    async sync() {
      await queue;
      const affected = new Set<string>();
      const pushed = await push(affected);
      // Pulling is safe even when some changes are still waiting: they are replayed on top.
      const pulled = await pull(affected);
      for (const key of affected) await materialize(key);
      return {
        pushed: pushed.pushed,
        rejected: pushed.rejected,
        pulled: pulled.pulled,
        reset: pulled.reset,
        retryLater: pushed.retryLater,
      };
    },
  };
}
