import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Tạo và đọc phiên đăng nhập (JWT lưu trong cookie). Dùng chung cho HTTP và Socket.io. */
@Injectable()
export class SessionService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  sign(userId: number): Promise<string> {
    return this.jwt.signAsync({ sub: userId });
  }

  /** Trả về người dùng nếu token hợp lệ và người dùng còn tồn tại, ngược lại trả null. */
  async verify(token: string | undefined): Promise<User | null> {
    if (!token) return null;
    try {
      const payload = await this.jwt.verifyAsync<{ sub: number }>(token);
      return await this.prisma.user.findUnique({ where: { id: payload.sub } });
    } catch {
      return null;
    }
  }
}
