// SPDX-License-Identifier: LGPL-3.0-only
//
// The server side of the synchronisation (ARCHITECTURE.md §6.3, ADR 004), independent of the
// database: a SyncBackend (PostgreSQL in @socle/orm-pg) holds the bookkeeping, the ORM holds
// the data and the rules. The server never trusts a device: every mutation is validated,
// its signature checked, and replayed through the same ORM with the user's rights.
import { canonicalBytes, sha256, type JsonValue, type SigningPublicKey } from '@socle/crypto';
import {
  AccessError,
  DomainError,
  FieldValueError,
  isStoredColumn,
  MissingRecordError,
  ValidationError,
  type Environment,
  type FieldDefinition,
  type ModelMeta,
  type UserContext,
} from '@socle/framework';

import { decideConflict, type RemoteState } from './conflict.js';
import {
  parseMutation,
  verifyMutation,
  type Mutation,
  type PullResponse,
  type PushResult,
} from './protocol.js';

/** @public */
export interface DeviceInfo {
  readonly id: string;
  readonly userId: string;
  readonly publicKey: SigningPublicKey;
  readonly status: 'active' | 'revoked';
}

/**
 * A version of a record set aside by a conflict: the local change that lost, or the server
 * values a concurrent change overwrote (§6.4: the losing version is always archived).
 * @public
 */
export interface ArchiveEntry {
  readonly model: string;
  readonly recordId: string;
  readonly side: 'local' | 'remote';
  readonly mutationId: string;
  readonly deviceId: string;
  readonly userId: string;
  readonly reason: string;
  readonly values: Readonly<Record<string, JsonValue>>;
}

/**
 * The synchronisation bookkeeping of a database. Its queries bypass the record rules (they
 * see every row); the engine only exposes to the user what the ORM lets them read.
 * @public
 */
