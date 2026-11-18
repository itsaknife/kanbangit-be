import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, RepositoryMember, User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class CollaborationAccess {
  constructor(private readonly prisma: PrismaService) {}
  transaction<T>(
    user: User,
    repoId: string,
    action: (tx: Prisma.TransactionClient, member: RepositoryMember) => Promise<T>,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        // Same lock order as membership changes and CASCADE CLOSE.
        const repositories = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM "Repository" WHERE id=${repoId} FOR UPDATE`;
        if (!repositories.length) throw new NotFoundException('Không tìm thấy repository');
        const member = await tx.repositoryMember.findUnique({
          where: {
            repositoryId_userId: { repositoryId: repoId, userId: user.id },
          },
        });
        if (!member?.isActive || member.userId !== user.id)
          throw new ForbiddenException('Bạn không có quyền truy cập repository');
        return action(tx, member);
      },
      { timeout: 30000 },
    );
  }
  async issue(tx: Prisma.TransactionClient, repoId: string, issueId: string) {
    const issue = await tx.issue.findFirst({ where: { id: issueId, repoId } });
    if (!issue) throw new NotFoundException('Không tìm thấy issue trong repository');
    return issue;
  }
  canManage(member: RepositoryMember, authorId: string) {
    return member.role === 'OWNER' || member.id === authorId;
  }
}
