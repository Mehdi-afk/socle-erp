// SPDX-License-Identifier: LGPL-3.0-only
//
// Numbering (Odoo's ir.sequence), per company. Two modes:
// - `standard`: a server counter that never blocks; a rolled-back transaction leaves a gap.
// - `no_gap`: the sequence row is locked until the end of the transaction and the counter is
//   part of it, so a rollback gives the number back: consecutive numbers, as legal numbering
//   requires (invoices, phase 3). Concurrent callers wait for each other.
// Numbers are only ever given by the server: offline, documents carry a draft reference.
import { defineModel, f } from '@socle/framework';

/** Calendar date of an instant in a time zone. */
export interface LocalDate {
  readonly year: string;
  readonly month: string;
  readonly day: string;
}

/**
 * The date of `instant` (ISO 8601) in the time zone `tz` (falls back to UTC for an unknown
 * zone).
 */
export function localDate(instant: string, tz: string): LocalDate {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
  );
  return { year: parts.year ?? '', month: parts.month ?? '', day: parts.day ?? '' };
}

/**
 * The text of a sequence number: `prefix` + number padded with zeros to `padding` digits +
 * `suffix`. Prefix and suffix may use `{YYYY}`, `{YY}`, `{MM}`, `{DD}`.
 * @throws {RangeError} for a negative or non-integer number
 */
export function formatSequence(
  parts: { readonly prefix: string; readonly suffix: string; readonly padding: number },
  number: number,
  date: LocalDate,
): string {
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new RangeError(`Invalid sequence number ${String(number)}.`);
  }
  const fill = (text: string): string =>
    text
      .replaceAll('{YYYY}', date.year)
      .replaceAll('{YY}', date.year.slice(-2))
      .replaceAll('{MM}', date.month)
      .replaceAll('{DD}', date.day);
  return `${fill(parts.prefix)}${String(number).padStart(Math.max(0, parts.padding), '0')}${fill(parts.suffix)}`;
}

export default defineModel({
  name: 'ir.sequence',
  description: { fr: 'Séquence', en: 'Sequence', ar: 'تسلسل' },
  mixins: ['company.scoped'],
  order: 'code',
  offline: { syncable: false },
  unique: [{ name: 'code_uniq', fields: ['code', 'companyId'] }],
  fields: {
    code: f.char({ required: true, index: true, label: { fr: 'Code', en: 'Code', ar: 'الرمز' } }),
    name: f.char({ label: { fr: 'Nom', en: 'Name', ar: 'الاسم' } }),
    prefix: f.char({ default: '', label: { fr: 'Préfixe', en: 'Prefix', ar: 'البادئة' } }),
    suffix: f.char({ default: '', label: { fr: 'Suffixe', en: 'Suffix', ar: 'اللاحقة' } }),
    padding: f.integer({ default: 5, label: { fr: 'Chiffres', en: 'Padding', ar: 'عدد الأرقام' } }),
    step: f.integer({ default: 1, label: { fr: 'Pas', en: 'Step', ar: 'الخطوة' } }),
    numberNext: f.integer({
      default: 1,
      label: { fr: 'Prochain numéro', en: 'Next number', ar: 'الرقم التالي' },
    }),
    implementation: f.selection(
      [
        ['standard', 'Standard'],
        ['no_gap', 'Sans trou'],
      ],
      { default: 'standard', label: { fr: 'Mode', en: 'Mode', ar: 'النمط' } },
    ),
    active: f.boolean({ default: true }),
  },
  serverMethods: (Base) =>
    class extends Base {
      /** The next number of this sequence, formatted. */
      async nextNumber(): Promise<string> {
        const sequence = this.ensureOne();
        await sequence.prefetch(['implementation']);
        let number: number;
        if (sequence.implementation === 'no_gap') {
          await sequence.lockForUpdate();
          await sequence.prefetch(['numberNext', 'step']);
          number = sequence.numberNext;
          await sequence.write({ numberNext: number + sequence.step });
        } else {
          await sequence.prefetch(['numberNext', 'step']);
          number = await this.env.nextValue(`ir.sequence:${sequence.id}`, {
            start: sequence.numberNext,
            step: sequence.step,
          });
        }
        await sequence.prefetch(['prefix', 'suffix', 'padding']);
        return formatSequence(
          {
            prefix: sequence.prefix ?? '',
            suffix: sequence.suffix ?? '',
            padding: sequence.padding,
          },
          number,
          localDate(new Date().toISOString(), this.env.user.tz),
        );
      }

      /**
       * The next number of the active sequence `code` of the current company (a sequence of
       * the company wins over a shared one).
       */
      async nextByCode(code: string): Promise<string> {
        const active = [
          ['code', '=', code],
          ['active', '=', true],
        ] as const;
        let chosen = await this.search([...active, ['companyId', '=', this.env.companyId]]);
        if (chosen.length === 0) chosen = await this.search([...active, ['companyId', '=', null]]);
        if (chosen.length === 0) throw new RangeError(`No active sequence "${code}".`);
        return chosen.browse([chosen.ids[0] as string]).nextNumber();
      }
    },
});
