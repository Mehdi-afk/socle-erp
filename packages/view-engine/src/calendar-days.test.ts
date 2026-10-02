// SPDX-License-Identifier: LGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { addCalendarDays, calendarDays, moveCalendar } from './calendar-days.js';

describe('calendar days', () => {
  it('keeps a Monday-first week across month, year and daylight-saving boundaries', () => {
    expect(calendarDays('2027-01-01', 'week')).toEqual([
      '2026-12-28',
      '2026-12-29',
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
      '2027-01-03',
    ]);
    expect(addCalendarDays('2026-03-28', 1)).toBe('2026-03-29');
    expect(addCalendarDays('2026-03-29', 1)).toBe('2026-03-30');
    expect(moveCalendar('2026-10-02', 'week', -1)).toBe('2026-09-25');
  });
  it('anchors month moves to day one and shows a full six-week grid', () => {
    expect(moveCalendar('2026-01-31', 'month', 1)).toBe('2026-02-01');
    expect(calendarDays('2026-02-01', 'month')).toHaveLength(42);
    expect(calendarDays('2026-02-01', 'month')[0]).toBe('2026-01-26');
  });
  it('rejects normalized invalid calendar dates', () => {
    expect(() => calendarDays('2026-02-30', 'month')).toThrow(RangeError);
    expect(() => addCalendarDays('2026-10-02', Number.NaN)).toThrow(RangeError);
  });
});
