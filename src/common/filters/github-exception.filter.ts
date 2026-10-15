import { type ArgumentsHost, Catch, type ExceptionFilter, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { RequestError } from 'octokit';

/** Đổi lỗi của GitHub thành mã lỗi HTTP và thông báo tiếng Việt mà giao diện hiển thị được. */
export function translateGithubError(error: RequestError): { status: number; message: string } {
  const detail =
    (error.response?.data as { message?: string } | undefined)?.message ?? error.message;

  switch (error.status) {
    case 401:
      return { status: 401, message: 'Phiên GitHub đã hết hạn hoặc bị thu hồi, hãy đăng nhập lại' };
    case 403:
      return /rate limit/i.test(detail)
        ? { status: 429, message: 'Đã vượt giới hạn gọi GitHub, hãy thử lại sau ít phút' }
        : { status: 403, message: `GitHub từ chối thao tác này: ${detail}` };
    case 404:
      return {
        status: 404,
        message: 'Không tìm thấy trên GitHub hoặc bạn không có quyền truy cập',
      };
    case 410:
      return { status: 400, message: 'Repository này đã tắt tính năng Issues trên GitHub' };
    case 422:
      return { status: 422, message: `GitHub không chấp nhận dữ liệu: ${detail}` };
    default:
      return { status: 502, message: 'Không gọi được GitHub, hãy thử lại sau' };
  }
}

@Catch(RequestError)
export class GithubExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GithubExceptionFilter.name);

  catch(error: RequestError, host: ArgumentsHost): void {
    const { status, message } = translateGithubError(error);
    this.logger.warn(`GitHub trả lỗi ${error.status}: ${error.message}`);
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(status)
      .json({ statusCode: status, message });
  }
}
