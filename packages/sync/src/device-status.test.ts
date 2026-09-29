// SPDX-License-Identifier: LGPL-3.0-only
import { generateSigningKeyPair } from '@socle/crypto';
import { describe, expect, it } from 'vitest';

import { DEVICE_STATUS_SKEW_MS, signDeviceStatus, verifyDeviceStatus } from './protocol.js';

const NOW = 1_800_000_000_000;

describe('signed device status', () => {
  it('proves a device holds its key, for that device, within five minutes', async () => {
    const pair = await generateSigningKeyPair();
    const proof = await signDeviceStatus(pair.privateKey, 'device-one', NOW);
    expect(proof.timestamp).toBe(NOW);
    expect(await verifyDeviceStatus(pair.publicKey, 'device-one', proof, NOW)).toBe(true);
    expect(
      await verifyDeviceStatus(pair.publicKey, 'device-one', proof, NOW + DEVICE_STATUS_SKEW_MS),
    ).toBe(true);
    expect(
      await verifyDeviceStatus(pair.publicKey, 'device-one', proof, NOW - DEVICE_STATUS_SKEW_MS),
    ).toBe(true);
  });

  it('refuses another device, another key, a stale or altered proof, and junk', async () => {
    const pair = await generateSigningKeyPair();
    const other = await generateSigningKeyPair();
    const proof = await signDeviceStatus(pair.privateKey, 'device-one', NOW);
    expect(await verifyDeviceStatus(pair.publicKey, 'device-two', proof, NOW)).toBe(false);
    expect(await verifyDeviceStatus(other.publicKey, 'device-one', proof, NOW)).toBe(false);
    expect(
      await verifyDeviceStatus(
        pair.publicKey,
        'device-one',
        proof,
        NOW + DEVICE_STATUS_SKEW_MS + 1,
      ),
    ).toBe(false);
    expect(
      await verifyDeviceStatus(
        pair.publicKey,
        'device-one',
        proof,
        NOW - DEVICE_STATUS_SKEW_MS - 1,
      ),
    ).toBe(false);
    expect(
      await verifyDeviceStatus(pair.publicKey, 'device-one', { ...proof, timestamp: NOW + 1 }, NOW),
    ).toBe(false);
    expect(
      await verifyDeviceStatus(
        pair.publicKey,
        'device-one',
        { timestamp: NOW, signature: 'x' },
        NOW,
      ),
    ).toBe(false);
    expect(
      await verifyDeviceStatus(
        pair.publicKey,
        'device-one',
        { timestamp: 1.5, signature: proof.signature },
        1.5,
      ),
    ).toBe(false);
  });
});
