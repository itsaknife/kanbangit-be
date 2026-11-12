import { Injectable } from '@nestjs/common';
import { GithubService } from '../github/github.service.js';
import type { Repository, User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async sync(user: User, repository: Repository) {
    // Complete GitHub pagination before changing active flags: API failure preserves membership.
    const members = await this.github.listMembers(user, repository.owner, repository.name);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Repository" WHERE id=${repository.id} FOR UPDATE`;
      for (const member of members) {
        const linked = await tx.user.findUnique({
          where: { githubId: member.githubUserId },
          select: { id: true },
        });
        const data = { ...member, userId: linked?.id ?? null, isActive: true };
        await tx.repositoryMember.upsert({
          where: {
            repositoryId_githubUserId: {
              repositoryId: repository.id,
              githubUserId: member.githubUserId,
            },
          },
          create: {
            repositoryId: repository.id,
            ...data,
            role: 'MEMBER',
          },
          // Sync GitHub permissions, never overwrite the KanbanGit role of existing members.
          update: data,
        });
      }
      await tx.repositoryMember.updateMany({
        where: {
          repositoryId: repository.id,
          githubUserId: { notIn: members.map((member) => member.githubUserId) },
        },
        data: { isActive: false },
      });
    });
    await this.realtime.refreshRepoAccess(repository.id);
    return this.list(repository.id);
  }

  async list(repositoryId: string) {
    const members = await this.prisma.repositoryMember.findMany({
      where: { repositoryId },
      orderBy: [{ role: 'asc' }, { login: 'asc' }],
    });
    return members.map((member) => ({ ...member, githubUserId: member.githubUserId.toString() }));
  }
}
