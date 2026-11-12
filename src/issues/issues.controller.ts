import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
class IssueSearchQuery {
  @IsOptional() @IsString() @MaxLength(200) search?: string;
}
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import type { User } from '../generated/prisma/client.js';
import { CreateIssueDto } from './dto/create-issue.dto.js';
import { UpdateIssueDto } from './dto/update-issue.dto.js';
import { UpdateStatusDto } from './dto/update-status.dto.js';
import { IssuesService } from './issues.service.js';

@Controller('repositories/:repoId/issues')
@UseGuards(JwtAuthGuard)
export class IssuesController {
  constructor(private readonly issues: IssuesService) {}

  @Get()
  list(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Query() query: IssueSearchQuery,
  ) {
    return this.issues.list(user, repoId, query.search);
  }

  @Get(':number')
  get(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Param('number', ParseIntPipe) number: number,
  ) {
    return this.issues.get(user, repoId, number);
  }

  @Post()
  create(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Body() dto: CreateIssueDto,
  ) {
    return this.issues.create(user, repoId, dto);
  }

  @Patch(':number')
  update(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Param('number', ParseIntPipe) number: number,
    @Body() dto: UpdateIssueDto,
  ) {
    return this.issues.update(user, repoId, number, dto);
  }

  @Patch(':number/status')
  updateStatus(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Param('number', ParseIntPipe) number: number,
    @Body() dto: UpdateStatusDto,
  ) {
    return this.issues.updateStatus(user, repoId, number, dto.status);
  }
}
