// SPDX-License-Identifier: LGPL-3.0-only
//
// Antivirus scanning of new attachments (lot 2.1): the attachments still "pending" are taken
// in small batches (FOR UPDATE SKIP LOCKED: several workers never scan the same file), read
// from S3, scanned by clamd and marked clean or infected. When clamd cannot scan a file, it
// stays pending and blocked; after `maxAttempts` failures it is marked "error", still blocked.
import {
  buildSecurityPolicy,
  createAccessControl,
  createEnvironment,
  type AuditEvent,
  type ModelRegistry,
  type SecurityPolicy,
} from '@socle/framework';
import { appendAudit, auditEntry, createPgStorage, type Executor } from '@socle/orm-pg';
import { ClamavError, scanWithClamav, type ClamavConfig, type S3Client } from '@socle/runtime';
import { sql } from 'kysely';

export interface ScanOptions {
  readonly db: Executor;
  readonly registry: ModelRegistry;
  readonly security?: SecurityPolicy | undefined;
  readonly s3: S3Client;
  readonly clamav: ClamavConfig;
  /** Files per batch (default 10). */
  readonly batch?: number | undefined;
  /** Failures before a file is marked "error" (default 5). */
  readonly maxAttempts?: number | undefined;
}

export interface ScanReport {
  readonly clean: number;
  readonly infected: number;
  /** Could not be scanned this time (still pending, or now "error"). */
  readonly failed: number;
}

/** Scans one batch of pending attachments of a tenant; returns what it did. */
export async function scanPendingAttachments(options: ScanOptions): Promise<ScanReport> {
  if (!options.registry.has('ir.attachment')) return { clean: 0, infected: 0, failed: 0 };
  const maxAttempts = options.maxAttempts ?? 5;
  return options.db.transaction().execute(async (trx) => {
    const events: AuditEvent[] = [];
    const env = createEnvironment({
      registry: options.registry,
      storage: createPgStorage(trx, options.registry),
      user: { id: 'worker', groupIds: [], companyIds: [], companyId: null, lang: 'fr', tz: 'UTC' },
      access: createAccessControl(
        options.security ?? buildSecurityPolicy([], () => false),
        options.registry,
      ),
      audit: { record: (event) => events.push(event) },
    }).sudo('antivirus scan of attachments');

    const pending = await sql<{
      id: string;
      store_key: string;
      scan_attempts: number | null;
    }>`select id, store_key, scan_attempts from ir_attachment where scan_status = 'pending' order by created_at limit ${options.batch ?? 10} for update skip locked`.execute(
      trx,
    );
    let [clean, infected, failed] = [0, 0, 0];
    for (const row of pending.rows) {
      const record = env.model('ir.attachment').browse([row.id]);
      try {
        const result = await scanWithClamav(options.clamav, await options.s3.get(row.store_key));
        await record.write({
          scanStatus: result.status,
          scanSignature: result.status === 'infected' ? result.signature : null,
          scannedAt: new Date().toISOString(),
        });
        if (result.status === 'clean') clean += 1;
        else infected += 1;
      } catch (error) {
        if (!(error instanceof ClamavError) && !(error instanceof Error)) throw error;
        const attempts = (row.scan_attempts ?? 0) + 1;
        await record.write({
          scanAttempts: attempts,
          ...(attempts >= maxAttempts ? { scanStatus: 'error' } : {}),
        });
        failed += 1;
      }
    }
    await env.flush();
    await appendAudit(trx, events.map(auditEntry));
    return { clean, infected, failed };
  });
}
