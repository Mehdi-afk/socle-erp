// SPDX-License-Identifier: LGPL-3.0-only
//
// How a value is written on screen, by field type, in the user's language and time zone. Numbers,
// dates and money go through `Intl`: nothing is formatted by hand. Money is an integer of the
// currency's smallest unit and is moved to a decimal string before it is shown, never through a
// floating-point division.
import type { FieldDefinition } from '@socle/framework';

export interface FormatContext {
  /** BCP 47 tag: `fr`, `en`, `ar`, `ar-DZ`… */
  readonly language: string;
  /** IANA name, e.g. `Africa/Algiers`. */
  readonly timeZone: string;
  /** The words for a true and a false value. */
  readonly yes: string;
  readonly no: string;
}

/** What is needed to show an amount of money. */
export interface Currency {
  /** ISO 4217 code, e.g. `DZD`. */
  readonly code: string;
  /** Number of decimals of the currency (0 for `JPY`, 2 for `EUR`, 3 for `TND`). */
  readonly decimals: number;
}

export interface FormatExtras {
  /** The display name of the record a many2one points to. */
  readonly displayName?: string | undefined;
  /** The currency of a monetary value. */
  readonly currency?: Currency | undefined;
}

/**
 * An integer amount in minor units as an exact decimal string: (12345, 2) → "123.45",
 * (-5, 2) → "-0.05", (7, 0) → "7".
 * @throws {RangeError} for a value that is not an integer
 */
export function minorToDecimal(minor: number | bigint | string, decimals: number): string {
  let units: bigint;
  try {
    units = typeof minor === 'bigint' ? minor : BigInt(minor);
  } catch {
    throw new RangeError(`Not an integer amount: ${String(minor)}.`);
  }
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);
  return `${negative ? '-' : ''}${whole}${decimals > 0 ? `.${fraction}` : ''}`;
}

const isBlank = (value: unknown): boolean => value === null || value === undefined || value === '';

function safeFormatter<T>(make: () => T, fallback: () => T): T {
  try {
    return make();
  } catch {
    return fallback();
  }
}

/** The text of a value for display; an empty string for "no value". */
export function formatValue(
  definition: FieldDefinition,
  value: unknown,
  context: FormatContext,
  extras: FormatExtras = {},
): string {
  if (definition.type === 'boolean') {
    if (value === null || value === undefined) return '';
    return value === true ? context.yes : context.no;
  }
  if (definition.type === 'many2one') return extras.displayName ?? '';
  if (isBlank(value)) return '';
  switch (definition.type) {
    case 'char':
    case 'text':
    case 'html':
    case 'reference':
      return String(value);
    case 'integer': {
      const number = Number(value);
      return Number.isFinite(number)
        ? new Intl.NumberFormat(context.language, { maximumFractionDigits: 0 }).format(number)
        : String(value);
    }
    case 'decimal': {
      const places = definition.digits?.[1] ?? 2;
      return new Intl.NumberFormat(context.language, {
        minimumFractionDigits: places,
        maximumFractionDigits: places,
      }).format(String(value) as unknown as number);
    }
    case 'monetary': {
      const currency = extras.currency;
      if (currency === undefined) return String(value);
      const amount = minorToDecimal(value as number | bigint | string, currency.decimals);
      const format = safeFormatter(
        () =>
          new Intl.NumberFormat(context.language, {
            style: 'currency',
            currency: currency.code,
            minimumFractionDigits: currency.decimals,
            maximumFractionDigits: currency.decimals,
          }),
        () =>
          new Intl.NumberFormat(context.language, {
            minimumFractionDigits: currency.decimals,
            maximumFractionDigits: currency.decimals,
          }),
      );
      return format.format(amount as unknown as number);
    }
    case 'date': {
      // A date has no time zone: showing it in another one would move it by a day.
      const date = new Date(`${String(value)}T00:00:00Z`);
      return Number.isNaN(date.getTime())
        ? String(value)
        : new Intl.DateTimeFormat(context.language, {
            dateStyle: 'medium',
            timeZone: 'UTC',
          }).format(date);
    }
    case 'datetime': {
      const instant = new Date(String(value));
      if (Number.isNaN(instant.getTime())) return String(value);
      const format = safeFormatter(
        () =>
          new Intl.DateTimeFormat(context.language, {
            dateStyle: 'medium',
            timeStyle: 'short',
            timeZone: context.timeZone,
          }),
        () =>
          new Intl.DateTimeFormat(context.language, {
            dateStyle: 'medium',
            timeStyle: 'short',
            timeZone: 'UTC',
          }),
      );
      return format.format(instant);
    }
    case 'selection': {
      const found = definition.selection?.find(([key]) => key === value);
      return found ? found[1] : String(value);
    }
    case 'one2many':
    case 'many2many':
      return Array.isArray(value) ? String(value.length) : '';
    case 'binary':
      return '';
    case 'json':
      return JSON.stringify(value);
  }
}
