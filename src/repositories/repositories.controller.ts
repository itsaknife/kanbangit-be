import { Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import type { User } from '../generated/prisma/client.js';
import { RepositoriesService } from './repositories.service.js';

@Controller('repositories')
@UseGuards(JwtAuthGuard)
export class RepositoriesController {
  constructor(private readonly repositories: RepositoriesService) { }

  @Get()
  list(@CurrentUser() user: User) {
    return this.repositories.list(user);
  }

  @Get(':repoId')
  get(@CurrentUser() user: User, @Param('repoId', ParseIntPipe) repoId: number) {
    return this.repositories.get(user, repoId);
  }

  @Get(':repoId/assignees')
  assignees(@CurrentUser() user: User, @Param('repoId', ParseIntPipe) repoId: number) {
    return this.repositories.listAssignees(user, repoId);
  }

  @Post(':repoId/connect')
  connect(@CurrentUser() user: User, @Param('repoId', ParseIntPipe) repoId: number) {
    return this.repositories.connect(user, repoId);
  }
}
