import { describe, it, expect } from 'vitest';
import {
  allocateDays,
  dateBoundary,
  overlaps,
  timeRange,
  validateWorklog,
} from './worklog.rules.js';
describe('M4 worklog time rules', () => {
  it.each([
    ['2020-01-01T08:00:00+07:00', '2020-01-01T09:00:00+07:00', 60],
    ['2020-01-01T08:00:00+07:00', '2020-01-02T08:00:00+07:00', 1440],
    ['2020-01-01T01:00:00Z', '2020-01-01T01:00:30Z', 0.5],
  ])('computes real duration (%s)', (start, end, minutes) =>
    expect(validateWorklog(start, end).durationMinutes).toBe(minutes),
  );
  it.each([
    ['2020-01-01T08:00:00', '2020-01-01T09:00:00'],
    ['invalid', '2020-01-01T09:00:00Z'],
    ['2020-01-01T08:00:00Z', '2020-01-01T08:00:00Z'],
    ['2020-01-02T08:00:00Z', '2020-01-01T08:00:00Z'],
    ['2099-01-01T08:00:00Z', '2099-01-01T09:00:00Z'],
  ])('rejects invalid ranges (%s)', (start, end) =>
    expect(() => validateWorklog(start, end)).toThrow(),
  );
  it('accepts adjacent half-open intervals', () =>
    expect(
      overlaps(
        { startAt: new Date(0), endAt: new Date(60000) },
        { startAt: new Date(60000), endAt: new Date(120000) },
      ),
    ).toBe(false));
  it('detects contained intervals', () =>
    expect(
      overlaps(
        { startAt: new Date(0), endAt: new Date(120000) },
        { startAt: new Date(1), endAt: new Date(60000) },
      ),
    ).toBe(true));
  it('splits at Vietnam midnight and clips both ends', () => {
    const range = timeRange('custom', '2020-01-02', '2020-01-03');
    expect(
      allocateDays(
        new Date('2020-01-01T23:00:00+07:00'),
        new Date('2020-01-04T01:00:00+07:00'),
        range.from,
        range.to,
      ),
    ).toEqual([
      { date: '2020-01-02', durationMinutes: 1440 },
      { date: '2020-01-03', durationMinutes: 1440 },
    ]);
  });
  it('preserves seconds at the midnight boundary', () =>
    expect(
      allocateDays(new Date('2020-01-01T23:59:30+07:00'), new Date('2020-01-02T00:00:30+07:00')),
    ).toEqual([
      { date: '2020-01-01', durationMinutes: 0.5 },
      { date: '2020-01-02', durationMinutes: 0.5 },
    ]));
  it('never allocates a nonoverlapping range', () =>
    expect(allocateDays(new Date(0), new Date(100), new Date(200))).toEqual([]));
  it('uses Monday as week start in Vietnam', () =>
    expect(
      timeRange(
        'week',
        undefined,
        undefined,
        +new Date('2026-11-15T18:00:00Z'),
      ).from?.toISOString(),
    ).toBe('2026-11-15T17:00:00.000Z'));
  it('handles month rollover', () =>
    expect(
      timeRange('month', undefined, undefined, +new Date('2026-12-31T18:00:00Z')).to?.toISOString(),
    ).toBe('2027-01-31T17:00:00.000Z'));
  it.each(['2026-02-30', '2025-02-29', '2020-13-01', '2020-1-01'])(
    'rejects invalid calendar dates %s',
    (value) => expect(() => dateBoundary(value)).toThrow(),
  );
  it('requires complete custom range', () =>
    expect(() => timeRange('custom', '2020-01-01')).toThrow());
  it('rejects reversed custom dates', () =>
    expect(() => timeRange('custom', '2020-01-03', '2020-01-01')).toThrow());
});
