import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CollaborationAccess } from '../collaboration/collaboration-access.service.js';
import type { User } from '../generated/prisma/client.js';
import { descendantIds } from '../issues/issue.rules.js';
import { CreateWorklogDto, UpdateWorklogDto, WorklogQuery } from './worklog.dto.js';
import { allocateDays, timeRange, validateWorklog } from './worklog.rules.js';

@Injectable()
export class WorklogsService {
  constructor(private readonly access: CollaborationAccess) {}
  list(user: User, repoId: string, query: WorklogQuery) {
    return this.access.transaction(user, repoId, async (tx, viewer) => {
      const owner = viewer.role === 'OWNER';
      if (!owner && query.memberId && query.memberId !== viewer.id)
        throw new ForbiddenException('Bạn chỉ được xem báo cáo thời gian của mình');
      const range = timeRange(query.period ?? 'all', query.from, query.to);
      let canView = true;
      if (query.issueId) {
        await this.access.issue(tx, repoId, query.issueId);
        canView =
          owner ||
          !!(await tx.worklog.findFirst({
            where: { issueId: query.issueId, memberId: viewer.id },
          }));
      }
      const rows = canView
        ? await tx.worklog.findMany({
            where: {
              issue: { repoId },
              ...(query.issueId ? { issueId: query.issueId } : {}),
              ...(!query.issueId || query.memberId
                ? { memberId: owner ? query.memberId : viewer.id }
                : {}),
              ...(range.from ? { endAt: { gt: range.from } } : {}),
              ...(range.to ? { startAt: { lt: range.to } } : {}),
            },
            include: {
              member: { include: { user: true } },
              issue: { select: { id: true, issueCode: true, title: true } },
            },
            orderBy: [{ startAt: 'desc' }, { id: 'asc' }],
          })
        : [];
      const daily = new Map<string, number>();
      const data = rows.map((row) => {
        const days = allocateDays(row.startAt, row.endAt, range.from, range.to);
        for (const day of days)
          daily.set(day.date, (daily.get(day.date) ?? 0) + day.durationMinutes);
        return {
          id: row.id,
          issueId: row.issueId,
          memberId: row.memberId,
          member: {
            id: row.member.id,
            login: row.member.login,
            name: row.member.user?.displayName || row.member.user?.name || row.member.login,
            avatarUrl: row.member.user?.customAvatarUrl || row.member.avatarUrl,
          },
          issue: row.issue,
          startAt: row.startAt,
          endAt: row.endAt,
          description: row.description,
          durationMinutes: row.durationMinutes,
          selectedMinutes: days.reduce((sum, d) => sum + d.durationMinutes, 0),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          canEdit: this.access.canManage(viewer, row.memberId),
          canDelete: owner,
        };
      });
      return {
        data,
        canView,
        canManage: owner,
        currentMemberId: viewer.id,
        totalMinutes: data.reduce((sum, row) => sum + row.selectedMinutes, 0),
        daily: [...daily]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, durationMinutes]) => ({ date, durationMinutes })),
        range: { from: range.from ?? null, to: range.to ?? null, timezone: 'Asia/Ho_Chi_Minh' },
      };
    });
  }
  summary(user: User, repoId: string, issueId: string) {
    return this.access.transaction(user, repoId, async (tx, viewer) => {
      const issue = await this.access.issue(tx, repoId, issueId);
      const graph = await tx.issue.findMany({
        where: { repoId },
        select: { id: true, parentId: true, estimateMinutes: true },
      });
      const ids = [issueId, ...descendantIds(graph, issueId)];
      const visible =
        viewer.role === 'OWNER'
          ? ids
          : (
              await tx.worklog.findMany({
                where: { issueId: { in: ids }, memberId: viewer.id },
                select: { issueId: true },
                distinct: ['issueId'],
              })
            ).map((w) => w.issueId);
      // Return no hidden aggregate or warning when a descendant's worklogs are private.
      const directVisible = visible.includes(issueId);
      const treeVisible = ids.every((id) => visible.includes(id));
      const sums = await tx.worklog.groupBy({
        by: ['issueId'],
        where: { issueId: { in: visible } },
        _sum: { durationMinutes: true },
      });
      const sum = (id: string) => sums.find((w) => w.issueId === id)?._sum.durationMinutes ?? 0;
      const directMinutes = directVisible ? sum(issueId) : null;
      const combinedMinutes = treeVisible ? ids.reduce((total, id) => total + sum(id), 0) : null;
      const combinedEstimateMinutes = graph
        .filter((n) => ids.includes(n.id))
        .reduce((total, n) => total + (n.estimateMinutes ?? 0), 0);
      return {
        directMinutes,
        combinedMinutes,
        estimateMinutes: issue.estimateMinutes,
        combinedEstimateMinutes,
        directOverEstimate:
          directMinutes !== null &&
          issue.estimateMinutes !== null &&
          directMinutes > issue.estimateMinutes,
        combinedOverEstimate:
          combinedMinutes !== null &&
          graph.some((n) => ids.includes(n.id) && n.estimateMinutes !== null) &&
          combinedMinutes > combinedEstimateMinutes,
        directVisible,
        treeVisible,
      };
    });
  }
  create(user: User, repoId: string, issueId: string, dto: CreateWorklogDto) {
    return this.write(user, repoId, undefined, issueId, dto);
  }
  update(user: User, repoId: string, id: string, dto: UpdateWorklogDto) {
    return this.write(user, repoId, id, undefined, dto);
  }
  private async write(
    user: User,
    repoId: string,
    id: string | undefined,
    issueId: string | undefined,
    dto: CreateWorklogDto | UpdateWorklogDto,
  ) {
    const timing = validateWorklog(dto.startAt, dto.endAt);
    try {
      return await this.access.transaction(user, repoId, async (tx, viewer) => {
        const old = id ? await tx.worklog.findFirst({ where: { id, issue: { repoId } } }) : null;
        if (id && !old) throw new NotFoundException('Không tìm thấy worklog');
        if (old && !this.access.canManage(viewer, old.memberId))
          throw new ForbiddenException('Bạn chỉ được sửa worklog của mình');
        const memberId =
          old?.memberId ?? ('memberId' in dto ? dto.memberId : undefined) ?? viewer.id;
        const member = await tx.repositoryMember.findFirst({
          where: { id: memberId, repositoryId: repoId, ...(!old ? { isActive: true } : {}) },
        });
        if (!member) throw new BadRequestException('Thành viên không hợp lệ');
        if (!old && memberId !== viewer.id && viewer.role !== 'OWNER')
          throw new ForbiddenException('Bạn chỉ được tạo worklog của mình');
        const targetIssueId = old?.issueId ?? issueId!;
        await this.access.issue(tx, repoId, targetIssueId);
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(${member.githubUserId})::text`;
        if (
          await tx.worklog.findFirst({
            where: {
              githubUserId: member.githubUserId,
              ...(id ? { id: { not: id } } : {}),
              startAt: { lt: timing.endAt },
              endAt: { gt: timing.startAt },
            },
          })
        )
          throw new ConflictException({
            code: 'WORKLOG_OVERLAP',
            message: 'Thời gian bị trùng với worklog đã ghi nhận',
          });
        const data = { ...timing, description: dto.description?.trim() || null };
        const row = old
          ? await tx.worklog.update({ where: { id: old.id }, data })
          : await tx.worklog.create({
              data: {
                ...data,
                issueId: targetIssueId,
                memberId,
                githubUserId: member.githubUserId,
              },
            });
        return { id: row.id, issueId: row.issueId };
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('WORKLOG_OVERLAP'))
        throw new ConflictException({
          code: 'WORKLOG_OVERLAP',
          message: 'Thời gian bị trùng với worklog đã ghi nhận',
        });
      throw error;
    }
  }
  remove(user: User, repoId: string, id: string) {
    return this.access.transaction(user, repoId, async (tx, viewer) => {
      if (viewer.role !== 'OWNER') throw new ForbiddenException('Chỉ Owner được xóa worklog');
      const row = await tx.worklog.findFirst({ where: { id, issue: { repoId } } });
      if (!row) throw new NotFoundException('Không tìm thấy worklog');
      await tx.worklog.delete({ where: { id } });
      return { id };
    });
  }
}
