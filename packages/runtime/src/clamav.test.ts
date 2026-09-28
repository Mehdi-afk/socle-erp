// SPDX-License-Identifier: LGPL-3.0-only
//
// Virus scanning against a real clamd, with the EICAR test file (the standard harmless string
// every antivirus detects).
import { randomBytes } from 'node:crypto';

import { startClamav, type EphemeralClamav } from '@socle/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ClamavError, pingClamav, scanWithClamav } from './clamav.js';

// Assembled at run time so that no antivirus flags this source file.
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR', '-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join(
  '',
);

describe('clamd scanning', () => {
  let clamav: EphemeralClamav;
  beforeAll(async () => {
    clamav = await startClamav();
  });
  afterAll(async () => {
    await clamav.stop();
  });

  it('finds EICAR, passes a clean file, and scans files larger than one chunk', async () => {
    const config = { host: clamav.host, port: clamav.port };
    expect(await pingClamav(config)).toBe(true);
    expect(await scanWithClamav(config, new TextEncoder().encode(EICAR))).toEqual({
      status: 'infected',
      signature: expect.stringMatching(/Eicar/i) as unknown,
    });
    expect(await scanWithClamav(config, new TextEncoder().encode('Facture n° 42'))).toEqual({
      status: 'clean',
    });
    const big = new Uint8Array(randomBytes(300_000));
    expect(await scanWithClamav(config, big)).toEqual({ status: 'clean' });
  });

  it('never takes an unreachable scanner for a clean result', async () => {
    const closed = { host: '127.0.0.1', port: 1, timeoutMs: 2000 };
    expect(await pingClamav(closed)).toBe(false);
    await expect(scanWithClamav(closed, new Uint8Array([1, 2, 3]))).rejects.toThrow(ClamavError);
  });
});
