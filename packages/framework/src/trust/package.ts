// SPDX-License-Identifier: LGPL-3.0-only
import {
  bytesEqual,
  canonicalBytes,
  exportPublicKey,
  fromBase64Url,
  importPublicKey,
  sha256,
  sign,
  verify,
  type JsonValue,
  type SigningPrivateKey,
  type SigningPublicKey,
} from '@socle/crypto';
import { z } from 'zod';

import { parseManifest, type ManifestInput, type ModuleManifest } from '../registry/manifest.js';
import {
  IntegrityError,
  InvalidPackageError,
  RevokedModuleError,
  SignatureError,
  UnsignedModuleError,
} from './errors.js';
import { isSafeRelativePath } from './paths.js';
import { findRevocation, type RevocationList } from './revocation.js';
import type { TrustStore } from './trust-store.js';

/** Format identifier of the package index. */
const FORMAT = 'socle-module/1';

const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/, 'must be base64url');

const indexSchema = z.strictObject({
  format: z.literal(FORMAT),
  manifest: z.record(z.string(), z.unknown()),
  files: z
    .record(z.string(), base64url)
    .refine((files) => Object.keys(files).every(isSafeRelativePath), 'unsafe file path')
    .refine((files) => Object.keys(files).length > 0, 'a package lists at least one file'),
  publisher: z.strictObject({
    id: z.string().min(1).max(100),
    keyId: z.string().min(1).max(100),
    publicKey: base64url,
  }),
});

const packageSchema = z.strictObject({
  index: indexSchema,
  publisherSignature: base64url.optional(),
  marketplace: z
    .strictObject({ keyId: z.string().min(1).max(100), signature: base64url })
    .optional(),
});

/**
 * The signed content of a module package: its manifest, the SHA-256 of every file and the
 * publisher's identity.
 * @public
 */
export interface ModulePackageIndex {
  readonly format: 'socle-module/1';
  readonly manifest: Readonly<Record<string, unknown>>;
  /** Relative POSIX path → base64url SHA-256 of the file content. */
  readonly files: Readonly<Record<string, string>>;
  readonly publisher: {
    readonly id: string;
    readonly keyId: string;
    /** base64url Ed25519 public key of the publisher. */
    readonly publicKey: string;
  };
}

/**
 * A module package as distributed: the index, the publisher signature and the marketplace
 * countersignature. Both signatures are absent for an unsigned (self-hosted, dev) module.
 * @public
 */
export interface SignedModulePackage {
  readonly index: ModulePackageIndex;
  readonly publisherSignature?: string | undefined;
  readonly marketplace?: { readonly keyId: string; readonly signature: string } | undefined;
}

/**
 * Where the module files are read from during verification (disk, archive…).
 * @public
 */
export interface PackageSource {
  listFiles(): Promise<readonly string[]>;
  readFile(path: string): Promise<Uint8Array>;
}

/**
 * Installation policy (ARCHITECTURE.md §11 bis): unsigned modules are refused, except on a
 * self-hosted instance whose administrator explicitly allowed them. Never on the SaaS.
 * @public
 */
export interface InstallationPolicy {
  readonly deployment: 'saas' | 'self-hosted';
  readonly allowUnsigned?: boolean | undefined;
}

/** @public */
export interface VerifyPackageOptions {
  readonly trustStore: TrustStore;
  readonly policy: InstallationPolicy;
  /** Latest verified revocation list, if any. */
  readonly revocations?: RevocationList | undefined;
}

/** @public */
export interface VerifiedModulePackage {
  readonly manifest: ModuleManifest;
  /** base64url SHA-256 of the canonical index: identifies this exact package. */
  readonly digest: string;
  readonly publisherId: string;
  readonly publisherKeyId: string;
  /** `marketplace`: both signatures verified; `unsigned`: accepted by an explicit policy. */
  readonly trust: 'marketplace' | 'unsigned';
}

function marketplacePayload(index: ModulePackageIndex, publisherSignature: string): Uint8Array {
  return canonicalBytes({ index: index as unknown as JsonValue, publisherSignature });
}

/**
 * Builds the index of a module package from its files.
 * @public
 */
export async function createPackageIndex(input: {
  readonly manifest: ManifestInput;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly publisher: {
    readonly id: string;
    readonly keyId: string;
    readonly publicKey: SigningPublicKey;
  };
}): Promise<ModulePackageIndex> {
  parseManifest(input.manifest);
  const files: Record<string, string> = {};
  for (const [path, content] of [...input.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!isSafeRelativePath(path)) throw new InvalidPackageError(`Unsafe file path "${path}".`);
    files[path] = await sha256(content);
  }
  return {
    format: FORMAT,
    manifest: JSON.parse(JSON.stringify(input.manifest)) as Record<string, unknown>,
    files,
    publisher: {
      id: input.publisher.id,
      keyId: input.publisher.keyId,
      publicKey: await exportPublicKey(input.publisher.publicKey),
    },
  };
}

