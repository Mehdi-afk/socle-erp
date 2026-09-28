// SPDX-License-Identifier: LGPL-3.0-only
//
// Synchronisation bookkeeping on PostgreSQL (the SyncBackend of @socle/sync): registered
// devices, processed mutations, archive of losing versions, change stream by version.
// Every query runs as the system actor through the transaction's shared session, so the
// settings of the user's own queries are always restored before them.
import { importPublicKey, type JsonValue } from '@socle/crypto';
import type { ModelMeta, ModelRegistry } from '@socle/framework';
import type { DeviceInfo, SyncBackend } from '@socle/sync';
import { sql } from 'kysely';

import { identifier } from './naming.js';
import { FIELD_VERSIONS_COLUMN, SYNC_TABLES } from './schema.js';
import { SYSTEM_ACTOR, type PgSession } from './session.js';
import { createPgStorage } from './storage.js';
import type { Executor } from './database.js';

const T = SYNC_TABLES;

/** The synchronisation backend of one transaction, sharing its session with the ORM storage. */
export function createPgSyncBackend(session: PgSession, registry: ModelRegistry): SyncBackend {
  const db = session.executor;
  const system = createPgStorage(db, registry, session).as?.(SYSTEM_ACTOR);
  if (!system) throw new Error('The PostgreSQL storage must support acting users.');
  const asSystem = (): Promise<void> => session.actAs(SYSTEM_ACTOR);

  return {
    async device(deviceId) {
      await asSystem();
      const rows = await sql<{
        id: string;
        user_id: string;
        public_key: string;
        status: DeviceInfo['status'];
      }>`select id, user_id, public_key, status from ${sql.table(T.device)} where id = ${deviceId}`.execute(
        db,
      );
      const row = rows.rows[0];
      if (!row) return undefined;
      return {
        id: row.id,
        userId: row.user_id,
        publicKey: await importPublicKey(row.public_key),
        status: row.status,
      };
    },

    async touchDevice(deviceId) {
      await asSystem();
      await sql`update ${sql.table(T.device)} set last_seen_at = now() where id = ${deviceId}`.execute(
        db,
      );
    },

    async processed(mutationId) {
      await asSystem();
      const rows = await sql<{
        status: 'applied' | 'merged' | 'rejected';
        conflict: boolean;
        reason: string;
      }>`select status, conflict, reason from ${sql.table(T.mutation)} where mutation_id = ${mutationId}::uuid`.execute(
        db,
      );
      const row = rows.rows[0];
      return row
        ? { mutationId, status: row.status, conflict: row.conflict, reason: row.reason }
        : undefined;
    },

    async remember(mutation, result) {
      await asSystem();
      await sql`insert into ${sql.table(T.mutation)} (mutation_id, device_id, status, conflict, reason) values (${mutation.mutationId}::uuid, ${mutation.deviceId}, ${result.status}, ${result.conflict}, ${result.reason}) on conflict (mutation_id) do nothing`.execute(
        db,
      );
    },

    async remote(meta, id) {
      const table = sql.table(identifier(meta.table));
      await asSystem();
      const found = await sql<{
        versions: Record<string, number>;
      }>`select ${sql.id(FIELD_VERSIONS_COLUMN)} as versions from ${table} where id = ${id}::uuid`.execute(
        db,
      );
      const row = found.rows[0];
      if (!row) {
        const tombstone =
          await sql`select 1 from ${sql.table(T.tombstone)} where model = ${meta.name} and record_id = ${id}::uuid`.execute(
            db,
          );
        return { exists: false, deleted: tombstone.rows.length > 0, fieldVersions: {}, values: {} };
      }
      const fields = Object.keys(row.versions);
      const values = (await system.read(meta, [id], fields)).get(id) ?? {};
      return {
        exists: true,
        deleted: false,
        fieldVersions: row.versions,
        values: values as Record<string, JsonValue>,
      };
    },

    async archive(entry) {
      await asSystem();
      await sql`insert into ${sql.table(T.archive)} (model, record_id, side, mutation_id, device_id, user_id, reason, "values") values (${entry.model}, ${entry.recordId}::uuid, ${entry.side}, ${entry.mutationId}::uuid, ${entry.deviceId}, ${entry.userId}, ${entry.reason}, ${JSON.stringify(entry.values)}::jsonb)`.execute(
        db,
      );
    },

    async changes(models, cursor, limit) {
      if (models.length === 0) return [];
      await asSystem();
      const parts = models.map(
        (meta) =>
          sql`select ${meta.name}::text as model, id::text as id, version, false as deleted from ${sql.table(identifier(meta.table))} where version > ${cursor}`,
      );
      parts.push(
        sql`select model, record_id::text as id, version, true as deleted from ${sql.table(T.tombstone)} where version > ${cursor} and model = any(${models.map((meta) => meta.name)}::text[])`,
      );
      const rows = await sql<{
        model: string;
        id: string;
        version: number;
        deleted: boolean;
      }>`select * from (${sql.join(parts, sql` union all `)}) as changes order by version limit ${limit}`.execute(
        db,
      );
      return rows.rows;
    },

    async fieldVersions(meta: ModelMeta, ids) {
      if (ids.length === 0) return new Map();
      await asSystem();
      const rows = await sql<{
        id: string;
        versions: Record<string, number>;
      }>`select id, ${sql.id(FIELD_VERSIONS_COLUMN)} as versions from ${sql.table(identifier(meta.table))} where id = any(${[...ids]}::uuid[])`.execute(
        db,
      );
      return new Map(rows.rows.map((row) => [row.id, row.versions]));
    },
  };
}

/** Registers a device and its public key (base64url) for a user (§6.5, device registry). */
export async function registerDevice(
  db: Executor,
  device: { readonly id: string; readonly userId: string; readonly publicKey: string },
): Promise<void> {
  await importPublicKey(device.publicKey); // refuse a malformed key now, not at the first push
  await sql`insert into ${sql.table(T.device)} (id, user_id, public_key, status) values (${device.id}, ${device.userId}, ${device.publicKey}, 'active')`.execute(
    db,
  );
}

/** Revokes a device: its pushes are refused and it wipes its data at its next contact. */
export async function revokeDevice(db: Executor, deviceId: string): Promise<void> {
  await sql`update ${sql.table(T.device)} set status = 'revoked' where id = ${deviceId}`.execute(
    db,
  );
}

/** Status of a device for the client's `deviceAction` (unknown devices wipe too). */
export async function deviceStatus(
  db: Executor,
  deviceId: string,
): Promise<'active' | 'revoked' | 'unknown'> {
  const rows = await sql<{
    status: 'active' | 'revoked';
  }>`select status from ${sql.table(T.device)} where id = ${deviceId}`.execute(db);
  return rows.rows[0]?.status ?? 'unknown';
}
