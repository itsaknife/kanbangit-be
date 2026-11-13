import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import type { User } from '../generated/prisma/client.js';
import { CreateIssueDto } from './dto/create-issue.dto.js';
import { UpdateIssueDto } from './dto/update-issue.dto.js';
import { UpdateStatusDto } from './dto/update-status.dto.js';
import { ParentDto } from './dto/planning.dto.js';
import { IssueListQuery } from './dto/issue-list.dto.js';
import { IssuesService } from './issues.service.js';

@Controller('repositories/:repoId/issues')
@UseGuards(JwtAuthGuard)
export class IssuesController {
  constructor(private readonly issues: IssuesService) {}
  @Get() list(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Query() query: IssueListQuery,
  ) {
    return this.issues.list(user, repoId, {
      ...query,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
  }
  @Post() create(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Body() dto: CreateIssueDto,
  ) {
    return this.issues.create(user, repoId, dto);
  }
  @Get(':issueId') get(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Param('issueId', ParseUUIDPipe) id: string,
  ) {
    return this.issues.get(user, repoId, id);
  }
  @Patch(':issueId') update(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Param('issueId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateIssueDto,
  ) {
    return this.issues.update(user, repoId, id, dto);
  }
  @Patch(':issueId/status') status(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Param('issueId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStatusDto,
  ) {
    return this.issues.updateStatus(user, repoId, id, dto.status);
  }
  @Put(':issueId/parent') parent(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Param('issueId', ParseUUIDPipe) id: string,
    @Body() dto: ParentDto,
  ) {
    return this.issues.setParent(user, repoId, id, dto.parentId);
  }
  @Delete(':issueId/parent') detach(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Param('issueId', ParseUUIDPipe) id: string,
  ) {
    return this.issues.setParent(user, repoId, id, null);
  }
  @Get(':issueId/sub-issues') children(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Param('issueId', ParseUUIDPipe) id: string,
  ) {
    return this.issues.subIssues(user, repoId, id);
  }
  @Post(':issueId/cascade-close') close(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Param('issueId', ParseUUIDPipe) id: string,
  ) {
    return this.issues.cascadeClose(user, repoId, id);
  }
}
