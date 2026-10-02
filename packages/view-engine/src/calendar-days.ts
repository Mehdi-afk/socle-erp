// SPDX-License-Identifier: LGPL-3.0-only
function calendarDate(day: string): Date {
  const date = new Date(`${day}T12:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== day
  )
    throw new RangeError('Invalid calendar date.');
  return date;
}

/** Calendar arithmetic at UTC noon preserves dates through daylight-saving transitions. */
export function addCalendarDays(day: string, amount: number): string {
  if (!Number.isSafeInteger(amount)) throw new RangeError('Invalid day offset.');
  const date = calendarDate(day);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

/** A Monday-first week, or a six-week month grid; no event times are invented. */
export function calendarDays(day: string, mode: 'week' | 'month'): readonly string[] {
  const date = calendarDate(day);
  if (mode === 'month') date.setUTCDate(1);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  const first = date.toISOString().slice(0, 10);
  return Array.from({ length: mode === 'month' ? 42 : 7 }, (_, index) =>
    addCalendarDays(first, index),
  );
}

export function moveCalendar(day: string, mode: 'week' | 'month', direction: -1 | 1): string {
  if (mode === 'week') return addCalendarDays(day, direction * 7);
  const date = calendarDate(day);
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + direction);
  return date.toISOString().slice(0, 10);
}
