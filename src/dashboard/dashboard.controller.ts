import { Controller, Get, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import type { User } from '../generated/prisma/client.js';
import { DashboardService } from './dashboard.service.js';

@Controller('repositories/:repoId/dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  getStats(
    @CurrentUser() user: User,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('weekStart') weekStart?: string,
  ) {
    return this.dashboard.getStats(user, repoId, weekStart);
  }
}
