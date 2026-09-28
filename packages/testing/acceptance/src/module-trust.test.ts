// SPDX-License-Identifier: LGPL-3.0-only
//
// Signed module packages (ARCHITECTURE.md §11 bis) on the real files of the acceptance
// modules: a package signed by its publisher and countersigned by the marketplace is
// accepted; a modified file, a missing signature or a revocation make it refused.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { loadModules } from '@socle/runtime';
import { exportPublicKey, generateSigningKeyPair, utf8 } from '@socle/crypto';
import {
  countersignPackage,
  createPackageIndex,
  createTrustStore,
  IntegrityError,
  RevokedModuleError,
  SignatureError,
  signPackage,
  UnsignedModuleError,
  verifyPackage,
  type PackageSource,
} from '@socle/framework';
import { describe, expect, it } from 'vitest';

import { MODULES } from './harness.js';

/** Every file of a module directory (a directory of this repository, found by the loader). */
async function filesOf(dir: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- repository module dir
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- listed just above
    files.set(relative(dir, path).split(sep).join('/'), await readFile(path));
  }
  return files;
}

const sourceOf = (files: ReadonlyMap<string, Uint8Array>): PackageSource => ({
  listFiles: () => Promise.resolve([...files.keys()]),
  readFile: (path) => {
    const content = files.get(path);
    return content ? Promise.resolve(content) : Promise.reject(new Error(`missing ${path}`));
  },
});

describe('signed module packages', () => {
  it('accepts a signed module and refuses it once tampered with, unsigned or revoked', async () => {
    const set = await loadModules([MODULES]);
    const module = set.get('acc_ext');
    const files = await filesOf(module.path);
    expect([...files.keys()]).toContain('models/partner.ext.ts');

    const [publisher, marketplace] = [
      await generateSigningKeyPair(),
      await generateSigningKeyPair(),
    ];
    const trustStore = await createTrustStore({
      'mkt-1': await exportPublicKey(marketplace.publicKey),
    });
    const index = await createPackageIndex({
      manifest: module.manifest,
      files,
      publisher: { id: 'socle', keyId: 'socle-1', publicKey: publisher.publicKey },
    });
    const published = await signPackage(index, publisher.privateKey);
    const signed = await countersignPackage(published, {
      keyId: 'mkt-1',
      key: marketplace.privateKey,
    });
    const saas = { trustStore, policy: { deployment: 'saas' } } as const;

    const verified = await verifyPackage(signed, sourceOf(files), saas);
    expect(verified).toMatchObject({ trust: 'marketplace', publisherId: 'socle' });
    expect(verified.manifest.name).toBe('acc_ext');

    // One byte changed in the model that extends acc_base.
    const tampered = new Map(files).set(
      'models/partner.ext.ts',
      utf8(`${new TextDecoder().decode(files.get('models/partner.ext.ts'))}\n// changed`),
    );
    await expect(verifyPackage(signed, sourceOf(tampered), saas)).rejects.toThrow(IntegrityError);

    // Signed by its publisher only: the marketplace countersignature is missing.
    await expect(verifyPackage(published, sourceOf(files), saas)).rejects.toThrow(SignatureError);
    // No signature at all: never accepted on the SaaS.
    await expect(verifyPackage({ index }, sourceOf(files), saas)).rejects.toThrow(
      UnsignedModuleError,
    );

    // Revoked by the marketplace after publication.
    await expect(
      verifyPackage(signed, sourceOf(files), {
        ...saas,
        revocations: {
          format: 'socle-revocations/1',
          sequence: 1,
          issuedAt: new Date().toISOString(),
          entries: [{ kind: 'package', digest: verified.digest, reason: 'malware' }],
        },
      }),
    ).rejects.toThrow(RevokedModuleError);
  });
});
