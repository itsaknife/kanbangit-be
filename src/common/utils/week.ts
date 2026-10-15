const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export interface WeekRange {
  /** Thứ Hai đầu tuần, yyyy-MM-dd (giờ địa phương). */
  weekStart: string;
  /** Chủ nhật cuối tuần, yyyy-MM-dd (giờ địa phương). */
  weekEnd: string;
  /** Thời điểm bắt đầu tuần (UTC). */
  startUtc: Date;
  /** Thời điểm bắt đầu tuần kế tiếp (UTC), không tính vào tuần này. */
  endUtc: Date;
}

const pad = (value: number) => String(value).padStart(2, '0');

function formatUtcDate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Đổi một thời điểm sang ngày yyyy-MM-dd theo múi giờ địa phương (lệch so với UTC `offsetMinutes` phút). */
export function toLocalDateString(date: Date, offsetMinutes: number): string {
  return formatUtcDate(new Date(date.getTime() + offsetMinutes * MINUTE_MS));
}

/**
 * Tính khoảng tuần (thứ Hai đến Chủ nhật) chứa ngày `weekStart`.
 * Bỏ trống thì lấy tuần hiện tại. Ngày không phải thứ Hai sẽ được đưa về thứ Hai của tuần đó.
 */
export function getWeekRange(
  weekStart: string | undefined,
  offsetMinutes: number,
  now: Date = new Date(),
): WeekRange {
  let localDay: Date; // ngày địa phương, biểu diễn bằng 00:00 UTC của ngày đó
  if (weekStart) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(weekStart);
    if (!match) throw new Error('weekStart phải có dạng yyyy-MM-dd');
    localDay = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (formatUtcDate(localDay) !== weekStart) throw new Error('weekStart không phải ngày hợp lệ');
  } else {
    const local = new Date(now.getTime() + offsetMinutes * MINUTE_MS);
    localDay = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  }

  const daysSinceMonday = (localDay.getUTCDay() + 6) % 7;
  const mondayLocal = new Date(localDay.getTime() - daysSinceMonday * DAY_MS);
  const sundayLocal = new Date(mondayLocal.getTime() + 6 * DAY_MS);
  const startUtc = new Date(mondayLocal.getTime() - offsetMinutes * MINUTE_MS);

  return {
    weekStart: formatUtcDate(mondayLocal),
    weekEnd: formatUtcDate(sundayLocal),
    startUtc,
    endUtc: new Date(startUtc.getTime() + 7 * DAY_MS),
  };
}

/** Danh sách 7 ngày (yyyy-MM-dd) của tuần, từ thứ Hai đến Chủ nhật. */
export function listWeekDays(weekStart: string): string[] {
  const [year, month, day] = weekStart.split('-').map(Number) as [number, number, number];
  const monday = Date.UTC(year, month - 1, day);
  return Array.from({ length: 7 }, (_, index) => formatUtcDate(new Date(monday + index * DAY_MS)));
}
