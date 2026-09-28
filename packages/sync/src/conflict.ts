// SPDX-License-Identifier: LGPL-3.0-only
//
// Conflict resolution, a pure function (ARCHITECTURE.md §6.4, FleetOra pattern): same inputs,
// same decision, no I/O. The server calls it for every replayed mutation; the losing version
// is ALWAYS archived — a conflict never loses data silently.
import type { ConflictPolicy } from '@socle/framework';

/**
 * The server's current state of the record a mutation targets.
 * @public
 */
export interface RemoteState {
  /** The record exists (not deleted). */
  readonly exists: boolean;
  /** A tombstone: the record was deleted on the server. */
  readonly deleted: boolean;
  /** Current version of each field on the server (0 or absent: never written since creation). */
  readonly fieldVersions: Readonly<Record<string, number>>;
}

/**
 * What the device did, and on which base.
 * @public
 */
export interface LocalChange {
  readonly op: 'create' | 'write' | 'unlink';
  /** Fields changed on the device (create, write). */
  readonly fields: readonly string[];
  /** Server version of each field when the device edited it (write, unlink). */
  readonly baseVersions: Readonly<Record<string, number>>;
}

/**
 * The decision for one mutation.
 * @public
 */
export interface ConflictDecision {
  /** `apply` the change, `merge` (apply it; concurrent server values are archived), or `reject`. */
  readonly action: 'apply' | 'merge' | 'reject';
  /** Which version is archived: the local change (rejected) or the overwritten server values. */
  readonly archive: 'none' | 'local' | 'remote';
  /** True when the device and the server changed the same data concurrently. */
  readonly conflict: boolean;
  /** Fields changed concurrently (their server value moved since the device's base). */
  readonly conflictingFields: readonly string[];
  readonly reason: string;
}

const decision = (
  action: ConflictDecision['action'],
  archive: ConflictDecision['archive'],
  conflictingFields: readonly string[],
  reason: string,
): ConflictDecision => ({
  action,
  archive,
  conflict: conflictingFields.length > 0,
  conflictingFields,
  reason,
});

/** Fields whose server version moved since the device's base. */
function moved(fields: readonly string[], local: LocalChange, remote: RemoteState): string[] {
  return fields.filter(
    (field) => (remote.fieldVersions[field] ?? 0) !== (local.baseVersions[field] ?? 0),
  );
}

/**
 * Decides what the server does with a device's change (§6.4):
 * - `field-lww` (default): field by field, the last writer — the mutation arriving now — wins;
 *   two devices changing different fields never conflict; overwritten concurrent values are
 *   archived.
 * - `server-wins`: a concurrent change on the server rejects the device's change (archived).
 * - `append-only`: records are only ever created (stock moves, journal items, receipts).
 * - `manual`: a concurrent change is kept aside for the user to settle in the Sync Center.
 * A deleted record stays deleted: later changes to it are rejected and archived.
 * @public
 */
export function decideConflict(
  policy: ConflictPolicy,
  local: LocalChange,
  remote: RemoteState,
): ConflictDecision {
  if (local.op === 'create') {
    if (remote.exists || remote.deleted) {
      return decision('reject', 'local', [], 'a record with this id already exists');
    }
    return decision('apply', 'none', [], 'new record');
  }

  if (policy === 'append-only') {
    return decision(
      'reject',
      'local',
      [],
      `"${local.op}" is not allowed: records of this model are append-only`,
    );
  }

  if (remote.deleted || !remote.exists) {
    return local.op === 'unlink'
      ? decision('apply', 'none', [], 'already deleted')
      : {
          ...decision(
            'reject',
            'local',
            [],
            remote.deleted
              ? 'the record was deleted on the server'
              : 'the record does not exist on the server',
          ),
          conflict: true,
        };
  }

  // For a deletion, the device's base covers every field it knew.
  const fields = local.op === 'unlink' ? Object.keys(remote.fieldVersions) : local.fields;
  const conflicting = moved(fields, local, remote);
  if (conflicting.length === 0) return decision('apply', 'none', [], 'no concurrent change');

  switch (policy) {
    case 'field-lww':
      return decision(
        'merge',
        'remote',
        conflicting,
        'concurrent change: last writer wins, server values archived',
      );
    case 'server-wins':
      return decision('reject', 'local', conflicting, 'concurrent change: the server version wins');
    case 'manual':
      return decision(
        'reject',
        'local',
        conflicting,
        'concurrent change: to be settled in the Sync Center',
      );
  }
}
