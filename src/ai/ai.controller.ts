import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import type { User } from '../generated/prisma/client.js';
import { DuplicateService } from './duplicate.service.js';
import { DuplicateCheckDto } from './dto/duplicate-check.dto.js';
import { GenerateSummaryDto } from './dto/generate-summary.dto.js';
import { WeeklySummaryService } from './weekly-summary.service.js';

@Controller('repositories/:repoId/ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(
    private readonly weeklySummary: WeeklySummaryService,
    private readonly duplicates: DuplicateService,
  ) {}

  @Get('weekly-summary')
  getWeeklySummary(@CurrentUser() user: User, @Param('repoId', ParseIntPipe) repoId: number) {
    return this.weeklySummary.getLatest(user, repoId);
  }

  @Post('weekly-summary')
  generateWeeklySummary(
    @CurrentUser() user: User,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Body() dto: GenerateSummaryDto,
  ) {
    return this.weeklySummary.generate(user, repoId, dto.weekStart);
  }

  @Post('duplicate-check')
  checkDuplicate(
    @CurrentUser() user: User,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Body() dto: DuplicateCheckDto,
  ) {
    return this.duplicates.check(user, repoId, dto);
  }
}
