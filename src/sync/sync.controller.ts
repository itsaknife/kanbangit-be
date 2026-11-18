import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import type { User } from '../generated/prisma/client.js';
import { SyncService } from './sync.service.js';
export class SyncQueueQuery {
  @Type(() => Number) @IsInt() @Min(1) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}
@Controller(['projects/:repoId', 'repositories/:repoId'])
@UseGuards(JwtAuthGuard)
export class SyncController {
  constructor(private readonly sync: SyncService) {}
  @Get('issues/:issueId/sync') info(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Param('issueId', ParseUUIDPipe) id: string,
  ) {
    return this.sync.info(user, repoId, id);
  }
  @Get('sync/queue') queue(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Query() query: SyncQueueQuery,
  ) {
    return this.sync.queue(user, repoId, query.page, query.limit);
  }
  @Post('issues/:issueId/sync/retry') @HttpCode(202) retry(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Param('issueId', ParseUUIDPipe) id: string,
  ) {
    return this.sync.retry(user, repoId, id);
  }
  @Post('sync/retry') @HttpCode(202) retryAll(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
  ) {
    return this.sync.retry(user, repoId);
  }
}
