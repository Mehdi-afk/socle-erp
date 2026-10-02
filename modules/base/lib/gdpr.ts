// SPDX-License-Identifier: LGPL-3.0-only
//
// GDPR tools for a person (res.partner): export of everything that refers to them, and
// anonymisation — refused while a legal obligation to keep a record about them runs (models
// declare it with `retention`), with the reason shown.
import {
  isStoredColumn,
  ValidationError,
  type Environment,
  type LocalizedText,
  type ModelMeta,
  type ModelRegistry,
} from '@socle/framework';

const PARTNER = 'res.partner';

/** Every stored many2one field pointing to a contact: `model.field`. */
export function partnerReferences(
  registry: ModelRegistry,
): { readonly model: string; readonly field: string }[] {
  const found: { model: string; field: string }[] = [];
  for (const model of registry.names()) {
    const meta = registry.get(model);
    if (meta.abstract) continue;
    for (const [field, definition] of meta.fields) {
      if (
        definition.type === 'many2one' &&
        definition.comodel === PARTNER &&
        isStoredColumn(definition)
      )
        found.push({ model, field });
    }
  }
  return found;
}

/** A legal obligation that prevents the anonymisation of a contact. */
export interface RetentionBlock {
  readonly model: string;
  readonly reason: LocalizedText;
  readonly count: number;
}

/** The first day still inside a retention of `years` years at `now` (ISO date). */
export function retentionStart(now: Date, years: number): string {
  const start = new Date(now.getTime());
  start.setUTCFullYear(start.getUTCFullYear() - years);
  return start.toISOString().slice(0, 10);
}

/**
 * The legal obligations that still apply to records referring to `partnerId`. `env` must see
 * every record (superuser): an obligation counts whoever may read the record.
 */
export async function retentionBlocks(
  env: Environment,
  partnerId: string,
  now: Date,
): Promise<RetentionBlock[]> {
  const blocks: RetentionBlock[] = [];
  for (const { model, field } of partnerReferences(env.registry)) {
    const retention = env.registry.get(model).retention;
    if (!retention) continue;
    const domain: unknown[] = [[field, '=', partnerId]];
    if (retention.years !== undefined && retention.dateField !== undefined) {
      domain.push([retention.dateField, '>=', retentionStart(now, retention.years)]);
    }
    const count = await env.model(model).searchCount(domain as never);
    if (count > 0) blocks.push({ model, reason: retention.reason, count });
  }
  return blocks;
}

/** Everything the user may read about a contact: their record and the records referring to them. @public */
export interface PersonalDataExport {
  readonly exportedAt: string;
  readonly partner: Record<string, unknown>;
  readonly related: Record<string, Record<string, unknown>[]>;
}

declare module '@socle/framework' {
  interface ModelFields {
    'res.partner': {
      gdprExport(): Promise<PersonalDataExport>;
      gdprAnonymize(): Promise<{ readonly anonymized: true }>;
    };
  }
}

/** Exports what `env` (the requesting user, with their rights) may read about `partnerId`. */
export async function exportPersonalData(
  env: Environment,
  partnerId: string,
): Promise<PersonalDataExport> {
  const [partner] = await env.model(PARTNER).browse([partnerId]).read();
  if (!partner) throw new ValidationError('Unknown contact.');
  const related: Record<string, Record<string, unknown>[]> = {};
  for (const { model, field } of partnerReferences(env.registry)) {
    if (model === PARTNER && field === 'id') continue;
    let records;
    try {
      records = await env.model(model).search([[field, '=', partnerId]]);
    } catch {
      continue; // A model the user may not read: not theirs to export.
    }
    if (records.length === 0) continue;
    related[`${model}.${field}`] = await records.read();
  }
  return { exportedAt: new Date().toISOString(), partner, related };
}

/**
 * The values that erase a contact: every stored text, date, binary or address value, the name
 * replaced by a placeholder, archived. The company it belongs to is kept (otherwise it would
 * become shared with every company), as are numbers and choices, which do not identify.
 */
export function anonymizedValues(meta: ModelMeta): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [field, definition] of meta.fields) {
    if (!isStoredColumn(definition) || definition.readonly === true || definition.related) continue;
    switch (definition.type) {
      case 'char':
      case 'text':
      case 'html':
      case 'binary':
      case 'date':
      case 'datetime':
      case 'json':
        values[field] = definition.required === true ? 'Anonymisé' : null;
        break;
      case 'many2one':
        if (definition.comodel !== 'res.company' && definition.required !== true)
          values[field] = null;
        break;
      default:
        break;
    }
  }
  values.name = 'Anonymisé';
  if (meta.fields.get('active')?.type === 'boolean') values.active = false;
  return values;
}

/** The text of a localized reason in the user's language (French otherwise). */
export function reasonText(reason: LocalizedText, lang: string): string {
  return (lang === 'en' ? reason.en : lang === 'ar' ? reason.ar : undefined) ?? reason.fr;
}
