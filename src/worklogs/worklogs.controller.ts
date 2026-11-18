import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { CollaborationChangeInterceptor } from '../collaboration/collaboration-change.interceptor.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import type { User } from '../generated/prisma/client.js';
import { CreateWorklogDto, UpdateWorklogDto, WorklogQuery } from './worklog.dto.js';
import { WorklogsService } from './worklogs.service.js';
@Controller(['projects/:repoId', 'repositories/:repoId'])
@UseGuards(JwtAuthGuard)
@UseInterceptors(CollaborationChangeInterceptor)
export class WorklogsController {
  constructor(private readonly worklogs: WorklogsService) {}
  @Get('worklogs') list(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Query() query: WorklogQuery,
  ) {
    return this.worklogs.list(user, repoId, query);
  }
  @Get('issues/:issueId/time-summary') summary(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Param('issueId', ParseUUIDPipe) id: string,
  ) {
    return this.worklogs.summary(user, repoId, id);
  }
  @Post('issues/:issueId/worklogs') create(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Param('issueId', ParseUUIDPipe) id: string,
    @Body() dto: CreateWorklogDto,
  ) {
    return this.worklogs.create(user, repoId, id, dto);
  }
  @Patch('worklogs/:id') update(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorklogDto,
  ) {
    return this.worklogs.update(user, repoId, id, dto);
  }
  @Delete('worklogs/:id') remove(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.worklogs.remove(user, repoId, id);
  }
}
