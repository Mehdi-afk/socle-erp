// SPDX-License-Identifier: LGPL-3.0-only
import { exportPublicKey, generateSigningKeyPair, utf8, type SigningKeyPair } from '@socle/crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import type { ManifestInput } from '../registry/manifest.js';
import {
  IntegrityError,
  InvalidPackageError,
  RevocationRollbackError,
  RevokedModuleError,
  SignatureError,
  UnsignedModuleError,
} from './errors.js';
import {
  countersignPackage,
  createPackageIndex,
  signPackage,
  verifyPackage,
  type PackageSource,
  type SignedModulePackage,
} from './package.js';
import { isSafeRelativePath } from './paths.js';
import {
  modulesToDisable,
  signRevocationList,
  verifyRevocationList,
  type RevocationList,
} from './revocation.js';
import { createTrustStore, type TrustStore } from './trust-store.js';

const manifest: ManifestInput = {
  name: 'acme_crm',
  version: '1.2.0',
  label: { fr: 'CRM Acme' },
  depends: [],
  license: 'LicenseRef-Acme',
  edition: 'pro',
  engines: { socle: '^0.1' },
  capabilities: [{ network: ['api.acme.fr'] }],
};

function sourceOf(files: Map<string, Uint8Array>): PackageSource {
  return {
    listFiles: () => Promise.resolve([...files.keys()]),
    readFile: (path) => {
      const content = files.get(path);
      return content ? Promise.resolve(content) : Promise.reject(new Error('ENOENT'));
    },
  };
}

let marketplace: SigningKeyPair;
let publisher: SigningKeyPair;
let trustStore: TrustStore;
let files: Map<string, Uint8Array>;
let signed: SignedModulePackage;

const selfHosted = { deployment: 'self-hosted' } as const;

beforeAll(async () => {
  marketplace = await generateSigningKeyPair();
  publisher = await generateSigningKeyPair();
  trustStore = await createTrustStore({ 'mkt-2026': await exportPublicKey(marketplace.publicKey) });
  files = new Map([
    ['manifest.ts', utf8('export default defineManifest({})')],
    ['models/lead.ts', utf8('export default defineModel({})')],
  ]);
  const index = await createPackageIndex({
    manifest,
    files,
    publisher: { id: 'acme', keyId: 'acme-1', publicKey: publisher.publicKey },
  });
  signed = await countersignPackage(await signPackage(index, publisher.privateKey), {
    keyId: 'mkt-2026',
    key: marketplace.privateKey,
  });
});

describe('verifyPackage', () => {
  it('accepts a package signed by its publisher and countersigned by the marketplace', async () => {
    const verified = await verifyPackage(signed, sourceOf(files), {
      trustStore,
      policy: { deployment: 'saas' },
    });
    expect(verified.trust).toBe('marketplace');
    expect(verified.manifest.name).toBe('acme_crm');
    expect(verified.publisherId).toBe('acme');
  });

  it('refuses a file modified after signing', async () => {
    const tampered = new Map(files).set('models/lead.ts', utf8('steal()'));
    await expect(
      verifyPackage(signed, sourceOf(tampered), { trustStore, policy: selfHosted }),
    ).rejects.toThrow(IntegrityError);
  });

  it('refuses a file added after signing', async () => {
    const added = new Map(files).set('models/backdoor.ts', utf8('x'));
    await expect(
      verifyPackage(signed, sourceOf(added), { trustStore, policy: selfHosted }),
    ).rejects.toThrow(/added/);
  });

  it('refuses a file removed after signing', async () => {
    const removed = new Map(files);
    removed.delete('models/lead.ts');
    await expect(
      verifyPackage(signed, sourceOf(removed), { trustStore, policy: selfHosted }),
    ).rejects.toThrow(/missing/);
  });

  it('refuses an index modified after signing (e.g. a capability added)', async () => {
    const forged = {
      ...signed,
      index: {
        ...signed.index,
        manifest: { ...signed.index.manifest, capabilities: ['sudo'] },
      },
    };
    await expect(
      verifyPackage(forged, sourceOf(files), { trustStore, policy: selfHosted }),
    ).rejects.toThrow(SignatureError);
  });

  it('refuses a package re-signed by another publisher key', async () => {
    const attacker = await generateSigningKeyPair();
    const resigned = { ...signed, ...(await signPackage(signed.index, attacker.privateKey)) };
    await expect(
      verifyPackage(resigned, sourceOf(files), { trustStore, policy: selfHosted }),
    ).rejects.toThrow(/publisher signature/);
  });

  it('refuses a countersignature made with an untrusted key', async () => {
    const fake = await generateSigningKeyPair();
    const pkg = await countersignPackage(signed, { keyId: 'mkt-2026', key: fake.privateKey });
    await expect(
      verifyPackage(pkg, sourceOf(files), { trustStore, policy: selfHosted }),
    ).rejects.toThrow(/marketplace countersignature/);
  });

  it('refuses an unknown marketplace key id', async () => {
    const pkg = {
      ...signed,
      marketplace: { keyId: 'other', signature: signed.marketplace?.signature ?? '' },
    };
    await expect(
      verifyPackage(pkg, sourceOf(files), { trustStore, policy: selfHosted }),
    ).rejects.toThrow(/unknown marketplace key/);
  });

  it('refuses a package signed by the publisher only', async () => {
    const publisherOnly = { index: signed.index, publisherSignature: signed.publisherSignature };
    await expect(
      verifyPackage(publisherOnly, sourceOf(files), { trustStore, policy: selfHosted }),
    ).rejects.toThrow(SignatureError);
  });

  describe('unsigned modules', () => {
    const unsigned = (): SignedModulePackage => ({ index: signed.index });

    it('are refused by default', async () => {
      await expect(
        verifyPackage(unsigned(), sourceOf(files), { trustStore, policy: selfHosted }),
      ).rejects.toThrow(UnsignedModuleError);
    });

    it('are always refused on the SaaS', async () => {
      await expect(
        verifyPackage(unsigned(), sourceOf(files), {
          trustStore,
          policy: { deployment: 'saas', allowUnsigned: true },
        }),
      ).rejects.toThrow(UnsignedModuleError);
    });

    it('are accepted on self-hosting with the explicit option, integrity still checked', async () => {
      const options = {
        trustStore,
        policy: { deployment: 'self-hosted', allowUnsigned: true },
      } as const;
      expect((await verifyPackage(unsigned(), sourceOf(files), options)).trust).toBe('unsigned');
      const tampered = new Map(files).set('manifest.ts', utf8('x'));
      await expect(verifyPackage(unsigned(), sourceOf(tampered), options)).rejects.toThrow(
        IntegrityError,
      );
    });
  });

  it.each([
    ['not an object', 'package'],
    ['unknown format', { index: { format: 'zip' } }],
    ['path traversal', { index: { format: 'socle-module/1', files: { '../../etc/passwd': 'x' } } }],
  ])('refuses a malformed package (%s)', async (_case, value) => {
    await expect(
      verifyPackage(value, sourceOf(files), { trustStore, policy: selfHosted }),
    ).rejects.toThrow(InvalidPackageError);
  });
});

