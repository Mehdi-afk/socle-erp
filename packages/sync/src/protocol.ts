// SPDX-License-Identifier: LGPL-3.0-only
//
// Synchronisation messages (ARCHITECTURE.md §6.3, ADR 004). Everything that crosses the
// network is validated with these schemas, with size limits: the server never trusts a device.
import {
  canonicalBytes,
  sign,
  verify,
  type JsonValue,
  type SigningPrivateKey,
  type SigningPublicKey,
} from '@socle/crypto';
import { isRecordId } from '@socle/framework';
import { z } from 'zod';

const MODEL_SEGMENT = /^[a-z][a-z0-9_]*$/;
/** A model name, checked segment by segment (no nested quantifier). */
const isModelName = (name: string): boolean =>
  name.length <= 128 && name.split('.').every((segment) => MODEL_SEGMENT.test(segment));
const FIELD = /^[a-z][A-Za-z0-9]*$/;
const DEVICE = /^[A-Za-z0-9_-]{8,64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{80,100}$/;

const recordId = z.string().refine(isRecordId, 'must be a record id (UUID)');
const instant = z.iso.datetime({ offset: false });

const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string().max(1_000_000),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue).max(10_000),
    z.record(z.string().max(200), jsonValue),
  ]),
);

const fieldName = z.string().max(64).regex(FIELD);

/** @public */
export type MutationOp = 'create' | 'write' | 'unlink' | 'call';

/**
 * A change made on a device, replayed by the server through the ORM (§6.3).
 * @public
 */
export interface Mutation {
  /** UUIDv7 generated on the device: the server applies a mutation at most once. */
  readonly mutationId: string;
  readonly deviceId: string;
  readonly model: string;
  readonly op: MutationOp;
  readonly recordId: string;
  /** New field values (create, write). */
  readonly changes?: Readonly<Record<string, JsonValue>> | undefined;
  /** Version of each changed field when it was edited (write, unlink). */
  readonly baseVersions?: Readonly<Record<string, number>> | undefined;
  /** Server method queued offline (op = 'call'). */
  readonly method?: string | undefined;
  readonly args?: readonly JsonValue[] | undefined;
  /** When the user made the change (device clock: informative only, never trusted). */
  readonly clientTs: string;
  /** Ed25519 signature of the device over every other property. */
  readonly signature: string;
}

/** @public */
export type UnsignedMutation = Omit<Mutation, 'signature'>;

const mutationSchema = z
  .object({
    mutationId: recordId,
    deviceId: z.string().regex(DEVICE),
    model: z.string().refine(isModelName, 'must be a model name'),
    op: z.enum(['create', 'write', 'unlink', 'call']),
    recordId,
    changes: z.record(fieldName, jsonValue).optional(),
    baseVersions: z.record(fieldName, z.number().int().nonnegative()).optional(),
    method: z
      .string()
      .max(64)
      .regex(/^[a-z][A-Za-z0-9]*$/)
      .optional(),
    args: z.array(jsonValue).max(32).optional(),
    clientTs: instant,
    signature: z.string().regex(SIGNATURE),
  })
  .strict()
  .superRefine((m, context) => {
    const problem = (message: string): void => {
      context.addIssue({ code: 'custom', message });
    };
    if (
      (m.op === 'create' || m.op === 'write') &&
      (!m.changes || Object.keys(m.changes).length === 0)
    ) {
      problem(`"${m.op}" needs changes`);
    }
    if (m.op === 'call' && m.method === undefined) problem('"call" needs a method');
    if (m.op !== 'call' && (m.method !== undefined || m.args !== undefined))
      problem('only "call" takes a method');
    if (Object.keys(m.changes ?? {}).length > 500) problem('too many changed fields');
  });

/**
 * Validates a mutation received from a device (shape, sizes, consistency). The signature is
 * checked separately with {@link verifyMutation}.
 * @public
 */
export function parseMutation(value: unknown): Mutation {
  return mutationSchema.parse(value);
}

