// SPDX-License-Identifier: LGPL-3.0-only
import { importPublicKey, type SigningPublicKey } from '@socle/crypto';

import { InvalidPackageError } from './errors.js';

/**
 * The marketplace public keys trusted by this installation. They are embedded in the core
 * so that verification works offline (ARCHITECTURE.md §11 bis).
 * @public
 */
export interface TrustStore {
  marketplaceKey(keyId: string): SigningPublicKey | undefined;
  keyIds(): readonly string[];
}

/**
 * Builds a trust store from base64url public keys indexed by key id.
 * @public
 */
export async function createTrustStore(
  marketplaceKeys: Readonly<Record<string, string>>,
): Promise<TrustStore> {
  const keys = new Map<string, SigningPublicKey>();
  for (const [keyId, encoded] of Object.entries(marketplaceKeys)) {
    try {
      keys.set(keyId, await importPublicKey(encoded));
    } catch {
      throw new InvalidPackageError(`Invalid marketplace public key "${keyId}".`);
    }
  }
  const ids = Object.freeze([...keys.keys()].sort());
  return Object.freeze({
    marketplaceKey: (keyId: string) => keys.get(keyId),
    keyIds: () => ids,
  });
}
