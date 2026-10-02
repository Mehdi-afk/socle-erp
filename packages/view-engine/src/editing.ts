// SPDX-License-Identifier: LGPL-3.0-only
//
// Editing a card of a form: which fields can be edited, how a stored value becomes the text of an
// input and back, and what is wrong with what the user typed. Pure, so that it is tested without any
// rendering. Amounts are typed in the currency's units and stored as integers of its smallest unit,
// through exact decimal arithmetic (never a floating-point multiplication).
import {
  emptyValue,
  isStoredMetadata,
  normalizeValue,
  type FieldDefinition,
} from '@socle/framework';

import type { Currency } from './format.js';
import { minorToDecimal } from './format.js';
import type { FormField } from './form-model.js';

/** What an input holds: text, or a boolean for a checkbox. */
export type Draft = string | boolean;

export type EditProblem =
  | { readonly code: 'required' }
  | { readonly code: 'integer' }
  | { readonly code: 'number' }
  | { readonly code: 'date' }
  | { readonly code: 'invalid' }
  | { readonly code: 'decimals'; readonly max: number };

export type Parsed =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly problem: EditProblem };

const EDITABLE_TYPES: ReadonlySet<string> = new Set([
  'char',
  'text',
  'integer',
  'decimal',
  'monetary',
  'boolean',
  'date',
  'selection',
  'many2one',
]);

/**
 * The user may edit this field in a form: it is stored (not computed), not marked read-only, not
 * confidential (those have their own flow), of a type that has an input, and, for an amount, its
 * currency is known.
 */
export function isEditable(field: FormField, currency: Currency | undefined): boolean {
  const { definition } = field;
  // A full local ORM registry also carries these protections; remote metadata uses readonly.
  const original: FieldDefinition = definition;
  if (
    field.readonly === true ||
    definition.readonly === true ||
    original.compute !== undefined ||
    original.related !== undefined ||
    definition.sensitive === true ||
    field.sensitive
  )
    return false;
  if (!isStoredMetadata(definition) || !EDITABLE_TYPES.has(definition.type)) return false;
  return (
    definition.type !== 'monetary' || (currency !== undefined && validDecimals(currency.decimals))
  );
}

// Intl's fraction-digit range also bounds padding for malformed currency metadata.
const validDecimals = (decimals: number): boolean =>
  Number.isInteger(decimals) && decimals >= 0 && decimals <= 100;

/** The text (or boolean) an input starts with. */
export function toDraft(
  definition: FieldDefinition,
  value: unknown,
  currency: Currency | undefined,
): Draft {
  if (definition.type === 'boolean') return value === true;
  if (value === null || value === undefined) return '';
  if (definition.type === 'monetary') {
    if (currency === undefined || !validDecimals(currency.decimals)) return '';
    return minorToDecimal(value as number | bigint | string, currency.decimals);
  }
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint'
    ? String(value)
    : '';
}

/** `12,50` or `12.50` → the integer of minor units, exactly; undefined if it has too many decimals. */
export function decimalToMinor(text: string, decimals: number): number | string | undefined {
  if (!validDecimals(decimals)) return undefined;
  const normal = decimalText(text.trim());
  if (normal === undefined) return undefined;
  const negative = normal.startsWith('-');
  const [whole = '', fraction = ''] = (negative ? normal.slice(1) : normal).split('.');
  const trimmed = fraction.replace(/0+$/, '');
  if (trimmed.length > decimals) return undefined;
  const units = BigInt(`${whole}${fraction.padEnd(decimals, '0').slice(0, decimals)}`);
  const signed = negative ? -units : units;
  return signed >= BigInt(Number.MIN_SAFE_INTEGER) && signed <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(signed)
    : signed.toString();
}

/** Parse the two digit runs independently, without backtracking over nested quantifiers. */
function decimalText(text: string): string | undefined {
  const normal = text.replace(',', '.');
  const unsigned = normal.startsWith('-') ? normal.slice(1) : normal;
  const parts = unsigned.split('.');
  return parts.length <= 2 && parts.every((part) => /^\d+$/.test(part)) ? normal : undefined;
}

/** A decimal's canonical spelling, without ever converting it to a floating-point number. */
function canonicalDecimal(text: string): string {
  const [whole = '', fraction = ''] = text.replace('-', '').split('.');
  const integral = whole.replace(/^0+(?=\d)/, '');
  const fractional = fraction.replace(/0+$/, '');
  const unsigned = `${integral}${fractional === '' ? '' : `.${fractional}`}`;
  return text.startsWith('-') && unsigned !== '0' ? `-${unsigned}` : unsigned;
}