/** The exact bytes a device signs: the canonical JSON of the mutation without its signature. */
function signedBytes(mutation: UnsignedMutation): Uint8Array {
  const {
    mutationId,
    deviceId,
    model,
    op,
    recordId: id,
    changes,
    baseVersions,
    method,
    args,
    clientTs,
  } = mutation;
  const payload: Record<string, JsonValue> = {
    mutationId,
    deviceId,
    model,
    op,
    recordId: id,
    clientTs,
  };
  if (changes !== undefined) payload.changes = { ...changes };
  if (baseVersions !== undefined) payload.baseVersions = { ...baseVersions };
  if (method !== undefined) payload.method = method;
  if (args !== undefined) payload.args = [...args];
  return canonicalBytes(payload);
}

/**
 * Signs a mutation with the device key.
 * @public
 */
export async function signMutation(
  key: SigningPrivateKey,
  mutation: UnsignedMutation,
): Promise<Mutation> {
  return { ...mutation, signature: await sign(key, signedBytes(mutation)) };
}

/**
 * Checks the device signature of a mutation.
 * @public
 */
export async function verifyMutation(key: SigningPublicKey, mutation: Mutation): Promise<boolean> {
  const { signature, ...unsigned } = mutation;
  return verify(key, signature, signedBytes(unsigned));
}

/**
 * What the server answers for each pushed mutation.
 * @public
 */
export interface PushResult {
  readonly mutationId: string;
  /**
   * `applied`: done; `merged`: done, some fields overwrote concurrent changes (archived);
   * `duplicate`: already applied earlier (idempotence); `rejected`: refused by a rule, a right
   * or a conflict policy (the local version is archived); `error`: temporary, retry later.
   */
  readonly status: 'applied' | 'merged' | 'duplicate' | 'rejected' | 'error';
  readonly conflict: boolean;
  readonly reason: string;
  /**
   * Version of each field of the record right after the mutation (`applied`, `merged` create
   * or write): the device bases its next pending changes of the record on them.
   */
  readonly fieldVersions?: Readonly<Record<string, number>> | undefined;
}

const pushResultSchema = z
  .object({
    mutationId: z.string().max(64),
    status: z.enum(['applied', 'merged', 'duplicate', 'rejected', 'error']),
    conflict: z.boolean(),
    reason: z.string().max(2000),
    fieldVersions: z.record(fieldName, z.number().int().nonnegative()).optional(),
  })
  .strict();

/**
 * Validates the server's answer to a push on the device.
 * @public
 */
export function parsePushResults(value: unknown): PushResult[] {
  return z.array(pushResultSchema).max(10_000).parse(value);
}

/**
 * A record changed or created on the server since the cursor, visible to the user.
 * @public
 */
export interface PulledRecord {
  readonly model: string;
  readonly id: string;
  readonly version: number;
  readonly values: Readonly<Record<string, JsonValue>>;
  /** Version of each field, the base of the next local edits. */
  readonly fieldVersions: Readonly<Record<string, number>>;
}

/**
 * The answer to `GET /sync/pull?cursor=…` (§6.3).
 * @public
 */
export interface PullResponse {
  /** Cursor for the next pull (server version sequence). */
  readonly cursor: number;
  readonly records: readonly PulledRecord[];
  /** Records deleted on the server. */
  readonly deletions: readonly { readonly model: string; readonly id: string }[];
  /** Records the user may no longer see (rights removed, out of the time window): remove locally. */
  readonly evictions: readonly { readonly model: string; readonly id: string }[];
  /** The user's rights changed: drop the whole replica and pull again from zero. */
  readonly reset: boolean;
  /** More changes are waiting: pull again with the new cursor. */
  readonly more: boolean;
}

const pulledSchema = z
  .object({
    model: z.string().refine(isModelName, 'must be a model name'),
    id: recordId,
    version: z.number().int().nonnegative(),
    values: z.record(fieldName, jsonValue),
    fieldVersions: z.record(fieldName, z.number().int().nonnegative()),
  })
  .strict();
const reference = z
  .object({ model: z.string().refine(isModelName, 'must be a model name'), id: recordId })
  .strict();

/**
 * Validates a pull response on the device (the server is trusted for its content, not for
 * being well-formed: a malformed answer must not corrupt the replica).
 * @public
 */
export function parsePullResponse(value: unknown): PullResponse {
  return z
    .object({
      cursor: z.number().int().nonnegative(),
      records: z.array(pulledSchema).max(50_000),
      deletions: z.array(reference).max(50_000),
      evictions: z.array(reference).max(50_000),
      reset: z.boolean(),
      more: z.boolean(),
    })
    .strict()
    .parse(value);
}
