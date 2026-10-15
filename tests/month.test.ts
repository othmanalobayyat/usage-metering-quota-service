import { afterEach, describe, expect, it } from 'vitest';
import type { Clock } from '../src/lib/clock.js';
import { toUtcMonth } from '../src/lib/month.js';

describe('toUtcMonth', () => {
  it('returns the first day of the month as YYYY-MM-01', () => {
    expect(toUtcMonth(new Date('2026-10-15T12:34:56Z'))).toBe('2026-10-01');
  });

  it('keeps the first instant of a month in that month', () => {
    expect(toUtcMonth(new Date('2026-11-01T00:00:00.000Z'))).toBe('2026-11-01');
  });

  it('keeps the last second of a month in that month', () => {
    expect(toUtcMonth(new Date('2026-10-31T23:59:59Z'))).toBe('2026-10-01');
    expect(toUtcMonth(new Date('2026-10-31T23:59:59.999Z'))).toBe('2026-10-01');
  });

  it('moves to the next month one millisecond later', () => {
    const lastMs = new Date('2026-10-31T23:59:59.999Z');
    expect(toUtcMonth(new Date(lastMs.getTime() + 1))).toBe('2026-11-01');
  });

  it('rolls December over into the next year', () => {
    expect(toUtcMonth(new Date('2026-12-31T23:59:59.999Z'))).toBe('2026-12-01');
    expect(toUtcMonth(new Date('2027-01-01T00:00:00.000Z'))).toBe('2027-01-01');
  });

  it('handles February in a leap year', () => {
    expect(toUtcMonth(new Date('2028-02-29T23:59:59.999Z'))).toBe('2028-02-01');
    expect(toUtcMonth(new Date('2028-03-01T00:00:00.000Z'))).toBe('2028-03-01');
  });

  it('uses the UTC month of an instant written with a non-UTC offset', () => {
    // 01:30 on Nov 1 in UTC+3 is still Oct 31 in UTC.
    expect(toUtcMonth(new Date('2026-11-01T01:30:00+03:00'))).toBe('2026-10-01');
    // 20:00 on Oct 31 in UTC-5 is already Nov 1 in UTC.
    expect(toUtcMonth(new Date('2026-10-31T20:00:00-05:00'))).toBe('2026-11-01');
  });

  it('pads years below 1000', () => {
    expect(toUtcMonth(new Date('0999-05-20T00:00:00Z'))).toBe('0999-05-01');
  });

  it('throws on an invalid date', () => {
    expect(() => toUtcMonth(new Date('not a date'))).toThrow(RangeError);
  });

  it('throws on a year the date column cannot hold', () => {
    expect(() => toUtcMonth(new Date(Date.UTC(10000, 0, 1)))).toThrow(RangeError);
  });

  describe('when the process runs in a non-UTC time zone', () => {
    const originalTz = process.env.TZ;

    afterEach(() => {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    });

    it('ignores the local zone ahead of UTC (Pacific/Kiritimati, UTC+14)', () => {
      process.env.TZ = 'Pacific/Kiritimati';
      const lastSecondOfOctUtc = new Date('2026-10-31T23:59:59Z');
      // Sanity check that the zone took effect: locally it's already November.
      expect(lastSecondOfOctUtc.getMonth()).toBe(10);
      expect(toUtcMonth(lastSecondOfOctUtc)).toBe('2026-10-01');
    });

    it('ignores the local zone behind UTC (America/Los_Angeles)', () => {
      process.env.TZ = 'America/Los_Angeles';
      const firstInstantOfNovUtc = new Date('2026-11-01T00:00:00Z');
      // Locally it's still October 31.
      expect(firstInstantOfNovUtc.getMonth()).toBe(9);
      expect(toUtcMonth(firstInstantOfNovUtc)).toBe('2026-11-01');
    });
  });
});

describe('injected clock', () => {
  it('lets a test move across a month boundary', () => {
    let current = new Date('2026-10-31T23:59:59.999Z');
    const now: Clock = () => current;

    expect(toUtcMonth(now())).toBe('2026-10-01');
    current = new Date(current.getTime() + 1);
    expect(toUtcMonth(now())).toBe('2026-11-01');
  });
});
