// SPDX-License-Identifier: LGPL-3.0-only
//
// Database snapshots taken before every installation, upgrade or uninstallation
// (ARCHITECTURE.md §4.7). A snapshot is a copy of the tenant database made by PostgreSQL itself
// (`CREATE DATABASE … TEMPLATE`): no external tool, and restoring is the reverse copy. The copy
// needs the tenant database to have no open session: sessions are closed first (the caller
// puts the tenant in maintenance).
import { randomBytes } from 'node:crypto';

import { sql } from 'kysely';
import pg from 'pg';
import { z } from 'zod';

import type { Executor } from './database.js';
import { SchemaError } from './errors.js';
import { identifier } from './naming.js';

/** Why the snapshot was taken (Bio Réactifs pattern: `avant-installation`, …). */
export type SnapshotLabel =
  'avant_installation' | 'avant_mise_a_jour' | 'avant_desinstallation' | 'avant_import' | 'manuel';

export interface SnapshotRef {
  /** Name of the database holding the copy. */
  readonly name: string;
  /** The tenant database it copies. */
  readonly database: string;
  readonly label: SnapshotLabel;
  /** ISO 8601 UTC. */
  readonly createdAt: string;
}

export interface SnapshotStore {
  create(label: SnapshotLabel): Promise<SnapshotRef>;
  /** Replaces the tenant database with the snapshot (every session to it is closed). */
  restore(snapshot: SnapshotRef): Promise<void>;
  /** Snapshots of the tenant database, newest first. */
  list(): Promise<SnapshotRef[]>;
  drop(snapshot: SnapshotRef): Promise<void>;
}

const PREFIX = 'snap_';
const OBJECT_IN_USE = '55006';
const ATTEMPTS = 5;

const comment = z.object({
  socleSnapshot: z.literal(1),
  database: z.string(),
  label: z.enum([
    'avant_installation',
    'avant_mise_a_jour',
    'avant_desinstallation',
    'avant_import',
    'manuel',
  ]),
  createdAt: z.iso.datetime(),
});

/**
 * Snapshots of `database`, managed through `admin`: a pool on another database of the same
 * server (usually `postgres`), with the right to create databases.
 */
export function createTemplateSnapshots(admin: Executor, database: string): SnapshotStore {
  const tenant = identifier(database);

  const closeSessions = async (name: string): Promise<void> => {
    await sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${name} and pid <> pg_backend_pid()`.execute(
      admin,
    );
  };

  /** Copies `source` into a new database `target`, retrying while a session reconnects. */
  const copy = async (source: string, target: string): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      await closeSessions(source);
      try {
        await sql`create database ${sql.id(target)} template ${sql.id(source)}`.execute(admin);
        return;
      } catch (error) {
        const busy = error instanceof pg.DatabaseError && error.code === OBJECT_IN_USE;
        if (!busy || attempt === ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }
  };

  const store: SnapshotStore = {
    async create(label) {
      const createdAt = new Date().toISOString();
      const stamp = createdAt.replace(/\D/g, '').slice(0, 17);
      const name = identifier(`${PREFIX}${stamp}_${randomBytes(4).toString('hex')}`);
      await copy(tenant, name);
      const ref: SnapshotRef = { name, database: tenant, label, createdAt };
      // COMMENT takes no bound parameter: the literal is built from validated values only.
      const text = JSON.stringify({ socleSnapshot: 1, database: tenant, label, createdAt });
      await sql`comment on database ${sql.id(name)} is ${sql.lit(text)}`.execute(admin);
      return ref;
    },

    async restore(snapshot) {
      const known = (await store.list()).some((ref) => ref.name === snapshot.name);
      if (!known) throw new SchemaError(`Unknown snapshot "${snapshot.name}" of "${tenant}".`);
      // Copy first under a temporary name: the tenant database is only replaced once the copy
      // succeeded, so a failed restore never leaves the tenant without a database.
      const staging = identifier(`restore_${randomBytes(8).toString('hex')}`);
      await copy(identifier(snapshot.name), staging);
      try {
        await sql`drop database if exists ${sql.id(tenant)} with (force)`.execute(admin);
      } catch (error) {
        await sql`drop database if exists ${sql.id(staging)}`.execute(admin);
        throw error;
      }
      await sql`alter database ${sql.id(staging)} rename to ${sql.id(tenant)}`.execute(admin);
    },

    async list() {
      const result = await sql<{
        name: string;
        comment: string | null;
      }>`select datname as name, shobj_description(oid, 'pg_database') as comment from pg_database where starts_with(datname, ${PREFIX})`.execute(
        admin,
      );
      const refs: SnapshotRef[] = [];
      for (const row of result.rows) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.comment ?? '');
        } catch {
          continue;
        }
        const meta = comment.safeParse(parsed);
        if (meta.success && meta.data.database === tenant) {
          refs.push({
            name: row.name,
            database: tenant,
            label: meta.data.label,
            createdAt: meta.data.createdAt,
          });
        }
      }
      return refs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    },

    async drop(snapshot) {
      const known = (await store.list()).some((ref) => ref.name === snapshot.name);
      if (!known) throw new SchemaError(`Unknown snapshot "${snapshot.name}" of "${tenant}".`);
      await sql`drop database ${sql.id(identifier(snapshot.name))} with (force)`.execute(admin);
    },
  };
  return store;
}
