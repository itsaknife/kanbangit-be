import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { allocateIssueCode } from '../trackers/trackers.service.js';
import { AccessService } from '../access/access.service.js';
import { EmbeddingService } from '../ai/embedding.service.js';
import type { IssueDto } from '../common/types/issue.dto.js';
import {
  type Issue,
  type Prisma,
  type Repository,
  type User,
  IssueStatus,
} from '../generated/prisma/client.js';
import { GithubService } from '../github/github.service.js';
import type { GithubIssue } from '../github/github.types.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import type { CreateIssueDto } from './dto/create-issue.dto.js';
import type { UpdateIssueDto } from './dto/update-issue.dto.js';
import { toIssueDto, toIssueFields } from './issue.mapper.js';
import {
  descendantIds,
  estimateTotals,
  githubStateForStatus,
  statusFromGithub,
  validateHierarchy,
  validatePlanning,
} from './issue.rules.js';
import type { IssueListQuery } from './dto/issue-list.dto.js';

@Injectable()
export class IssuesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubService,
    private readonly access: AccessService,
    private readonly realtime: RealtimeGateway,
    private readonly embeddings: EmbeddingService,
  ) {}

  async list(user: User, repoId: string, input?: string | IssueListQuery) {
    await this.access.requireMember(user, repoId);
    const query: IssueListQuery = typeof input === 'string' ? { search: input } : (input ?? {});
    const search = query.search?.trim();
    const where: Prisma.IssueWhereInput = {
      repoId,
      ...(query.status && { status: query.status }),
      ...(query.trackerId && { trackerId: query.trackerId }),
      ...(query.assigneeId && { assigneeId: query.assigneeId }),
      ...(query.parentId && { parentId: query.parentId }),
      ...(query.label && { labels: { array_contains: [{ name: query.label }] } }),
      ...(search && {
        OR: [
          { issueCode: { contains: search, mode: 'insensitive' } },
          { title: { contains: search, mode: 'insensitive' } },
          { body: { contains: search, mode: 'insensitive' } },
          ...(/^#?\d+$/.test(search) && Number(search.replace(/^#/, '')) <= 2147483647
            ? [{ number: Number(search.replace(/^#/, '')) }]
            : []),
        ],
      }),
    };
    const orderBy = { [query.sortBy ?? 'createdAt']: query.sortOrder ?? 'desc' };
    const graph = await this.prisma.issue.findMany({
      where: { repoId },
      select: { id: true, parentId: true, estimateMinutes: true },
    });
    const rows = await this.prisma.issue.findMany({
      where,
      orderBy,
      ...(query.page || query.limit
        ? { skip: ((query.page ?? 1) - 1) * (query.limit ?? 20), take: query.limit ?? 20 }
        : {}),
    });
    const data = rows.map((issue) => ({
      ...toIssueDto(issue),
      ...estimateTotals(graph, issue.id),
    }));
    if (!query.page && !query.limit) return data;
    const total = await this.prisma.issue.count({ where });
    return {
      data,
      pagination: {
        page: query.page ?? 1,
        limit: query.limit ?? 20,
        total,
        totalPages: Math.ceil(total / (query.limit ?? 20)),
      },
    };
  }

  async get(user: User, repoId: string, id: string | number): Promise<IssueDto> {
    await this.access.requireMember(user, repoId);
    const issue = await this.find(this.prisma, repoId, id);
    const nodes = await this.prisma.issue.findMany({
      where: { repoId },
      select: { id: true, parentId: true, estimateMinutes: true },
    });
    return { ...toIssueDto(issue), ...estimateTotals(nodes, issue.id) };
  }

  private async transaction<T>(
    user: User,
    repoId: string,
    fn: (tx: Prisma.TransactionClient, memberId: string) => Promise<T>,
  ) {
    await this.access.requireMember(user, repoId);
    return this.prisma.$transaction(
      async (tx) => {
        // Serialize hierarchy edits, code allocation and membership changes within a repository.
        await tx.$queryRaw`SELECT id FROM "Repository" WHERE id=${repoId} FOR UPDATE`;
        const member = await tx.repositoryMember.findUnique({
          where: {
            repositoryId_githubUserId: { repositoryId: repoId, githubUserId: user.githubId },
          },
        });
        if (!member?.isActive || member.userId !== user.id)
          throw new ForbiddenException('Membership không còn hoạt động');
        return fn(tx, member.id);
      },
      { timeout: 30000 },
    );
  }

  async create(user: User, repoId: string, dto: CreateIssueDto): Promise<IssueDto> {
    const issue = await this.transaction(user, repoId, async (tx, memberId) => {
      const id = randomUUID();
      const planning = this.planning(dto);
      validatePlanning(
        dto.startDate,
        planning.endDate?.toISOString().slice(0, 10),
        dto.estimateMinutes,
      );
      const nodes = await tx.issue.findMany({
        where: { repoId },
        select: { id: true, parentId: true, estimateMinutes: true },
      });
      validateHierarchy(nodes, id, dto.parentId ?? null);
      const assignee = await this.assignee(tx, repoId, dto.assigneeId, dto.assignees);
      const title = dto.title.trim();
      if (!title) throw new BadRequestException('Tiêu đề bắt buộc');
      const status = dto.status ?? IssueStatus.todo;
      const created = await tx.issue.create({
        data: {
          id,
          repoId,
          ...(await allocateIssueCode(tx, repoId, dto.trackerId)),
          title,
          body: dto.body ?? null,
          status,
          state: githubStateForStatus(status),
          ...planning,
          parentId: dto.parentId ?? null,
          ...assignee,
          labels: (dto.labels ?? []).map((name) => ({ name, color: 'ededed' })),
          authorLogin: user.login,
          authorAvatar: user.customAvatarUrl ?? user.avatarUrl,
          syncStatus: 'PENDING_SYNC',
          closedAt: githubStateForStatus(status) === 'closed' ? new Date() : null,
        },
      });
      await tx.issueStatusHistory.create({
        data: { issueId: id, toStatus: status, changedById: memberId },
      });
      await this.queue(tx, created);
      return created;
    });
    const result = await this.get(user, repoId, issue.id);
    this.realtime.emitIssueCreated(repoId, result);
    this.embeddings.queueRepo(repoId);
    return result;
  }

  async update(
    user: User,
    repoId: string,
    id: string | number,
    dto: UpdateIssueDto,
  ): Promise<IssueDto> {
    const issue = await this.transaction(user, repoId, async (tx, memberId) => {
      const existing = await this.find(tx, repoId, id);
      if (dto.title !== undefined && (dto.title === null || !dto.title.trim()))
        throw new BadRequestException('Tiêu đề bắt buộc');
      if (dto.trackerId && dto.trackerId !== existing.trackerId) {
        if (
          !(await tx.tracker.findFirst({
            where: { id: dto.trackerId, repositoryId: repoId, isActive: true },
          }))
        )
          throw new BadRequestException({
            code: 'TRACKER_INACTIVE',
            message: 'Tracker không hoạt động hoặc không thuộc repository',
          });
      }
      const planning = this.planning(dto);
      validatePlanning(
        dto.startDate === undefined
          ? existing.startDate?.toISOString().slice(0, 10)
          : dto.startDate,
        planning.endDate === undefined
          ? existing.endDate?.toISOString().slice(0, 10)
          : planning.endDate?.toISOString().slice(0, 10),
        dto.estimateMinutes === undefined ? existing.estimateMinutes : dto.estimateMinutes,
      );
      if (dto.parentId !== undefined) {
        const nodes = await tx.issue.findMany({
          where: { repoId },
          select: { id: true, parentId: true, estimateMinutes: true },
        });
        validateHierarchy(nodes, existing.id, dto.parentId);
      }
      const assignment =
        dto.assigneeId && dto.assigneeId === existing.assigneeId && dto.assignees === undefined
          ? {}
          : dto.assigneeId !== undefined || dto.assignees !== undefined
            ? await this.assignee(tx, repoId, dto.assigneeId, dto.assignees)
            : {};
      const status = dto.status ?? existing.status;
      const state = githubStateForStatus(status);
      const compatibleChanged =
        (dto.title !== undefined && dto.title.trim() !== existing.title) ||
        (dto.body !== undefined && dto.body !== existing.body) ||
        (dto.labels !== undefined &&
          JSON.stringify(dto.labels) !==
            JSON.stringify(
              (existing.labels as Array<{ name: string }>).map((label) => label.name),
            )) ||
        ('assignees' in assignment &&
          JSON.stringify(assignment.assignees) !== JSON.stringify(existing.assignees)) ||
        (dto.parentId !== undefined && dto.parentId !== existing.parentId) ||
        state !== existing.state;
      const updated = await tx.issue.update({
        where: { id: existing.id },
        data: {
          ...planning,
          ...assignment,
          ...(dto.title !== undefined && { title: dto.title.trim() }),
          ...(dto.body !== undefined && { body: dto.body }),
          ...(dto.labels !== undefined && {
            labels: dto.labels.map((name) => ({ name, color: 'ededed' })),
          }),
          ...(dto.trackerId && { trackerId: dto.trackerId }),
          ...(dto.parentId !== undefined && { parentId: dto.parentId }),
          status,
          state,
          closedAt: state === 'closed' ? (existing.closedAt ?? new Date()) : null,
          ...(compatibleChanged && { syncStatus: 'PENDING_SYNC' }),
        },
      });
      if (status !== existing.status)
        await tx.issueStatusHistory.create({
          data: {
            issueId: existing.id,
            fromStatus: existing.status,
            toStatus: status,
            changedById: memberId,
          },
        });
      if (compatibleChanged) await this.queue(tx, updated);
      if (updated.title !== existing.title || updated.body !== existing.body)
        await tx.$executeRaw`UPDATE "Issue" SET embedding=NULL WHERE id=${existing.id}`;
      return updated;
    });
    const result = await this.get(user, repoId, issue.id);
    this.realtime.emitIssueUpdated(repoId, result);
    this.embeddings.queueRepo(repoId);
    return result;
  }

  updateStatus(user: User, repoId: string, id: string | number, status: IssueStatus) {
    return this.update(user, repoId, id, { status });
  }
  setParent(user: User, repoId: string, id: string, parentId: string | null) {
    return this.update(user, repoId, id, { parentId });
  }
  async subIssues(user: User, repoId: string, id: string) {
    await this.get(user, repoId, id);
    const result = await this.list(user, repoId, { parentId: id });
    return result;
  }

  async cascadeClose(user: User, repoId: string, id: string) {
    await this.access.requireConnectedOwner(user, repoId);
    const rows = await this.transaction(user, repoId, async (tx, memberId) => {
      const role = await tx.repositoryMember.findUniqueOrThrow({ where: { id: memberId } });
      if (role.role !== 'OWNER') throw new ForbiddenException('Chỉ Owner được cascade close');
      const issue = await this.find(tx, repoId, id);
      const nodes = await tx.issue.findMany({
        where: { repoId },
        select: { id: true, parentId: true, estimateMinutes: true },
      });
      const ids = [issue.id, ...descendantIds(nodes, issue.id)];
      const updated: Issue[] = [];
      for (const target of await tx.issue.findMany({ where: { id: { in: ids }, repoId } })) {
        const row = await tx.issue.update({
          where: { id: target.id },
          data: {
            status: 'closed',
            state: 'closed',
            closedAt: target.closedAt ?? new Date(),
            syncStatus: target.state !== 'closed' ? 'PENDING_SYNC' : target.syncStatus,
          },
        });
        if (target.status !== 'closed')
          await tx.issueStatusHistory.create({
            data: {
              issueId: target.id,
              fromStatus: target.status,
              toStatus: 'closed',
              changedById: memberId,
            },
          });
        if (target.state !== 'closed') await this.queue(tx, row);
        updated.push(row);
      }
      return updated;
    });
    for (const row of rows)
      this.realtime.emitIssueUpdated(repoId, {
        ...toIssueDto(row),
        ...estimateTotals(rows, row.id),
      });
    return {
      data: rows.map((row) => ({ ...toIssueDto(row), ...estimateTotals(rows, row.id) })),
      message: 'Đã đóng issue và toàn bộ sub-issue',
    };
  }

  async backfill(user: User, repository: Pick<Repository, 'id' | 'owner' | 'name'>) {
    const issues = await this.github.listIssues(user, repository.owner, repository.name);
    for (const gh of issues) await this.upsertGithub(repository.id, gh);
    this.embeddings.queueRepo(repository.id);
    return issues.length;
  }
  async applyWebhook(repoId: string, action: string, gh: GithubIssue) {
    if (gh.pull_request) return;
    // GitHub deletion/transfer must not erase local issue history or its hierarchy.
    if (action === 'deleted' || action === 'transferred') {
      const issue = await this.prisma.issue.findUnique({
        where: { repoId_number: { repoId, number: gh.number } },
      });
      if (issue) {
        const row = await this.prisma.issue.update({
          where: { id: issue.id },
          data: { syncStatus: 'NEEDS_ATTENTION' },
        });
        this.realtime.emitIssueUpdated(repoId, toIssueDto(row));
      }
      return;
    }
    await this.upsertGithub(repoId, gh);
  }
  private async upsertGithub(repoId: string, gh: GithubIssue) {
    const result = await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Repository" WHERE id=${repoId} FOR UPDATE`;
        const existing = await tx.issue.findUnique({
          where: { repoId_number: { repoId, number: gh.number } },
        });
        const fields = toIssueFields(gh);
        if (
          existing &&
          ((existing.githubUpdatedAt && existing.githubUpdatedAt >= fields.githubUpdatedAt) ||
            existing.syncStatus === 'PENDING_SYNC')
        )
          return null;
        const status = statusFromGithub(
          existing?.status,
          existing?.state ?? null,
          fields.state,
        ) as IssueStatus;
        const assigned = fields.assignees[0]
          ? await tx.repositoryMember.findFirst({
              where: {
                repositoryId: repoId,
                login: { equals: fields.assignees[0].login, mode: 'insensitive' },
              },
            })
          : null;
        const row = existing
          ? await tx.issue.update({
              where: { id: existing.id },
              data: {
                ...fields,
                status,
                assigneeId: assigned?.id ?? null,
                assignees: fields.assignees.slice(0, 1),
              },
            })
          : await tx.issue.create({
              data: {
                repoId,
                ...fields,
                status,
                ...(await allocateIssueCode(tx, repoId)),
                assigneeId: assigned?.id ?? null,
                assignees: fields.assignees.slice(0, 1),
              },
            });
        if (!existing || status !== existing.status)
          await tx.issueStatusHistory.create({
            data: {
              issueId: row.id,
              fromStatus: existing?.status,
              toStatus: status,
              source: 'GITHUB_WEBHOOK',
            },
          });
        if (existing && (existing.title !== row.title || existing.body !== row.body))
          await tx.$executeRaw`UPDATE "Issue" SET embedding=NULL WHERE id=${row.id}`;
        return { row, created: !existing };
      },
      { timeout: 30000 },
    );
    if (!result) return;
    const graph = await this.prisma.issue.findMany({
      where: { repoId },
      select: { id: true, parentId: true, estimateMinutes: true },
    });
    const dto = { ...toIssueDto(result.row), ...estimateTotals(graph, result.row.id) };
    if (result.created) this.realtime.emitIssueCreated(repoId, dto);
    else this.realtime.emitIssueUpdated(repoId, dto);
    this.embeddings.queueRepo(repoId);
  }

  private planning(dto: UpdateIssueDto) {
    const end =
      dto.endDate !== undefined
        ? dto.endDate
        : dto.dueDate !== undefined
          ? (dto.dueDate?.slice(0, 10) ?? null)
          : undefined;
    validatePlanning(dto.startDate, end, dto.estimateMinutes);
    return {
      ...(dto.startDate !== undefined && {
        startDate: dto.startDate ? new Date(`${dto.startDate}T00:00:00Z`) : null,
      }),
      ...(end !== undefined && {
        endDate: end ? new Date(`${end}T00:00:00Z`) : null,
        dueDate: end ? new Date(`${end}T00:00:00Z`) : null,
      }),
      ...(dto.estimateMinutes !== undefined && { estimateMinutes: dto.estimateMinutes }),
    };
  }
  private async assignee(
    tx: Prisma.TransactionClient,
    repoId: string,
    id?: string | null,
    logins?: string[],
  ) {
    if (logins && logins.length > 1)
      throw new BadRequestException('Issue chỉ được có một assignee');
    if (id === null || (id === undefined && !logins?.length))
      return { assigneeId: null, assignees: [] };
    const member = await tx.repositoryMember.findFirst({
      where: {
        repositoryId: repoId,
        isActive: true,
        ...(id ? { id } : { login: { equals: logins?.[0], mode: 'insensitive' } }),
      },
    });
    if (!member)
      throw new BadRequestException('Assignee phải là thành viên hoạt động cùng repository');
    return {
      assigneeId: member.id,
      assignees: [{ login: member.login, avatarUrl: member.avatarUrl ?? '' }],
    };
  }
  private async queue(tx: Prisma.TransactionClient, issue: Issue) {
    if (await tx.syncJob.findFirst({ where: { issueId: issue.id, status: 'PENDING' } })) return;
    await tx.syncJob.create({
      data: {
        repositoryId: issue.repoId,
        issueId: issue.id,
        operation: issue.githubId === null ? 'CREATE' : 'UPDATE',
        idempotencyKey: `issue:${issue.id}:${randomUUID()}`,
      },
    });
  }
  private async find(
    tx: Pick<Prisma.TransactionClient, 'issue'>,
    repoId: string,
    id: string | number,
  ) {
    const issue =
      typeof id === 'number'
        ? await tx.issue.findUnique({ where: { repoId_number: { repoId, number: id } } })
        : await tx.issue.findFirst({ where: { id, repoId } });
    if (!issue) throw new NotFoundException('Không tìm thấy issue trong repository');
    return issue;
  }
}
