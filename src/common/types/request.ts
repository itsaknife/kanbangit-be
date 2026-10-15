import type { Request } from 'express';
import type { User } from '../../generated/prisma/client.js';

/** Request sau khi qua JwtAuthGuard: có thêm người dùng đang đăng nhập. */
export interface AuthenticatedRequest extends Request {
  user: User;
}

export const SESSION_COOKIE = 'session';
