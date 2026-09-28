// SPDX-License-Identifier: LGPL-3.0-only
//
// Loading of module data (framework `defineData`) inside the installation or upgrade
// transaction, through the ORM (constraints, computed fields and sync versions apply), with
// the external id of each record kept in `socle_external_id`.
import {
  isExternalRef,
  ValidationError,
  type Environment,
  type ModuleData,
} from '@socle/framework';
import { sql, type Transaction } from 'kysely';

import type { Tables } from './database.js';
import { EXTERNAL_ID_TABLE } from './schema.js';

interface ExternalIdRow {
  readonly model: string;
  readonly recordId: string;
  readonly noupdate: boolean;
}

/** What the loading did, for the report of the installation. */
export interface DataLoadResult {
  readonly created: number;
  readonly updated: number;
  /** `noupdate` records left as the administrator changed them. */
  readonly kept: number;
}

async function lookup(
  trx: Transaction<Tables>,
  externalId: string,
): Promise<ExternalIdRow | undefined> {
  const [module = '', name = ''] = externalId.split('.');
  const result = await sql<{
    model: string;
    record_id: string;
    noupdate: boolean;
  }>`select model, record_id, noupdate from ${sql.table(EXTERNAL_ID_TABLE)} where module = ${module} and name = ${name}`.execute(
    trx,
  );
  const row = result.rows[0];
  return row ? { model: row.model, recordId: row.record_id, noupdate: row.noupdate } : undefined;
}

/**
 * Loads the data of `module` in order: a record whose external id is unknown is created; a
 * known one is updated unless it is `noupdate` (or recreated if it was deleted meanwhile).
 * `env` must be a superuser environment of the transaction.
 * @throws {@link ValidationError} for an unknown reference, model or field
 */
export async function loadModuleData(
  trx: Transaction<Tables>,
  env: Environment,
  module: string,
  data: readonly ModuleData[],
): Promise<DataLoadResult> {
  let [created, updated, kept] = [0, 0, 0];

  const resolveRef = async (externalId: string, where: string): Promise<string> => {
    const found = await lookup(trx, externalId);
    if (!found) throw new ValidationError(`${where}: unknown reference "${externalId}".`);
    return found.recordId;
  };

  for (const set of data) {
    if (!env.registry.has(set.model))
      throw new ValidationError(`Data of "${module}": unknown model "${set.model}".`);
    const meta = env.registry.get(set.model);
    for (const record of set.records) {
      const externalId = `${module}.${record.id}`;
      const values: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(record.values)) {
        const definition = meta.fields.get(field);
        if (!definition)
          throw new ValidationError(`Data "${externalId}": unknown field "${set.model}.${field}".`);
        if (isExternalRef(value)) values[field] = await resolveRef(value.$ref, `"${externalId}"`);
        else if (Array.isArray(value) && value.some(isExternalRef)) {
          values[field] = await Promise.all(
            value.map((item: unknown) =>
              isExternalRef(item) ? resolveRef(item.$ref, `"${externalId}"`) : item,
            ),
          );
        } else values[field] = value;
      }

      const known = await lookup(trx, externalId);
      if (known && known.model !== set.model) {
        throw new ValidationError(
          `Data "${externalId}" was a "${known.model}" and is now a "${set.model}".`,
        );
      }
      const exists =
        known !== undefined &&
        (await env.model(set.model).searchCount([['id', '=', known.recordId]])) === 1;
      if (known && exists) {
        if (known.noupdate) {
          kept += 1;
          continue;
        }
        await env.model(set.model).browse([known.recordId]).write(values);
        updated += 1;
        continue;
      }
      const recordId = (await env.model(set.model).create(values)).ids[0] as string;
      await sql`insert into ${sql.table(EXTERNAL_ID_TABLE)} (module, name, model, record_id, noupdate) values (${module}, ${record.id}, ${set.model}, ${recordId}::uuid, ${set.noupdate}) on conflict (module, name) do update set record_id = excluded.record_id, noupdate = excluded.noupdate`.execute(
        trx,
      );
      created += 1;
    }
    await env.flush();
  }
  return { created, updated, kept };
}

/**
 * The records loaded by `module` in models it does not own, deleted at its uninstallation
 * (records of its own models disappear with their tables), and its external ids.
 */
export async function unloadModuleData(
  trx: Transaction<Tables>,
  env: Environment,
  module: string,
): Promise<void> {
  const rows = await sql<{
    model: string;
    record_id: string;
  }>`select model, record_id from ${sql.table(EXTERNAL_ID_TABLE)} where module = ${module}`.execute(
    trx,
  );
  for (const row of rows.rows) {
    if (!env.registry.has(row.model)) continue;
    const records = await env.model(row.model).search([['id', '=', row.record_id]]);
    if (records.ids.length > 0) await records.unlink();
  }
  await env.flush();
  await sql`delete from ${sql.table(EXTERNAL_ID_TABLE)} where module = ${module}`.execute(trx);
}