function validated(field: FormField, value: unknown, problem: EditProblem): Parsed {
  try {
    return { ok: true, value: normalizeValue(field.name, field.definition, value) };
  } catch {
    return { ok: false, problem };
  }
}

/** What the user typed, as the value to store; or what is wrong with it. */
export function fromDraft(field: FormField, draft: Draft, currency: Currency | undefined): Parsed {
  const { definition } = field;
  if (!isEditable(field, currency)) return { ok: false, problem: { code: 'invalid' } };
  if (definition.type === 'boolean') return validated(field, draft, { code: 'invalid' });
  if (typeof draft !== 'string') return { ok: false, problem: { code: 'invalid' } };
  if (definition.required === true && draft.trim() === '') {
    return { ok: false, problem: { code: 'required' } };
  }
  // Whitespace belongs to prose; trimming every input silently rewrites unchanged notes.
  const text = definition.type === 'char' || definition.type === 'text' ? draft : draft.trim();
  if (text === '') {
    return { ok: true, value: emptyValue(definition) };
  }
  switch (definition.type) {
    case 'integer':
      return /^-?\d+$/.test(text) && Number.isSafeInteger(Number(text))
        ? { ok: true, value: Number(text) }
        : { ok: false, problem: { code: 'integer' } };
    case 'decimal': {
      const normal = decimalText(text);
      const places = definition.digits?.[1];
      if (normal === undefined) return { ok: false, problem: { code: 'number' } };
      const fraction = normal.split('.')[1]?.replace(/0+$/, '') ?? '';
      if (places !== undefined && fraction.length > places) {
        return { ok: false, problem: { code: 'decimals', max: places } };
      }
      return validated(field, canonicalDecimal(normal), { code: 'number' });
    }
    case 'monetary': {
      // isEditable already rejects an unknown currency; no guessed number of minor units.
      const decimals = currency?.decimals ?? 0;
      if (decimalText(text) === undefined) return { ok: false, problem: { code: 'number' } };
      const minor = decimalToMinor(text, decimals);
      if (minor === undefined) return { ok: false, problem: { code: 'decimals', max: decimals } };
      // The ORM accepts safe integer numbers only, even though conversion itself is exact above.
      return validated(field, minor, { code: 'number' });
    }
    case 'date':
      return validated(field, text, { code: 'date' });
    case 'many2one':
      // ViewDataSource identifiers are opaque strings (the ORM adapter validates UUIDs).
      return { ok: true, value: text };
    default:
      return validated(field, text, { code: 'invalid' });
  }
}

const same = (definition: FieldDefinition, a: unknown, b: unknown): boolean => {
  const emptyText = (value: unknown): unknown =>
    (definition.type === 'char' || definition.type === 'text') && value === '' ? null : value;
  const [left, right] = [
    emptyText(a) ?? emptyValue(definition),
    emptyText(b) ?? emptyValue(definition),
  ];
  if (left === null || right === null) return left === right;
  if (definition.type === 'decimal' && typeof left === 'string' && typeof right === 'string') {
    return canonicalDecimal(left) === canonicalDecimal(right);
  }
  return left === right;
};

/**
 * What to send to the server: only the fields whose value changed, or the first problem found
 * for each field that could not be understood.
 */
export function changesOf(
  fields: readonly FormField[],
  record: Readonly<Record<string, unknown>>,
  drafts: Readonly<Record<string, Draft>>,
  currencyOf: (field: FormField) => Currency | undefined,
): { readonly values: Record<string, unknown>; readonly problems: Record<string, EditProblem> } {
  const values: Record<string, unknown> = {};
  const problems: Record<string, EditProblem> = {};
  for (const field of fields) {
    const currency = currencyOf(field);
    if (!isEditable(field, currency) || !Object.hasOwn(drafts, field.name)) continue;
    const draft = drafts[field.name];
    if (draft === undefined) continue;
    const parsed = fromDraft(field, draft, currency);
    if (!parsed.ok) problems[field.name] = parsed.problem;
    else if (!same(field.definition, parsed.value, record[field.name]))
      values[field.name] = parsed.value;
  }
  return { values, problems };
}
