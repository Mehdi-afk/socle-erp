// SPDX-License-Identifier: LGPL-3.0-only
//
// The words of a view: labels come from the models and the views in up to three languages (French
// is mandatory, English and Arabic optional); when a label is missing, a readable one is made from
// the technical name.
import type { LocalizedText } from '@socle/framework';

/**
 * The text in the user's language: the exact tag (`ar-DZ`), then the language (`ar`), then
 * English, then French (always there). `fallback` when there is no text at all.
 */
export function resolveText(
  text: LocalizedText | undefined,
  language: string,
  fallback = '',
): string {
  if (text === undefined) return fallback;
  const table = text as unknown as Readonly<Record<string, string | undefined>>;
  const tag = language.trim().toLowerCase();
  const base = tag.split(/[-_]/)[0] ?? '';
  for (const candidate of [tag, base, 'en', 'fr']) {
    const found = Object.hasOwn(table, candidate) ? table[candidate] : undefined;
    if (found !== undefined && found !== '') return found;
  }
  return fallback;
}

/**
 * A label made from a technical field name: `stateId` → "State", `companyRegistry` → "Company
 * registry", `street2` → "Street 2". Relations lose their `Id` / `Ids` suffix.
 */
export function humanize(name: string): string {
  const stripped = name.replace(/(Ids?|_ids?)$/, '') || name;
  const words = stripped
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
