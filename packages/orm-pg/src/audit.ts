// SPDX-License-Identifier: LGPL-3.0-only
//
// The audit journal (ARCHITECTURE.md §9.3, lot 2.1 `ir.audit`): who read sensitive data,
// changed records, signed in, changed rights, installed modules — chained by hash. Each entry
// carries the hash of the previous one, so changing, removing or inserting an entry afterwards
// breaks the chain, and `verifyAudit` (`socle audit verify`) finds where.
// A technical table, not an ORM model: the ORM itself can neither change nor delete it.
import { canonicalBytes, sha256, type JsonValue } from '@socle/crypto';
import type { AuditEvent } from '@socle/framework';
import { sql } from 'kysely';

import type { Executor } from './database.js';
import { AUDIT_TABLE } from './schema.js';

/** Serialises the writers of the journal (transaction-level advisory lock). */
const AUDIT_LOCK = 0x736f636c02;

/** One journal entry, as appended. */
export interface AuditEntry {
  /** ISO 8601 UTC, millisecond precision. */
  readonly at: string;
  /** Acting user; null for the system or an unknown user (failed sign-in). */
  readonly userId: string | null;
  /** e.g. `write`, `read_sensitive`, `login`, `login_failed`, `module.install`. */
  readonly kind: string;
  readonly model: string | null;
  readonly recordIds: readonly string[];
  readonly details: Readonly<Record<string, JsonValue>>;
}

/** A journal entry as stored, with its place in the chain. */
export interface AuditRecord extends AuditEntry {
  readonly seq: number;
  readonly prevHash: string;
  readonly hash: string;
}

/** The entry of an ORM audit event. */
export function auditEntry(event: AuditEvent): AuditEntry {
  switch (event.type) {
    case 'sudo':
      return {
        at: event.at,
        userId: event.userId,
        kind: 'sudo',
        model: null,
        recordIds: [],
        details: { reason: event.reason },
      };
    case 'read_sensitive':
      return {
        at: event.at,
        userId: event.userId,
        kind: event.type,
        model: event.model,
        recordIds: [...event.ids],
        details: { fields: [...event.fields] },
      };
    default:
      return {
        at: event.at,
        userId: event.userId,
        kind: event.type,
        model: event.model,
        recordIds: [...event.ids],
        details: { fields: [...event.fields], su: event.su },
      };
  }
}

function hashOf(entry: AuditEntry, seq: number, prevHash: string): Promise<string> {
  return sha256(
    canonicalBytes({
      seq,
      at: entry.at,
      userId: entry.userId,
      kind: entry.kind,
      model: entry.model,
      recordIds: [...entry.recordIds],
      details: { ...entry.details },
      prevHash,
    }),
  );
}

/**
 * Appends entries at the end of the chain, inside the caller's transaction (they are rolled
 * back with it). Concurrent writers wait for each other until commit.
 */
export async function appendAudit(db: Executor, entries: readonly AuditEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await sql`select pg_advisory_xact_lock(${AUDIT_LOCK})`.execute(db);
  const last = await sql<{
    seq: string;
    hash: string;
  }>`select seq, hash from ${sql.table(AUDIT_TABLE)} order by seq desc limit 1`.execute(db);
  let seq = Number(last.rows[0]?.seq ?? 0);
  let prevHash = last.rows[0]?.hash ?? '';
  for (const entry of entries) {
    seq += 1;
    const hash = await hashOf(entry, seq, prevHash);
    await sql`insert into ${sql.table(AUDIT_TABLE)} (seq, at, user_id, kind, model, record_ids, details, prev_hash, hash) values (${seq}, ${entry.at}::timestamptz, ${entry.userId}, ${entry.kind}, ${entry.model}, ${JSON.stringify(entry.recordIds)}::jsonb, ${JSON.stringify(entry.details)}::jsonb, ${prevHash}, ${hash})`.execute(
      db,
    );
    prevHash = hash;
  }
}

/** The outcome of a verification of the whole chain. */
export type AuditVerification =
  | { readonly ok: true; readonly count: number }
  | { readonly ok: false; readonly count: number; readonly seq: number; readonly reason: string };

/**
 * Recomputes the whole chain: every entry must follow the previous one (consecutive numbers,
 * previous hash) and hash to its stored value.
 */
export async function verifyAudit(db: Executor, batch = 1000): Promise<AuditVerification> {
  let expectedSeq = 1;
  let prevHash = '';
  for (;;) {
    const rows = await sql<{
      seq: string;
      at: string;
      user_id: string | null;
      kind: string;
      model: string | null;
      record_ids: string[];
      details: Record<string, JsonValue>;
      prev_hash: string;
      hash: string;
    }>`select seq, at, user_id, kind, model, record_ids, details, prev_hash, hash from ${sql.table(AUDIT_TABLE)} where seq >= ${expectedSeq} order by seq limit ${batch}`.execute(
      db,
    );
    if (rows.rows.length === 0) return { ok: true, count: expectedSeq - 1 };
    for (const row of rows.rows) {
      const seq = Number(row.seq);
      const fail = (reason: string): AuditVerification => ({
        ok: false,
        count: expectedSeq - 1,
        seq,
        reason,
      });
      if (seq !== expectedSeq) return fail(`entry ${String(expectedSeq)} is missing`);
      if (row.prev_hash !== prevHash) return fail('the link to the previous entry is broken');
      const hash = await hashOf(
        {
          at: row.at,
          userId: row.user_id,
          kind: row.kind,
          model: row.model,
          recordIds: row.record_ids,
          details: row.details,
        },
        seq,
        prevHash,
      );
      // Hashes are public (stored in clear next to the entry): no secret is compared here.
      // eslint-disable-next-line security/detect-possible-timing-attacks
      if (hash !== row.hash) return fail('the entry was changed after it was written');
      prevHash = row.hash;
      expectedSeq += 1;
    }
  }
}