/**
 * Publisher signature of a package index.
 * @public
 */
export async function signPackage(
  index: ModulePackageIndex,
  publisherKey: SigningPrivateKey,
): Promise<SignedModulePackage> {
  return {
    index,
    publisherSignature: await sign(publisherKey, canonicalBytes(index as unknown as JsonValue)),
  };
}

/**
 * Marketplace countersignature, made after the automated analysis and human review.
 * @public
 */
export async function countersignPackage(
  pkg: SignedModulePackage,
  marketplace: { readonly keyId: string; readonly key: SigningPrivateKey },
): Promise<SignedModulePackage> {
  if (!pkg.publisherSignature) throw new SignatureError('The publisher must sign first.');
  return {
    ...pkg,
    marketplace: {
      keyId: marketplace.keyId,
      signature: await sign(marketplace.key, marketplacePayload(pkg.index, pkg.publisherSignature)),
    },
  };
}

/**
 * Verifies a module package offline before installation or loading:
 * structure, publisher signature, marketplace countersignature (with an embedded trusted key),
 * integrity of every file (no modified, added or missing file), revocation, and the
 * installation policy for unsigned modules.
 * @throws {@link InvalidPackageError}, {@link SignatureError}, {@link IntegrityError},
 * {@link UnsignedModuleError}, {@link RevokedModuleError}
 * @public
 */
export async function verifyPackage(
  value: unknown,
  source: PackageSource,
  options: VerifyPackageOptions,
): Promise<VerifiedModulePackage> {
  const parsed = packageSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidPackageError(
      `Malformed module package: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const pkg = parsed.data;
  const manifest = parseManifest(pkg.index.manifest);
  const indexBytes = canonicalBytes(pkg.index as unknown as JsonValue);
  const digest = await sha256(indexBytes);

  // 1. Signatures (or explicit unsigned policy)
  let trust: VerifiedModulePackage['trust'];
  if (pkg.publisherSignature === undefined && pkg.marketplace === undefined) {
    if (options.policy.deployment !== 'self-hosted' || options.policy.allowUnsigned !== true) {
      throw new UnsignedModuleError(manifest.name);
    }
    trust = 'unsigned';
  } else {
    if (pkg.publisherSignature === undefined || pkg.marketplace === undefined) {
      throw new SignatureError(
        `Module "${manifest.name}" must carry both the publisher signature and the marketplace countersignature.`,
      );
    }
    let publisherKey: SigningPublicKey;
    try {
      publisherKey = await importPublicKey(pkg.index.publisher.publicKey);
    } catch {
      throw new SignatureError(`Module "${manifest.name}": invalid publisher public key.`);
    }
    if (!(await verify(publisherKey, pkg.publisherSignature, indexBytes))) {
      throw new SignatureError(`Module "${manifest.name}": invalid publisher signature.`);
    }
    const marketplaceKey = options.trustStore.marketplaceKey(pkg.marketplace.keyId);
    if (!marketplaceKey) {
      throw new SignatureError(
        `Module "${manifest.name}": unknown marketplace key "${pkg.marketplace.keyId}".`,
      );
    }
    const payload = marketplacePayload(pkg.index, pkg.publisherSignature);
    if (!(await verify(marketplaceKey, pkg.marketplace.signature, payload))) {
      throw new SignatureError(`Module "${manifest.name}": invalid marketplace countersignature.`);
    }
    trust = 'marketplace';
  }

  // 2. Integrity of every file, in both directions
  const expected = pkg.index.files;
  const actual = new Set(await source.listFiles());
  for (const path of actual) {
    if (!Object.hasOwn(expected, path)) throw new IntegrityError(path, 'added');
  }
  for (const [path, hash] of Object.entries(expected)) {
    if (!actual.has(path)) throw new IntegrityError(path, 'missing');
    const digestOfFile = fromBase64Url(await sha256(await source.readFile(path)));
    if (!bytesEqual(digestOfFile, fromBase64Url(hash))) {
      throw new IntegrityError(path, 'modified');
    }
  }

  // 3. Revocation
  const verified: VerifiedModulePackage = {
    manifest,
    digest,
    publisherId: pkg.index.publisher.id,
    publisherKeyId: pkg.index.publisher.keyId,
    trust,
  };
  if (options.revocations) {
    const entry = findRevocation(options.revocations, verified);
    if (entry) throw new RevokedModuleError(manifest.name, entry.reason);
  }
  return verified;
}
