import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import type { User } from '../generated/prisma/client.js';
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly prisma: PrismaService) {}
  @Get() async list(@CurrentUser() user: User) {
    // Membership is rechecked so revoked access never leaks old issue titles.
    const memberships = await this.prisma.repositoryMember.findMany({
      where: { userId: user.id, isActive: true },
      select: { repositoryId: true },
    });
    const where = { userId: user.id, repositoryId: { in: memberships.map((m) => m.repositoryId) } };
    const [rows, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 }),
      this.prisma.notification.count({ where: { ...where, readAt: null } }),
    ]);
    const issues = await this.prisma.issue.findMany({
      where: { id: { in: rows.map((n) => n.issueId) } },
      select: { id: true, issueCode: true, title: true },
    });
    return {
      data: rows.map((n) => ({ ...n, issue: issues.find((i) => i.id === n.issueId) ?? null })),
      unreadCount,
    };
  }
  @Patch(':id/read') async read(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    const result = await this.prisma.notification.updateMany({
      where: { id, userId: user.id },
      data: { readAt: new Date() },
    });
    if (!result.count) throw new NotFoundException('Không tìm thấy thông báo');
    return { id };
  }
  @Post('read-all') async readAll(@CurrentUser() user: User) {
    await this.prisma.notification.updateMany({
      where: { userId: user.id, readAt: null },
      data: { readAt: new Date() },
    });
    return { success: true };
  }
}
