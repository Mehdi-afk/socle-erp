// SPDX-License-Identifier: LGPL-3.0-only
//
// Applying a pull to the local replica while local changes are still waiting in the outbox:
// the server's values are the base, the pending local changes are replayed on top of them
// (they will reach the server with their own base versions and be decided there).
import type { JsonValue } from '@socle/crypto';

import type { Mutation, PulledRecord } from './protocol.js';

/**
 * The local view of a record: `null` when it must not exist locally (deleted by a pending
 * local deletion).
 * @public
 */
export interface LocalRecord {
  readonly values: Readonly<Record<string, JsonValue>>;
  /** Server version of each field: the base of the next local edits. */
  readonly fieldVersions: Readonly<Record<string, number>>;
}

/**
 * The record as the device should show it: the pulled server state with the pending local
 * changes of the same record replayed in order.
 * @public
 */
export function rebase(pulled: PulledRecord, pending: readonly Mutation[]): LocalRecord | null {
  let values: Record<string, JsonValue> = { ...pulled.values };
  for (const mutation of pending) {
    if (mutation.model !== pulled.model || mutation.recordId !== pulled.id) continue;
    if (mutation.op === 'unlink') return null;
    if (mutation.op === 'create' || mutation.op === 'write')
      values = { ...values, ...mutation.changes };
  }
  return { values, fieldVersions: pulled.fieldVersions };
}