describe('revocation', () => {
  const list = (sequence: number, entries: RevocationList['entries']): RevocationList => ({
    format: 'socle-revocations/1',
    sequence,
    issuedAt: '2026-09-28T00:00:00Z',
    entries,
  });

  it('refuses to install a revoked module version', async () => {
    const revocations = list(1, [
      { kind: 'module', name: 'acme_crm', versions: '<1.3.0', reason: 'data exfiltration' },
    ]);
    await expect(
      verifyPackage(signed, sourceOf(files), { trustStore, policy: selfHosted, revocations }),
    ).rejects.toThrow(RevokedModuleError);
  });

  it('designates installed modules to disable (package, publisher or version)', async () => {
    const verified = await verifyPackage(signed, sourceOf(files), {
      trustStore,
      policy: selfHosted,
    });
    const other = {
      manifest: { name: 'other', version: '1.0.0' },
      digest: 'd',
      publisherKeyId: 'x',
    };
    expect(
      modulesToDisable(list(1, [{ kind: 'package', digest: verified.digest, reason: 'r' }]), [
        verified,
        other,
      ]),
    ).toEqual(['acme_crm']);
    expect(
      modulesToDisable(list(1, [{ kind: 'publisher', keyId: 'acme-1', reason: 'r' }]), [
        verified,
        other,
      ]),
    ).toEqual(['acme_crm']);
    expect(
      modulesToDisable(
        list(1, [{ kind: 'module', name: 'acme_crm', versions: '>=2', reason: 'r' }]),
        [verified],
      ),
    ).toEqual([]);
  });

  it('verifies the list signature and refuses rollbacks', async () => {
    const signedList = await signRevocationList(list(5, []), {
      keyId: 'mkt-2026',
      key: marketplace.privateKey,
    });
    expect(
      (await verifyRevocationList(signedList, trustStore, { lastAcceptedSequence: 5 })).sequence,
    ).toBe(5);
    await expect(
      verifyRevocationList(signedList, trustStore, { lastAcceptedSequence: 6 }),
    ).rejects.toThrow(RevocationRollbackError);
    const forged = {
      ...signedList,
      list: { ...signedList.list, entries: [] as const, sequence: 9 },
    };
    await expect(verifyRevocationList(forged, trustStore)).rejects.toThrow(SignatureError);
  });
});

describe('isSafeRelativePath', () => {
  it.each(['manifest.ts', 'models/sale-order.ts', 'i18n/fr.json', '.well-known/x'])(
    'accepts %j',
    (path) => {
      expect(isSafeRelativePath(path)).toBe(true);
    },
  );

  it.each(['', '/etc/passwd', '../x', 'a/../b', 'a/./b', 'a//b', 'C:/x', 'a\\b', 'a/', 'é.ts'])(
    'rejects %j',
    (path) => {
      expect(isSafeRelativePath(path)).toBe(false);
    },
  );
});
