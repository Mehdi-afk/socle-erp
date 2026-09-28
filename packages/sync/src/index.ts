// SPDX-License-Identifier: LGPL-3.0-only
export { decideConflict } from './conflict.js';
export { EMPTY_DEVICE_STATE, memoryDeviceStateStore, openDevice, recordKey } from './device.js';
export type {
  Device,
  DeviceOptions,
  DeviceState,
  DeviceStateStore,
  SyncReport,
  SyncTransport,
} from './device.js';
export type { ConflictDecision, LocalChange, RemoteState } from './conflict.js';
export {
  deviceAction,
  offlineStatus,
  readReplica,
  ReplicaReadError,
  requireRead,
} from './guards.js';
export type { ReplicaRead } from './guards.js';
export {
  acknowledge,
  dismissRejected,
  EMPTY_OUTBOX,
  enqueue,
  nextBatch,
  retryDelayMs,
} from './outbox.js';
export type { OutboxState, RejectedMutation } from './outbox.js';
export {
  parseMutation,
  parsePullResponse,
  parsePushResults,
  signMutation,
  verifyMutation,
} from './protocol.js';
export type {
  Mutation,
  MutationOp,
  PulledRecord,
  PullResponse,
  PushResult,
  UnsignedMutation,
} from './protocol.js';
export { rebase } from './replica.js';
export { pullChanges, pushMutations, rightsFingerprint, syncableFields } from './server.js';
export type {
  ArchiveEntry,
  DeviceInfo,
  RunInTransaction,
  SyncBackend,
  SyncContext,
} from './server.js';
export type { LocalRecord } from './replica.js';
