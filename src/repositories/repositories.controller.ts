import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { ImportRepositoryDto, TransferOwnerDto } from './dto/core-repository.dto.js';
import { CreateRepositoryDto } from './dto/create-repository.dto.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import type { User } from '../generated/prisma/client.js';
import { RepositoriesService } from './repositories.service.js';

@Controller('repositories')
@UseGuards(JwtAuthGuard)
export class RepositoriesController {
  constructor(private readonly repositories: RepositoriesService) {}

  @Get()
  list(@CurrentUser() user: User) {
    return this.repositories.list(user);
  }

  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateRepositoryDto) {
    return this.repositories.create(user, dto);
  }

  @Get('available')
  available(@CurrentUser() user: User) {
    return this.repositories.available(user);
  }
  @Post('import')
  import(@CurrentUser() user: User, @Body() dto: ImportRepositoryDto) {
    return this.repositories.import(user, dto.githubId);
  }
  @Patch(':repoId/owner')
  transferOwner(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Body() dto: TransferOwnerDto,
  ) {
    return this.repositories.transferOwner(user, repoId, dto.memberId);
  }

  @Get(':repoId/members')
  members(@CurrentUser() user: User, @Param('repoId', ParseUUIDPipe) repoId: string) {
    return this.repositories.listMembers(user, repoId);
  }

  @Post(':repoId/members/sync')
  syncMembers(@CurrentUser() user: User, @Param('repoId', ParseUUIDPipe) repoId: string) {
    return this.repositories.syncMembers(user, repoId);
  }

  @Get(':repoId')
  get(@CurrentUser() user: User, @Param('repoId', ParseUUIDPipe) repoId: string) {
    return this.repositories.get(user, repoId);
  }

  @Get(':repoId/assignees')
  assignees(@CurrentUser() user: User, @Param('repoId', ParseUUIDPipe) repoId: string) {
    return this.repositories.listAssignees(user, repoId);
  }

  @Post(':repoId/connect')
  connect(@CurrentUser() user: User, @Param('repoId', ParseUUIDPipe) repoId: string) {
    return this.repositories.connect(user, repoId);
  }
}
