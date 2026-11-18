import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { AccessService } from '../access/access.service.js';
import type { Prisma, User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import { randomUUID } from 'node:crypto';
import { toIssueDto } from '../issues/issue.mapper.js';
import { estimateTotals } from '../issues/issue.rules.js';

@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async info(user: User, repoId: string, issueId: string) {
    const { member, connected } = await this.access.requireMember(user, repoId);
    if(connected.providerType !== 'GITHUB') throw new BadRequestException('Project local không có GitHub Sync');
    const issue = await this.prisma.issue.findFirst({ where: { id: issueId, repoId } });
    if (!issue) throw new NotFoundException('Không tìm thấy issue trong repository');
    const job = await this.prisma.syncJob.findFirst({
      where: { issueId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return {
      issueId,
      issueCode: issue.issueCode,
      syncStatus: issue.syncStatus,
      lastSyncedAt: issue.lastSyncedAt?.toISOString() ?? null,
      retryCount: job?.retryCount ?? 0,
      lastError: job?.lastError ?? null,
      nextRetryAt: job?.nextRetryAt?.toISOString() ?? null,
      jobStatus: job?.status ?? null,
      canRetry: member.role === 'OWNER',
    };
  }

  async queue(user: User, repoId: string, page: number, limit: number) {
    const {connected}=await this.access.requireConnectedOwner(user, repoId);
    if(connected.providerType !== 'GITHUB') throw new BadRequestException('Project local không có GitHub Sync');
    const where: Prisma.IssueWhereInput = { repoId, syncStatus: { not: 'SYNCED' } };
    const [issues, total] = await Promise.all([
      this.prisma.issue.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { syncJobs: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 } },
      }),
      this.prisma.issue.count({ where }),
    ]);
    return {
      data: issues.map((issue) => {
        const job = issue.syncJobs[0];
        return {
          issueId: issue.id,
          issueCode: issue.issueCode,
          title: issue.title,
          syncStatus: issue.syncStatus,
          retryCount: job?.retryCount ?? 0,
          lastError: job?.lastError ?? null,
          lastSyncedAt: issue.lastSyncedAt?.toISOString() ?? null,
          nextRetryAt: job?.nextRetryAt?.toISOString() ?? null,
          jobStatus: job?.status ?? null,
        };
      }),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async retry(user: User, repoId: string, issueId?: string) {
    const {connected}=await this.access.requireConnectedOwner(user, repoId);
    if(connected.providerType !== 'GITHUB') throw new BadRequestException('Project local không có GitHub Sync');
    const rows = await this.access.ownerTransaction(user, repoId, async (tx) => {
      const issues = await tx.issue.findMany({
        where: { repoId, ...(issueId ? { id: issueId } : { syncStatus: 'NEEDS_ATTENTION' }) },
      });
      if (issueId && !issues.length)
        throw new NotFoundException('Không tìm thấy issue trong repository');
      const queued = [];
      for (const issue of issues) {
        // A repeated click must not restart an in-flight request or bypass its retry wait.
        if (issue.syncStatus !== 'NEEDS_ATTENTION') continue;
        const active = await tx.syncJob.findFirst({
          where: { issueId: issue.id, status: { in: ['PENDING', 'PROCESSING', 'RETRY_WAIT'] } },
        });
        if (active) continue;
        await tx.syncJob.create({
          data: {
            repositoryId: repoId,
            issueId: issue.id,
            operation: issue.githubId === null ? 'CREATE' : 'UPDATE',
            idempotencyKey: `retry:${randomUUID()}`,
          },
        });
        queued.push(
          await tx.issue.update({
            where: { id: issue.id },
            data: { syncStatus: 'PENDING_SYNC', syncVersion: { increment: 1 } },
          }),
        );
      }
      return queued;
    });
    if (rows.length) {
      const graph = await this.prisma.issue.findMany({
        where: { repoId },
        select: { id: true, parentId: true, estimateMinutes: true },
      });
      rows.forEach((row) =>
        this.realtime.emitIssueUpdated(repoId, {
          ...toIssueDto(row),
          ...estimateTotals(graph, row.id),
        }),
      );
    }
    return { queued: rows.length };
  }
}
