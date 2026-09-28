// SPDX-License-Identifier: LGPL-3.0-only
//
// The S3 client: its signature checked against the examples of the AWS documentation
// ("Signature Version 4 — examples", bucket `examplebucket`), and its behaviour against a real
// SeaweedFS with authentication on.
import { randomBytes } from 'node:crypto';

import { startSeaweedfs, type EphemeralS3 } from '@socle/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createS3Client, S3Error, signV4 } from './s3.js';

const AWS_EXAMPLE = {
  region: 'us-east-1',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  amzDate: '20130524T000000Z',
};
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('AWS Signature Version 4', () => {
  it('signs a GET object request like the AWS example', () => {
    const { signature, signedHeaders } = signV4({
      ...AWS_EXAMPLE,
      method: 'GET',
      path: '/test.txt',
      headers: {
        host: 'examplebucket.s3.amazonaws.com',
        range: 'bytes=0-9',
        'x-amz-content-sha256': EMPTY_SHA256,
        'x-amz-date': AWS_EXAMPLE.amzDate,
      },
      payloadHash: EMPTY_SHA256,
    });
    expect(signedHeaders).toBe('host;range;x-amz-content-sha256;x-amz-date');
    expect(signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  it('signs a presigned URL like the AWS example', () => {
    const { signature } = signV4({
      ...AWS_EXAMPLE,
      method: 'GET',
      path: '/test.txt',
      query: {
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
        'X-Amz-Credential': 'AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request',
        'X-Amz-Date': AWS_EXAMPLE.amzDate,
        'X-Amz-Expires': '86400',
        'X-Amz-SignedHeaders': 'host',
      },
      headers: { host: 'examplebucket.s3.amazonaws.com' },
      payloadHash: 'UNSIGNED-PAYLOAD',
    });
    expect(signature).toBe('aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  });
});

describe('S3 client on SeaweedFS', () => {
  let s3: EphemeralS3;
  beforeAll(async () => {
    s3 = await startSeaweedfs();
  });
  afterAll(async () => {
    await s3.stop();
  });
  const client = (overrides: { secretAccessKey?: string } = {}) =>
    createS3Client({
      endpoint: s3.endpoint,
      region: 'us-east-1',
      accessKeyId: s3.accessKeyId,
      secretAccessKey: overrides.secretAccessKey ?? s3.secretAccessKey,
      bucket: 'socle-test',
    });

  it('stores, reads, links and deletes objects', async () => {
    const storage = client();
    await storage.ensureBucket();
    await storage.ensureBucket();
    const body = new Uint8Array(randomBytes(200_000));
    const key = 'acme/attachments/2026/09/0190a000-0000-7000-8000-000000000001';
    await storage.put(key, body, 'application/octet-stream');
    expect(Buffer.from(await storage.get(key)).equals(Buffer.from(body))).toBe(true);

    // A signed link works without credentials, and only for this object and this long.
    const link = storage.presignGet(key, 60);
    const downloaded = await fetch(link);
    expect(downloaded.status).toBe(200);
    expect((await downloaded.arrayBuffer()).byteLength).toBe(body.byteLength);
    const tampered = await fetch(link.replace('000000000001', '000000000002'));
    expect(tampered.status).toBe(403);
    await tampered.arrayBuffer();
    const expired = await fetch(storage.presignGet(key, 1, new Date(Date.now() - 3_600_000)));
    expect(expired.status).toBe(403);
    await expired.arrayBuffer();

    await storage.delete(key);
    await expect(storage.get(key)).rejects.toMatchObject({ status: 404 });
    await storage.delete(key);
  });

  it('is refused with a wrong secret, and refuses unsafe keys and endpoints', async () => {
    const wrong = client({ secretAccessKey: 'not-the-secret' });
    await expect(wrong.put('acme/x', new Uint8Array([1]), 'text/plain')).rejects.toThrow(S3Error);
    const storage = client();
    for (const key of ['../etc/passwd', 'a//b', '/abs', 'a/../b', 'a b', '']) {
      await expect(storage.get(key), key).rejects.toThrow(/Invalid object key/);
    }
    expect(() =>
      createS3Client({
        endpoint: 'http://user:pass@127.0.0.1:1',
        region: 'x',
        accessKeyId: 'a',
        secretAccessKey: 'b',
        bucket: 'socle-test',
      }),
    ).toThrow(S3Error);
    expect(() => storage.presignGet('acme/x', 7200)).toThrow(S3Error);
  });
});
