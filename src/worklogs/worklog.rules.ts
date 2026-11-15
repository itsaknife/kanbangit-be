import { BadRequestException } from '@nestjs/common';

export const VIETNAM_OFFSET = 7 * 3600000;
export const DAY = 86400000;
export function validateWorklog(start: string, end: string, now = Date.now()) {
  const timezone = /(?:Z|[+-]\d{2}:\d{2})$/i;
  const startAt = new Date(start),
    endAt = new Date(end);
  if (
    !timezone.test(start) ||
    !timezone.test(end) ||
    !Number.isFinite(+startAt) ||
    !Number.isFinite(+endAt)
  )
    throw new BadRequestException('Datetime phải có timezone hợp lệ');
  if (+endAt <= +startAt) throw new BadRequestException('Kết thúc phải sau bắt đầu');
  if (+startAt > now || +endAt > now)
    throw new BadRequestException('Chỉ được ghi nhận thời gian trong quá khứ');
  return { startAt, endAt, durationMinutes: (+endAt - +startAt) / 60000 };
}
export function overlaps(a: { startAt: Date; endAt: Date }, b: { startAt: Date; endAt: Date }) {
  return +a.startAt < +b.endAt && +a.endAt > +b.startAt;
}
export function dateBoundary(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new BadRequestException('Ngày phải có dạng YYYY-MM-DD');
  const parsed = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== value)
    throw new BadRequestException('Ngày không hợp lệ');
  return +parsed - VIETNAM_OFFSET;
}
export function timeRange(period = 'week', from?: string, to?: string, now = Date.now()) {
  const today = Math.floor((now + VIETNAM_OFFSET) / DAY) * DAY - VIETNAM_OFFSET;
  if (period === 'all') return { from: undefined, to: undefined };
  if (period === 'custom') {
    if (!from || !to)
      throw new BadRequestException('Khoảng tùy chỉnh cần ngày bắt đầu và kết thúc');
    const start = dateBoundary(from),
      end = dateBoundary(to) + DAY;
    if (end <= start) throw new BadRequestException('Khoảng ngày không hợp lệ');
    return { from: new Date(start), to: new Date(end) };
  }
  if (period === 'week') {
    const weekday = new Date(today + VIETNAM_OFFSET).getUTCDay();
    const start = today - ((weekday + 6) % 7) * DAY;
    return { from: new Date(start), to: new Date(start + 7 * DAY) };
  }
  if (period === 'month') {
    const local = new Date(today + VIETNAM_OFFSET);
    return {
      from: new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - VIETNAM_OFFSET),
      to: new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - VIETNAM_OFFSET),
    };
  }
  throw new BadRequestException('Khoảng thời gian không hợp lệ');
}
export function allocateDays(startAt: Date, endAt: Date, from?: Date, to?: Date) {
  const start = Math.max(+startAt, from ? +from : -Infinity);
  const end = Math.min(+endAt, to ? +to : Infinity);
  const days: { date: string; durationMinutes: number }[] = [];
  for (let cursor = start; cursor < end;) {
    const midnight = Math.floor((cursor + VIETNAM_OFFSET) / DAY) * DAY - VIETNAM_OFFSET;
    const next = Math.min(end, midnight + DAY);
    days.push({
      date: new Date(midnight + VIETNAM_OFFSET).toISOString().slice(0, 10),
      durationMinutes: (next - cursor) / 60000,
    });
    cursor = next;
  }
  return days;
}
