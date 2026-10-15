import { describe, expect, it } from 'vitest';
import { getWeekRange, listWeekDays, toLocalDateString } from './week.js';

const VN = 420; // UTC+7

describe('getWeekRange', () => {
  it('đưa ngày giữa tuần về thứ Hai và Chủ nhật của tuần đó', () => {
    const range = getWeekRange('2026-10-14', VN); // thứ Tư
    expect(range.weekStart).toBe('2026-10-12');
    expect(range.weekEnd).toBe('2026-10-18');
  });

  it('bỏ trống thì lấy tuần chứa thời điểm hiện tại theo giờ địa phương', () => {
    // 20:00 UTC Chủ nhật 11/10 đã là 03:00 thứ Hai 12/10 ở Việt Nam
    const range = getWeekRange(undefined, VN, new Date('2026-10-11T20:00:00Z'));
    expect(range.weekStart).toBe('2026-10-12');
  });

  it('thời điểm bắt đầu tuần tính theo múi giờ địa phương', () => {
    const range = getWeekRange('2026-10-12', VN);
    expect(range.startUtc.toISOString()).toBe('2026-10-11T17:00:00.000Z');
    expect(range.endUtc.toISOString()).toBe('2026-10-18T17:00:00.000Z');
  });

  it('từ chối ngày sai định dạng hoặc không tồn tại', () => {
    expect(() => getWeekRange('12/10/2026', VN)).toThrow();
    expect(() => getWeekRange('2026-02-31', VN)).toThrow();
  });
});

describe('listWeekDays', () => {
  it('trả về đủ 7 ngày từ thứ Hai', () => {
    const days = listWeekDays('2026-10-12');
    expect(days).toHaveLength(7);
    expect(days[0]).toBe('2026-10-12');
    expect(days[6]).toBe('2026-10-18');
  });
});

describe('toLocalDateString', () => {
  it('đổi sang ngày địa phương', () => {
    expect(toLocalDateString(new Date('2026-10-11T20:00:00Z'), VN)).toBe('2026-10-12');
  });
});
