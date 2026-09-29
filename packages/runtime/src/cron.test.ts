// SPDX-License-Identifier: LGPL-3.0-only
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { addMonths, isCronInterval, nextCallAfter, type CronInterval } from './cron.js';

const MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000, weeks: 604_800_000 } as const;

describe('scheduled task intervals', () => {
  it('accept whole numbers of units from 1 to 10 000 only', () => {
    expect(isCronInterval({ number: 1, unit: 'days' })).toBe(true);
    expect(isCronInterval({ number: 10_000, unit: 'months' })).toBe(true);
    expect(isCronInterval({ number: 0, unit: 'days' })).toBe(false);
    expect(isCronInterval({ number: 1.5, unit: 'hours' })).toBe(false);
    expect(isCronInterval({ number: 10_001, unit: 'minutes' })).toBe(false);
    expect(isCronInterval({ number: 1, unit: 'seconds' as never })).toBe(false);
    expect(() => nextCallAfter('2026-01-01T00:00:00Z', { number: 0, unit: 'days' }, '')).toThrow(
      RangeError,
    );
    expect(() =>
      nextCallAfter('not a date', { number: 1, unit: 'days' }, '2026-01-01T00:00:00Z'),
    ).toThrow(RangeError);
  });

  it('add calendar months, clamped to the end of shorter months', () => {
    const at = (iso: string) => new Date(iso);
    expect(addMonths(at('2026-01-31T09:30:00Z'), 1).toISOString()).toBe('2026-02-28T09:30:00.000Z');
    expect(addMonths(at('2028-01-31T09:30:00Z'), 1).toISOString()).toBe('2028-02-29T09:30:00.000Z');
    expect(addMonths(at('2026-11-30T00:00:00Z'), 3).toISOString()).toBe('2027-02-28T00:00:00.000Z');
    expect(addMonths(at('2026-05-15T00:00:00Z'), 12).toISOString()).toBe(
      '2027-05-15T00:00:00.000Z',
    );
  });
});

describe('next run of a scheduled task', () => {
  it('runs once after a pause, then resumes on its grid', () => {
    const daily: CronInterval = { number: 1, unit: 'days' };
    expect(nextCallAfter('2026-03-01T02:00:00Z', daily, '2026-03-01T02:00:05Z')).toBe(
      '2026-03-02T02:00:00.000Z',
    );
    // The worker was stopped for ten days: one run now, the next one tomorrow at 2 am.
    expect(nextCallAfter('2026-03-01T02:00:00Z', daily, '2026-03-11T09:00:00Z')).toBe(
      '2026-03-12T02:00:00.000Z',
    );
    // Exactly on the grid: strictly after now.
    expect(nextCallAfter('2026-03-01T02:00:00Z', daily, '2026-03-02T02:00:00Z')).toBe(
      '2026-03-03T02:00:00.000Z',
    );
  });

  it('keeps a monthly task on the last day of short months', () => {
    const monthly: CronInterval = { number: 1, unit: 'months' };
    expect(nextCallAfter('2026-01-31T22:00:00Z', monthly, '2026-01-31T22:00:01Z')).toBe(
      '2026-02-28T22:00:00.000Z',
    );
    // Counted from the original date: March 31st, not March 28th.
    expect(nextCallAfter('2026-01-31T22:00:00Z', monthly, '2026-03-01T00:00:00Z')).toBe(
      '2026-03-31T22:00:00.000Z',
    );
    expect(
      nextCallAfter('2026-01-15T00:00:00Z', { number: 3, unit: 'months' }, '2026-09-20T00:00:00Z'),
    ).toBe('2026-10-15T00:00:00.000Z');
  });

  const instant = fc
    .integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2100, 0, 1) })
    .map((ms) => new Date(ms).toISOString());

  it('gives the first grid instant strictly after now (fixed units)', () => {
    fc.assert(
      fc.property(
        instant,
        fc.integer({ min: 0, max: 5 * 366 * 86_400_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.constantFrom('minutes', 'hours', 'days', 'weeks' as const),
        (previous, delay, number, unit) => {
          const now = new Date(Date.parse(previous) + delay).toISOString();
          const next = Date.parse(nextCallAfter(previous, { number, unit }, now));
          const step = MS[unit] * number;
          expect(next).toBeGreaterThan(Date.parse(now));
          expect((next - Date.parse(previous)) % step).toBe(0);
          expect(next - step).toBeLessThanOrEqual(Math.max(Date.parse(now), Date.parse(previous)));
        },
      ),
    );
  });

  it('gives the first grid instant strictly after now (months)', () => {
    fc.assert(
      fc.property(
        instant,
        fc.integer({ min: 0, max: 5 * 366 * 86_400_000 }),
        fc.integer({ min: 1, max: 24 }),
        (previous, delay, number) => {
          const now = new Date(Date.parse(previous) + delay).toISOString();
          const next = nextCallAfter(previous, { number, unit: 'months' }, now);
          expect(Date.parse(next)).toBeGreaterThan(Date.parse(now));
          // On the grid, and the previous grid point is not after now.
          const grid = (k: number) => addMonths(new Date(previous), k * number);
          let k = 1;
          while (k < 100 && grid(k).toISOString() !== next) {
            expect(grid(k) <= new Date(now)).toBe(true);
            k += 1;
          }
          expect(grid(k).toISOString()).toBe(next);
        },
      ),
    );
  });
});
