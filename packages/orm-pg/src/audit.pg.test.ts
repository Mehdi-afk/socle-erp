// SPDX-License-Identifier: LGPL-3.0-only
//
// The audit journal on a real PostgreSQL: a chain that detects any change made afterwards.
import { buildModelRegistry } from '@socle/framework';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { applySchema } from './apply.js';
import { appendAudit, verifyAudit, type AuditEntry } from './audit.js';
import type { Executor } from './database.js';
import { useTestDatabases } from './test-support.js';

const databases = useTestDatabases();
const empty = buildModelRegistry([], { side: 'server' });

const entry = (n: number, kind = 'write'): AuditEntry => ({
  at: `2026-09-28T10:00:0${String(n % 10)}.000Z`,
  userId: 'alice',
  kind,
  model: 'res.partner',
  recordIds: [`0190a000-0000-7000-8000-00000000000${String(n % 10)}`],
  details: { fields: ['name'], su: false },
});

async function journal(): Promise<Executor> {
  const db = await databases.create();
  await applySchema(db, empty);
  await db.transaction().execute((trx) => appendAudit(trx, [entry(1), entry(2), entry(3)]));
  await db.transaction().execute((trx) => appendAudit(trx, [entry(4, 'login')]));
  return db;
}

describe('audit journal', () => {
  it('chains every entry to the previous one', async () => {
    const db = await journal();
    expect(await verifyAudit(db)).toEqual({ ok: true, count: 4 });
    // Verified in small batches too.
    expect(await verifyAudit(db, 2)).toEqual({ ok: true, count: 4 });
  });

  it('detects a changed, a removed and an inserted entry', async () => {
    const changed = await journal();
    await sql`update socle_audit set details = '{"fields":["email"],"su":false}' where seq = 2`.execute(
      changed,
    );
    expect(await verifyAudit(changed)).toMatchObject({ ok: false, seq: 2, count: 1 });

    const removed = await journal();
    await sql`delete from socle_audit where seq = 3`.execute(removed);
    expect(await verifyAudit(removed)).toMatchObject({ ok: false, seq: 4, reason: /missing/ });

    const inserted = await journal();
    await sql`update socle_audit set seq = seq + 10 where seq >= 3`.execute(inserted);
    await sql`insert into socle_audit (seq, at, kind, record_ids, details, prev_hash, hash) values (3, now(), 'forged', '[]', '{}', 'x', 'y')`.execute(
      inserted,
    );
    expect(await verifyAudit(inserted)).toMatchObject({ ok: false, seq: 3 });
  });

  it('keeps the chain under concurrent writers and forgets rolled-back entries', async () => {
    const db = await journal();
    await Promise.all(
      [5, 6, 7, 8].map((n) =>
        db.transaction().execute((trx) => appendAudit(trx, [entry(n), entry(n + 10)])),
      ),
    );
    await expect(
      db.transaction().execute(async (trx) => {
        await appendAudit(trx, [entry(9)]);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(await verifyAudit(db)).toEqual({ ok: true, count: 12 });
  });
});
