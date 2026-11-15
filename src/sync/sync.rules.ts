export const RETRY_MS = 5 * 60 * 1000;
export const MAX_RETRIES = 5;
export const SYNC_CONCURRENCY = 5;
const markerPattern = /\n?<!-- kanbangit-sync:([0-9a-f-]{36}) -->/gi;
export const syncMarker = (id: string) => `<!-- kanbangit-sync:${id} -->`;
export const stripSyncMarker = (body: string | null | undefined) =>
  body?.replace(markerPattern, '') ?? null;
export function localIdFromBody(body: string | null | undefined) {
  return /<!-- kanbangit-sync:([0-9a-f-]{36}) -->/i.exec(body ?? '')?.[1]?.toLowerCase();
}
export function syncBody(body: string | null, id: string) {
  return `${stripSyncMarker(body) ?? ''}\n${syncMarker(id)}`;
}
export class SyncDependencyError extends Error {}
/** Never propagate provider messages, request headers or bodies into persisted errors. */
export function syncFailure(error: unknown): { temporary: boolean; message: string } {
  if (error instanceof SyncDependencyError)
    return { temporary: true, message: 'Issue cha đang chờ đồng bộ GitHub.' };
  const e = error as {
    status?: number;
    response?: { headers?: Record<string, string> };
    message?: string;
  } | null;
  const status = e?.status;
  const headers = e?.response?.headers;
  const rateLimited =
    status === 429 ||
    (status === 403 &&
      (headers?.['x-ratelimit-remaining'] === '0' ||
        !!headers?.['retry-after'] ||
        /rate limit/i.test(e?.message ?? '')));
  if (rateLimited) return { temporary: true, message: 'GitHub giới hạn tần suất yêu cầu.' };
  if (!status || status >= 500 || status === 408)
    return { temporary: true, message: 'Không thể kết nối GitHub. Hệ thống sẽ thử lại.' };
  if (status === 401)
    return {
      temporary: false,
      message: 'Phiên GitHub của Owner hết hạn hoặc bị thu hồi. Owner cần đăng nhập lại rồi Retry.',
    };
  if (status === 403)
    return { temporary: false, message: 'Tài khoản kết nối không đủ quyền ghi trên GitHub.' };
  if (status === 404 || status === 410)
    return {
      temporary: false,
      message: 'Không tìm thấy repository hoặc issue trên GitHub; kiểm tra quyền truy cập.',
    };
  if (status === 422)
    return {
      temporary: false,
      message: 'GitHub từ chối dữ liệu hoặc quan hệ issue. Owner cần kiểm tra trước khi Retry.',
    };
  return { temporary: false, message: `GitHub từ chối đồng bộ (HTTP ${status}).` };
}
export function retryDecision(retryCount: number, temporary: boolean, now = new Date()) {
  const failed = !temporary || retryCount >= MAX_RETRIES;
  return {
    status: failed ? 'FAILED' : 'RETRY_WAIT',
    nextRetryAt: failed ? null : new Date(now.getTime() + RETRY_MS),
  };
}
