// SPDX-License-Identifier: LGPL-3.0-only
//
// The device's outbox: every local change and every server method called offline waits here
// (as an intent) until the server has answered (ARCHITECTURE.md §6.1, §6.3). Pure functions
// over an immutable state; the persistence (a SQLite table next to the replica) is separate.
import type { Mutation, PushResult } from './protocol.js';

/**
 * A mutation the server rejected, kept for the Sync Center with the server's reason.
 * @public
 */
export interface RejectedMutation {
  readonly mutation: Mutation;
  readonly reason: string;
  readonly conflict: boolean;
}

/** @public */
export interface OutboxState {
  /** Waiting to be pushed, in the order they were made (the server replays them in order). */
  readonly pending: readonly Mutation[];
  /** Refused by the server: shown to the user, never retried automatically. */
  readonly rejected: readonly RejectedMutation[];
  /** Consecutive failed attempts (temporary errors), for the retry delay. */
  readonly failures: number;
}

/** @public */
export const EMPTY_OUTBOX: OutboxState = Object.freeze({ pending: [], rejected: [], failures: 0 });

/**
 * Adds a local change (or an offline server call) to the outbox.
 * @public
 */
export function enqueue(state: OutboxState, mutation: Mutation): OutboxState {
  if (state.pending.some((m) => m.mutationId === mutation.mutationId)) return state;
  return { ...state, pending: [...state.pending, mutation] };
}

/**
 * The next batch to push: the oldest pending mutations, in order.
 * @public
 */
export function nextBatch(state: OutboxState, size = 100): readonly Mutation[] {
  return state.pending.slice(0, size);
}

/**
 * Applies the server's answer to a pushed batch. Applied, merged and duplicate mutations
 * leave the outbox; rejected ones move to `rejected`; the batch stops at the first temporary
 * error (the rest keeps its order and is retried later). A mutation without an answer stays
 * pending: an incomplete answer is never taken for a success.
 * @public
 */
export function acknowledge(state: OutboxState, results: readonly PushResult[]): OutboxState {
  const byId = new Map(results.map((result) => [result.mutationId, result]));
  const pending: Mutation[] = [];
  const rejected = [...state.rejected];
  let blocked = false;
  let failed = false;
  for (const mutation of state.pending) {
    const result = byId.get(mutation.mutationId);
    if (blocked || result === undefined) {
      pending.push(mutation);
      continue;
    }
    switch (result.status) {
      case 'applied':
      case 'merged':
      case 'duplicate':
        break;
      case 'rejected':
        rejected.push({ mutation, reason: result.reason, conflict: result.conflict });
        break;
      case 'error':
        failed = true;
        blocked = true;
        pending.push(mutation);
        break;
    }
  }
  return { pending, rejected, failures: failed ? state.failures + 1 : 0 };
}

/**
 * Delay before the next push after failures: exponential, capped, with jitter from `random`.
 * @public
 */
export function retryDelayMs(failures: number, random: () => number = Math.random): number {
  if (failures <= 0) return 0;
  const base = Math.min(5 * 60_000, 1000 * 2 ** Math.min(failures - 1, 16));
  return Math.round(base / 2 + (base / 2) * random());
}

/**
 * The user settles a rejected mutation in the Sync Center: it leaves the list (the user
 * redoes the change by hand if needed).
 * @public
 */
export function dismissRejected(state: OutboxState, mutationId: string): OutboxState {
  return {
    ...state,
    rejected: state.rejected.filter((entry) => entry.mutation.mutationId !== mutationId),
  };
}
