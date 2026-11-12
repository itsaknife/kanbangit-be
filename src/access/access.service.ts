import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, Repository, RepositoryMember, User } from '../generated/prisma/client.js';
import { GithubService } from '../github/github.service.js';
import type { GithubRepo } from '../github/github.types.js';
import { PrismaService } from '../prisma/prisma.service.js';
export interface RepoAccess {
  github: GithubRepo;
  connected: Repository;
  member: RepositoryMember;
}
@Injectable()
export class AccessService {
  constructor(
    _github: GithubService,
    private readonly prisma: PrismaService,
  ) {}
  async requireMember(user: User, repoId: string): Promise<RepoAccess> {
    const connected = await this.prisma.repository.findUnique({ where: { id: repoId } });
    if (!connected) throw new NotFoundException('Không tìm thấy repository');
    const member = await this.prisma.repositoryMember.findUnique({
      where: { repositoryId_githubUserId: { repositoryId: repoId, githubUserId: user.githubId } },
    });
    if (!member?.isActive || member.userId !== user.id)
      throw new ForbiddenException('Bạn không có membership hoạt động trong repository');
    return {
      connected,
      member,
      github: {
        id: Number(connected.githubId),
        name: connected.name,
        owner: connected.owner,
        fullName: connected.fullName,
        description: connected.description,
        isPrivate: connected.isPrivate,
        openIssuesCount: 0,
        canManage: member.role === 'OWNER',
      },
    };
  }
  requireAccess(user: User, repoId: string) {
    return this.requireMember(user, repoId);
  }
  requireOwner(user: User, repoId: string) {
    return this.requireConnectedOwner(user, repoId);
  }
  async requireConnectedOwner(user: User, repoId: string): Promise<RepoAccess> {
    const access = await this.requireMember(user, repoId);
    if (access.member.role !== 'OWNER')
      throw new ForbiddenException('Chỉ Owner của KanbanGit được thực hiện thao tác này');
    return access;
  }
  async ownerTransaction<T>(
    user: User,
    repoId: string,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Repository" WHERE id=${repoId} FOR UPDATE`;
      const member = await tx.repositoryMember.findUnique({
        where: { repositoryId_githubUserId: { repositoryId: repoId, githubUserId: user.githubId } },
      });
      if (!member?.isActive || member.userId !== user.id || member.role !== 'OWNER')
        throw new ForbiddenException('Chỉ Owner đang hoạt động được thực hiện thao tác này');
      return operation(tx);
    });
  }
}
