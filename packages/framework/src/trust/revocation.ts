// SPDX-License-Identifier: LGPL-3.0-only
import {
  canonicalBytes,
  sign,
  verify,
  type JsonValue,
  type SigningPrivateKey,
} from '@socle/crypto';
import semver from 'semver';
import { z } from 'zod';

import { InvalidPackageError, RevocationRollbackError, SignatureError } from './errors.js';
import type { TrustStore } from './trust-store.js';

const FORMAT = 'socle-revocations/1';

const entrySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('package'), digest: z.string().min(1), reason: z.string() }),
  z.strictObject({ kind: z.literal('publisher'), keyId: z.string().min(1), reason: z.string() }),
  z.strictObject({
    kind: z.literal('module'),
    name: z.string().min(1),
    versions: z.string().refine((r) => semver.validRange(r) !== null, 'invalid SemVer range'),
    reason: z.string(),
  }),
]);

const listSchema = z.strictObject({
  format: z.literal(FORMAT),
  sequence: z.number().int().positive(),
  issuedAt: z.iso.datetime(),
  entries: z.array(entrySchema),
});

const signedSchema = z.strictObject({
  list: listSchema,
  keyId: z.string().min(1),
  signature: z.string().min(1),
});

/**
 * One revocation: a whole package (by digest), a publisher key, or module versions.
 * @public
 */
export type RevocationEntry =
  | { readonly kind: 'package'; readonly digest: string; readonly reason: string }
  | { readonly kind: 'publisher'; readonly keyId: string; readonly reason: string }
  | {
      readonly kind: 'module';
      readonly name: string;
      readonly versions: string;
      readonly reason: string;
    };

/**
 * A revocation list published by the marketplace. `sequence` only ever increases.
 * @public
 */
export interface RevocationList {
  readonly format: 'socle-revocations/1';
  readonly sequence: number;
  readonly issuedAt: string;
  readonly entries: readonly RevocationEntry[];
}

/** @public */
export interface SignedRevocationList {
  readonly list: RevocationList;
  readonly keyId: string;
  readonly signature: string;
}

/**
 * What identifies an installed module package for revocation purposes.
 * @public
 */
export interface RevocationSubject {
  readonly manifest: { readonly name: string; readonly version: string };
  readonly digest: string;
  readonly publisherKeyId: string;
}

/**
 * Signs a revocation list with a marketplace key.
 * @public
 */
export async function signRevocationList(
  list: RevocationList,
  marketplace: { readonly keyId: string; readonly key: SigningPrivateKey },
): Promise<SignedRevocationList> {
  return {
    list,
    keyId: marketplace.keyId,
    signature: await sign(marketplace.key, canonicalBytes(list as unknown as JsonValue)),
  };
}

/**
 * Verifies a signed revocation list (fetched at each synchronisation) and refuses any list
 * older than the last accepted one, so that a revocation cannot be undone by replaying an old list.
 * @public
 */
export async function verifyRevocationList(
  value: unknown,
  trustStore: TrustStore,
  options: { readonly lastAcceptedSequence?: number | undefined } = {},
): Promise<RevocationList> {
  const parsed = signedSchema.safeParse(value);
  if (!parsed.success) throw new InvalidPackageError('Malformed revocation list.');
  const { list, keyId, signature } = parsed.data;
  const key = trustStore.marketplaceKey(keyId);
  if (!key) throw new SignatureError(`Revocation list signed with unknown key "${keyId}".`);
  if (!(await verify(key, signature, canonicalBytes(list)))) {
    throw new SignatureError('Invalid revocation list signature.');
  }
  const last = options.lastAcceptedSequence ?? 0;
  if (list.sequence < last) throw new RevocationRollbackError(list.sequence, last);
  return list;
}

/**
 * Returns the first revocation entry that applies to a module package, if any.
 * @public
 */
export function findRevocation(
  list: RevocationList,
  subject: RevocationSubject,
): RevocationEntry | undefined {
  return list.entries.find((entry) => {
    switch (entry.kind) {
      case 'package':
        return entry.digest === subject.digest;
      case 'publisher':
        return entry.keyId === subject.publisherKeyId;
      case 'module':
        return (
          entry.name === subject.manifest.name &&
          semver.satisfies(subject.manifest.version, entry.versions)
        );
    }
  });
}

/**
 * Names of the installed modules that must be disabled according to a revocation list.
 * @public
 */
export function modulesToDisable(
  list: RevocationList,
  installed: Iterable<RevocationSubject>,
): string[] {
  const names: string[] = [];
  for (const subject of installed) {
    if (findRevocation(list, subject)) names.push(subject.manifest.name);
  }
  return names.sort();
}
