import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { User } from '../../generated/prisma/client.js';
import type { AuthenticatedRequest } from '../types/request.js';

/** Lấy người dùng đang đăng nhập trong controller: `@CurrentUser() user: User`. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): User => {
    return context.switchToHttp().getRequest<AuthenticatedRequest>().user;
  },
);
