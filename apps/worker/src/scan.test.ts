// SPDX-License-Identifier: LGPL-3.0-only
//
// The end-to-end scan runs in the acceptance tests (PostgreSQL, SeaweedFS, ClamAV); here, a
// tenant without the attachment model is left alone.
import { buildModelRegistry } from '@socle/framework';
import type { Executor } from '@socle/orm-pg';
import type { S3Client } from '@socle/runtime';
import { describe, expect, it } from 'vitest';

import { scanPendingAttachments } from './scan.js';

describe('attachment scanning', () => {
  it('does nothing for a tenant without attachments', async () => {
    const untouched = new Proxy({} as Executor, {
      get() {
        throw new Error('the database must not be used');
      },
    });
    expect(
      await scanPendingAttachments({
        db: untouched,
        registry: buildModelRegistry([], { side: 'server' }),
        s3: {} as S3Client,
        clamav: { host: '127.0.0.1', port: 1 },
      }),
    ).toEqual({ clean: 0, infected: 0, failed: 0 });
  });
});
