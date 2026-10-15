import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { SessionService } from '../../auth/session.service.js';
import { type AuthenticatedRequest, SESSION_COOKIE } from '../types/request.js';

/** Chỉ cho người đã đăng nhập đi qua. Người dùng được gắn vào `request.user`. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly session: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = (request.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    const user = await this.session.verify(token);
    if (!user) throw new UnauthorizedException('Chưa đăng nhập');
    request.user = user;
    return true;
  }
}
