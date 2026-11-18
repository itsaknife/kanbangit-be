import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { IsString, IsOptional, Length, Matches } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import type { User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RepositoriesService } from './repositories.service.js';
import { DEFAULT_TRACKERS } from './default-trackers.js';
import { CreateRepositoryDto } from './dto/create-repository.dto.js';
import { ImportRepositoryDto, TransferOwnerDto } from './dto/core-repository.dto.js';
import { Patch } from '@nestjs/common';
class CreateLocalProjectDto {
  @IsString() @Length(1, 100) @Matches(/\S/) name!: string;
  @IsOptional() @IsString() @Length(0, 350) description?: string;
}
@Controller('projects')
@UseGuards(JwtAuthGuard)
export class ProjectsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repositories: RepositoriesService,
  ) {}
  @Get() list(@CurrentUser() u: User) {
    return this.repositories.list(u);
  }
  @Post() async create(@CurrentUser() u: User, @Body() dto: CreateLocalProjectDto) {
    const id = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      await tx.repository.create({
        data: {
          id,
          providerType: 'KANBANGIT',
          name: dto.name.trim(),
          fullName: dto.name.trim(),
          description: dto.description,
          owner: null,
          isPrivate: null,
          connectedById: u.id,
          importCompleted: true,
          members: {
            create: { userId: u.id, login: u.login, avatarUrl: u.avatarUrl, role: 'OWNER' },
          },
          trackers: { create: DEFAULT_TRACKERS.map((t, displayOrder) => ({ ...t, displayOrder })) },
        },
      });
      const trackers = await tx.tracker.findMany({ where: { repositoryId: id } });
      for (const t of trackers)
        await tx.trackerPrefix.create({
          data: { repositoryId: id, trackerId: t.id, prefix: t.prefix },
        });
    });
    return this.repositories.get(u, id);
  }
  @Get(':repoId') get(@CurrentUser() u: User, @Param('repoId', ParseUUIDPipe) id: string) {
    return this.repositories.get(u, id);
  }
  @Get(':repoId/members') members(
    @CurrentUser() u: User,
    @Param('repoId', ParseUUIDPipe) id: string,
  ) {
    return this.repositories.listMembers(u, id);
  }
  @Get(':repoId/assignees') assignees(
    @CurrentUser() u: User,
    @Param('repoId', ParseUUIDPipe) id: string,
  ) {
    return this.repositories.listAssignees(u, id);
  }
  @Post(':repoId/members/sync') sync(
    @CurrentUser() u: User,
    @Param('repoId', ParseUUIDPipe) id: string,
  ) {
    return this.repositories.syncMembers(u, id);
  }
  @Post(':repoId/connect') connect(
    @CurrentUser() u: User,
    @Param('repoId', ParseUUIDPipe) id: string,
  ) {
    return this.repositories.connect(u, id);
  }
  @Patch(':repoId/owner') owner(
    @CurrentUser() u: User,
    @Param('repoId', ParseUUIDPipe) id: string,
    @Body() dto: TransferOwnerDto,
  ) {
    return this.repositories.transferOwner(u, id, dto.memberId);
  }
}
@Controller('github/projects')
@UseGuards(JwtAuthGuard)
export class GithubProjectsController {
  constructor(private readonly repositories: RepositoriesService) {}
  @Get('available') available(@CurrentUser() u: User) {
    return this.repositories.available(u);
  }
  @Post('import') import(@CurrentUser() u: User, @Body() dto: ImportRepositoryDto) {
    return this.repositories.import(u, dto.githubId);
  }
  @Post() create(@CurrentUser() u: User, @Body() dto: CreateRepositoryDto) {
    return this.repositories.create(u, dto);
  }
}
