// SPDX-License-Identifier: LGPL-3.0-only
//
// Safety rules of the offline client (ARCHITECTURE.md §6.3, §6.5), as pure functions.
import { SocleError } from '@socle/framework';

/**
 * A local read that failed. Never to be taken for "no data" (FleetOra guard: an empty base
 * after a failed read would re-download everything or, worse, look like deletions).
 * @public
 */
export class ReplicaReadError extends SocleError {
  constructor(message: string, cause?: unknown) {
    super('sync.replica_read', message, { cause });
  }
}

/**
 * The outcome of a local read: a value, or an explicit failure — there is no "empty" default.
 * @public
 */
export type ReplicaRead<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/**
 * Runs a local read and captures its failure as a value.
 * @public
 */
export async function readReplica<T>(read: () => Promise<T>): Promise<ReplicaRead<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * The value of a successful read; throws {@link ReplicaReadError} otherwise, so that no caller
 * can go on with an empty result.
 * @public
 */
export function requireRead<T>(result: ReplicaRead<T>, what: string): T {
  if (result.ok) return result.value;
  throw new ReplicaReadError(`Could not read ${what} from the local replica.`, result.error);
}

/**
 * Where the device stands with respect to the maximum offline duration (§6.5, per company,
 * 7 days by default): past it, the local data is locked (not deleted) until the user signs in
 * again online.
 * @public
 */
export function offlineStatus(
  lastServerContact: string,
  now: string,
  maxOfflineDays: number,
): { readonly locked: boolean; readonly remainingMs: number } {
  const elapsed = Date.parse(now) - Date.parse(lastServerContact);
  const allowed = maxOfflineDays * 86_400_000;
  // An unreadable or future date locks: the safe side.
  if (!Number.isFinite(elapsed) || elapsed < 0) return { locked: true, remainingMs: 0 };
  return { locked: elapsed > allowed, remainingMs: Math.max(0, allowed - elapsed) };
}

/**
 * What the device does after contacting the server about its registration (§6.5):
 * a revoked (or unknown) device wipes its local data — replica, outbox, keys.
 * @public
 */
export function deviceAction(status: 'active' | 'revoked' | 'unknown'): 'continue' | 'wipe' {
  return status === 'active' ? 'continue' : 'wipe';
}
