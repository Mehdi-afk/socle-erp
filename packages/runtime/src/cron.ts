// SPDX-License-Identifier: LGPL-3.0-only
//
// Scheduled tasks (lot 2.1, `ir.cron`): when a task runs next. All instants are UTC. A task
// that could not run for a while (worker stopped) runs once, then resumes on its grid: missed
// occurrences are skipped, never replayed one after the other.

export type CronIntervalUnit = 'minutes' | 'hours' | 'days' | 'weeks' | 'months';

export interface CronInterval {
  /** Between 1 and 10 000. */
  readonly number: number;
  readonly unit: CronIntervalUnit;
}

const UNIT_MS: Readonly<Record<Exclude<CronIntervalUnit, 'months'>, number>> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 7 * 86_400_000,
};

/** True for an interval a task may use: a whole number of units from 1 to 10 000. */
export function isCronInterval(interval: CronInterval): boolean {
  return (
    Number.isSafeInteger(interval.number) &&
    interval.number >= 1 &&
    interval.number <= 10_000 &&
    (interval.unit === 'months' || Object.hasOwn(UNIT_MS, interval.unit))
  );
}

/**
 * `instant` plus `months` calendar months (UTC), the day kept or clamped to the end of the
 * month: 31 January + 1 month = 28 or 29 February.
 */
export function addMonths(instant: Date, months: number): Date {
  const year = instant.getUTCFullYear();
  const month = instant.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const result = new Date(instant.getTime());
  result.setUTCFullYear(year, month, Math.min(instant.getUTCDate(), lastDay));
  return result;
}

/**
 * The next run of a task due at `previous`, once it runs at `now`: the first instant of the
 * grid `previous + k × interval` (k ≥ 1) strictly after `now`. Months are counted from
 * `previous`, so a task on the 31st stays on the last day of shorter months.
 * @throws {RangeError} for an invalid interval or instant
 */
export function nextCallAfter(previous: string, interval: CronInterval, now: string): string {
  if (!isCronInterval(interval)) {
    throw new RangeError(`Invalid interval ${String(interval.number)} ${interval.unit}.`);
  }
  const start = new Date(previous);
  const current = new Date(now);
  if (Number.isNaN(start.getTime()) || Number.isNaN(current.getTime())) {
    throw new RangeError('Invalid instant.');
  }
  if (interval.unit !== 'months') {
    const step = UNIT_MS[interval.unit] * interval.number;
    const behind = current.getTime() - start.getTime();
    const k = behind < 0 ? 1 : Math.floor(behind / step) + 1;
    return new Date(start.getTime() + k * step).toISOString();
  }
  const months =
    (current.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    current.getUTCMonth() -
    start.getUTCMonth();
  let k = Math.max(1, Math.floor(months / interval.number));
  while (addMonths(start, k * interval.number) <= current) k += 1;
  return addMonths(start, k * interval.number).toISOString();
}