export interface SyncBackend {
  device(deviceId: string): Promise<DeviceInfo | undefined>;
  touchDevice(deviceId: string): Promise<void>;
  /** The result of a mutation already processed (idempotence), if any. */
  processed(mutationId: string): Promise<PushResult | undefined>;
  remember(mutation: Mutation, result: PushResult): Promise<void>;
  /** Current state of a record, whoever may see it. */
  remote(
    meta: ModelMeta,
    id: string,
  ): Promise<RemoteState & { readonly values: Readonly<Record<string, JsonValue>> }>;
  archive(entry: ArchiveEntry): Promise<void>;
  /** Changes (writes and deletions) after `cursor`, oldest first, across the given models. */
  changes(
    models: readonly ModelMeta[],
    cursor: number,
    limit: number,
  ): Promise<
    {
      readonly model: string;
      readonly id: string;
      readonly version: number;
      readonly deleted: boolean;
    }[]
  >;
  fieldVersions(
    meta: ModelMeta,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, Readonly<Record<string, number>>>>;
}

/** What one database transaction offers the engine: the user's ORM environment and the backend. */
export interface SyncContext {
  readonly env: Environment;
  readonly backend: SyncBackend;
}

/** Runs `work` in a new database transaction (committed if it returns, rolled back if it throws). */
export type RunInTransaction = <T>(work: (context: SyncContext) => Promise<T>) => Promise<T>;

/**
 * Fields a device may receive and change: stored business fields, never `offline: false` nor
 * `sensitive` ones (§6.5), plus many2many links.
 * @public
 */
export function syncableFields(meta: ModelMeta): string[] {
  return [...meta.fields]
    .filter(
      ([, definition]) =>
        definition.offline !== false &&
        definition.sensitive !== true &&
        // Stored values (computed ones included: read-only on the device) and many2many links.
        (definition.type === 'many2many' || isStoredColumn(definition)),
    )
    .map(([name]) => name);
}

/**
 * Fingerprint of what the user may see (groups and companies): when it changes, devices drop
 * their replica and pull again from zero (their rights may have shrunk).
 * @public
 */
export async function rightsFingerprint(user: UserContext): Promise<string> {
  return sha256(
    canonicalBytes({
      groups: [...user.groupIds].sort(),
      companies: [...user.companyIds].sort(),
    }),
  );
}

const writable = (definition: FieldDefinition | undefined): boolean =>
  definition !== undefined &&
  definition.offline !== false &&
  definition.sensitive !== true &&
  definition.compute === undefined &&
  definition.readonly !== true;

/** Errors that mean "refused", as opposed to a temporary failure to retry. */
const isRefusal = (error: unknown): boolean =>
  error instanceof AccessError ||
  error instanceof ValidationError ||
  error instanceof FieldValueError ||
  error instanceof DomainError ||
  error instanceof MissingRecordError;

const result = (
  mutationId: string,
  status: PushResult['status'],
  conflict: boolean,
  reason: string,
): PushResult => ({
  mutationId,
  status,
  conflict,
  reason,
});

/**
 * Replays the mutations a device pushed, in order, each in its own transaction (§6.3).
 * Returns one result per valid mutation; malformed ones are rejected without being applied.
 * @public
 */
export async function pushMutations(options: {
  readonly run: RunInTransaction;
  readonly userId: string;
  readonly deviceId: string;
  readonly mutations: readonly unknown[];
  /** Field-level visibility of the user (`groups` on fields): hidden fields cannot be written. */
  readonly canSeeField: (definition: FieldDefinition) => boolean;
}): Promise<PushResult[]> {
  const canSee = options.canSeeField;
  const results: PushResult[] = [];
  for (const raw of options.mutations) {
    let mutation: Mutation;
    try {
      mutation = parseMutation(raw);
    } catch {
      const mutationId =
        typeof raw === 'object' && raw !== null && 'mutationId' in raw
          ? String(raw.mutationId)
          : '';
      results.push(result(mutationId, 'rejected', false, 'malformed mutation'));
      continue;
    }
    try {
      results.push(
        await options.run((context) =>
          replay(context, options.userId, options.deviceId, mutation, canSee),
        ),
      );
    } catch (error) {
      // A refusal inside the transaction rolled it back; record it in a transaction of its own.
      if (!isRefusal(error)) {
        results.push(result(mutation.mutationId, 'error', false, 'temporary failure, retry later'));
        continue;
      }
      const reason = error instanceof Error ? error.message : 'refused';
      const refused = result(mutation.mutationId, 'rejected', false, reason);
      await options.run(async ({ backend }) => {
        await backend.archive({
          model: mutation.model,
          recordId: mutation.recordId,
          side: 'local',
          mutationId: mutation.mutationId,
          deviceId: mutation.deviceId,
          userId: options.userId,
          reason,
          values: { ...(mutation.changes ?? {}) },
        });
        await backend.remember(mutation, refused);
      });
      results.push(refused);
    }
  }
  return results;
}

async function replay(
  { env, backend }: SyncContext,
  userId: string,
  deviceId: string,
  mutation: Mutation,
  canSee: (definition: FieldDefinition) => boolean,
): Promise<PushResult> {
  const done = await backend.processed(mutation.mutationId);
  if (done) return { ...done, status: 'duplicate' };

  const device = await backend.device(deviceId);
  if (
    !device ||
    device.status !== 'active' ||
    device.userId !== userId ||
    mutation.deviceId !== deviceId
  ) {
    throw new AccessError('Unknown, revoked or foreign device.');
  }
  if (!(await verifyMutation(device.publicKey, mutation)))
    throw new AccessError('Invalid device signature.');
  await backend.touchDevice(deviceId);

  if (!env.registry.has(mutation.model))
    throw new ValidationError(`Unknown model "${mutation.model}".`);
  const meta = env.registry.get(mutation.model);
  if (meta.abstract || !meta.offline.syncable)
    throw new ValidationError(`"${meta.name}" is not synchronised.`);

  const records = env.model(meta.name).browse([mutation.recordId]);
  if (mutation.op === 'call') {
    if (!meta.serverMethodNames.includes(mutation.method ?? '')) {
      throw new ValidationError(
        `"${String(mutation.method)}" is not a server method of "${meta.name}".`,
      );
    }
    const method = (records as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[
      mutation.method as string
    ];
    await method?.apply(records, [...(mutation.args ?? [])]);
    const applied = result(mutation.mutationId, 'applied', false, 'server method run');
    await backend.remember(mutation, applied);
    return applied;
  }

  const changes = mutation.changes ?? {};
  for (const field of Object.keys(changes)) {
    const definition = meta.fields.get(field);
    if (!writable(definition) || !canSee(definition as FieldDefinition))
      throw new ValidationError(`"${meta.name}.${field}" cannot be changed from a device.`);
  }
  const remote = await backend.remote(meta, mutation.recordId);
  const decision = decideConflict(
    meta.offline.conflict,
    { op: mutation.op, fields: Object.keys(changes), baseVersions: mutation.baseVersions ?? {} },
    remote,
  );
  const archive = async (
    side: 'local' | 'remote',
    values: Readonly<Record<string, JsonValue>>,
  ): Promise<void> => {
    await backend.archive({
      model: meta.name,
      recordId: mutation.recordId,
      side,
      mutationId: mutation.mutationId,
      deviceId,
      userId,
      reason: decision.reason,
      values,
    });
  };

  if (decision.action === 'reject') {
    if (decision.archive === 'local') await archive('local', { ...changes });
    const rejected = result(mutation.mutationId, 'rejected', decision.conflict, decision.reason);
    await backend.remember(mutation, rejected);
    return rejected;
  }
  if (decision.archive === 'remote') {
    const fields =
      decision.conflictingFields.length > 0
        ? decision.conflictingFields
        : Object.keys(remote.values);
    await archive(
      'remote',
      Object.fromEntries(fields.map((field) => [field, remote.values[field] ?? null])),
    );
  }

  if (mutation.op === 'create')
    await env.model(meta.name).create({ ...changes, id: mutation.recordId });
  else if (mutation.op === 'write') await records.write({ ...changes });
  else if (remote.exists) await records.unlink();
  await env.flush();

  const applied = result(
    mutation.mutationId,
    decision.action === 'merge' ? 'merged' : 'applied',
    decision.conflict,
    decision.reason,
  );
  await backend.remember(mutation, applied);
  if (mutation.op === 'unlink') return applied;
  const versions = (await backend.fieldVersions(meta, [mutation.recordId])).get(mutation.recordId);
  return versions ? { ...applied, fieldVersions: { ...versions } } : applied;
}

/**
 * The changes a device receives (§6.3): records changed after the cursor that the user may
 * read (with the version of each field), deletions, and evictions of changed records the user
 * may no longer see. `rights` fingerprints the user's groups and companies: when it differs
 * from the device's, the device drops its replica and pulls again from zero.
 * @public
 */
export async function pullChanges(options: {
  readonly run: RunInTransaction;
  readonly cursor: number;
  readonly limit: number;
  readonly rights: string;
  readonly deviceRights: string | null;
  /** Field-level visibility of the user (`groups` on fields): hidden fields are never sent. */
  readonly canSeeField: (definition: FieldDefinition) => boolean;
}): Promise<PullResponse & { readonly rights: string }> {
  const canSee = options.canSeeField;
  if (options.deviceRights !== null && options.deviceRights !== options.rights) {
    return {
      cursor: 0,
      records: [],
      deletions: [],
      evictions: [],
      reset: true,
      more: false,
      rights: options.rights,
    };
  }
  return options.run(async ({ env, backend }) => {
    const models = env.registry
      .names()
      .map((name) => env.registry.get(name))
      .filter((meta) => !meta.abstract && meta.offline.syncable);
    const changes = await backend.changes(models, options.cursor, options.limit + 1);
    const more = changes.length > options.limit;
    const window = changes.slice(0, options.limit);
    const cursor =
      window.length > 0 ? (window[window.length - 1]?.version ?? options.cursor) : options.cursor;

    const records: PullResponse['records'][number][] = [];
    const deletions: { model: string; id: string }[] = [];
    const evictions: { model: string; id: string }[] = [];
    for (const meta of models) {
      const mine = window.filter((change) => change.model === meta.name);
      for (const change of mine)
        if (change.deleted) deletions.push({ model: meta.name, id: change.id });
      const changed = mine.filter((change) => !change.deleted).map((change) => change.id);
      if (changed.length === 0) continue;
      // What the user may read, through the ORM (ACL and record rules, then row-level security).
      let visible: string[];
      try {
        visible = (await env.model(meta.name).search([['id', 'in', changed]])).ids.slice();
      } catch (error) {
        if (!(error instanceof AccessError)) throw error;
        visible = [];
      }
      const seen = new Set(visible);
      for (const id of changed) if (!seen.has(id)) evictions.push({ model: meta.name, id });
      if (visible.length === 0) continue;
      const fields = syncableFields(meta).filter((name) =>
        canSee(meta.fields.get(name) as FieldDefinition),
      );
      const rows = await env
        .model(meta.name)
        .browse(visible)
        .read(['id', ...fields]);
      const versions = await backend.fieldVersions(meta, visible);
      for (const row of rows) {
        const id = row.id as string;
        const change = mine.find((c) => c.id === id);
        const values: Record<string, JsonValue> = {};
        for (const field of fields) values[field] = (row[field] ?? null) as JsonValue;
        records.push({
          model: meta.name,
          id,
          version: change?.version ?? 0,
          values,
          fieldVersions: { ...(versions.get(id) ?? {}) },
        });
      }
    }
    return { cursor, records, deletions, evictions, reset: false, more, rights: options.rights };
  });
}
