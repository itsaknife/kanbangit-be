import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient } from 'pg';
import type { Env } from '../config/env.js';
import type { Issue, SyncJob } from '../generated/prisma/client.js';
import { GithubService } from '../github/github.service.js';
import { assigneesOf, labelsOf, toIssueDto, toIssueFields } from '../issues/issue.mapper.js';
import { estimateTotals } from '../issues/issue.rules.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import {
  localIdFromBody,
  retryDecision,
  syncBody,
  syncFailure,
  SYNC_CONCURRENCY,
  SyncDependencyError,
} from './sync.rules.js';

@Injectable()
export class SyncWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SyncWorker.name);
  private readonly pool: Pool;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubService,
    private readonly realtime: RealtimeGateway,
    private readonly config: ConfigService<Env, true>,
  ) {
    this.pool = new Pool({
      connectionString: config.get('DATABASE_URL', { infer: true }),
      ssl: config.get('DATABASE_SSL', { infer: true }) ? { rejectUnauthorized: false } : false,
      max: SYNC_CONCURRENCY,
      connectionTimeoutMillis: 10000,
    });
    this.pool.on('error', () => this.logger.error('Mất kết nối khóa worker GitHub Sync.'));
  }
  onModuleInit() {
    if (!this.config.get('SYNC_WORKER_ENABLED', { infer: true })) return;
    const tick = () => {
      if (!this.stopped && !this.running) {
        this.running = this.drain()
          .catch(() => this.logger.error('Worker GitHub Sync không thể đọc hàng đợi.'))
          .finally(() => {
            this.running = undefined;
          });
      }
    };
    this.timer = setInterval(tick, 5000);
    tick();
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
    await this.pool.end();
  }
  async drain() {
    const jobs = await this.prisma.syncJob.findMany({
      where: {
        repository:{providerType:'GITHUB'},
        OR: [
          { status: { in: ['PENDING', 'PROCESSING'] } },
          { status: 'RETRY_WAIT', nextRetryAt: { lte: new Date() } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    if (!jobs.length) return;
    let next = 0;
    await Promise.all(
      Array.from({ length: SYNC_CONCURRENCY }, async (_, slot) => {
        const client = await this.pool.connect();
        let locked = false;
        let connectionLost = false;
        const onError = () => {
          connectionLost = true;
        };
        client.on('error', onError);
        try {
          locked = await this.lock(client, `kanbangit-sync-slot:${slot}`);
          if (!locked) return;
          while (next < jobs.length && !this.stopped && !connectionLost) {
            const job = jobs[next++];
            if (!(await this.lock(client, `kanbangit-sync-issue:${job.issueId}`))) continue;
            try {
              await this.process(job.id, () => !connectionLost);
            } catch {
              this.logger.error('Lượt xử lý GitHub Sync bị gián đoạn; outbox sẽ được khôi phục.');
            } finally {
              if (!connectionLost) await this.unlock(client, `kanbangit-sync-issue:${job.issueId}`);
            }
          }
        } finally {
          try {
            if (locked && !connectionLost) await this.unlock(client, `kanbangit-sync-slot:${slot}`);
          } finally {
            client.removeListener('error', onError);
            client.release(connectionLost);
          }
        }
      }),
    );
  }
  private async lock(client: PoolClient, key: string) {
    return (
      await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',
        [key],
      )
    ).rows[0].locked;
  }
  private async unlock(client: PoolClient, key: string) {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]);
  }
  /** Called only while holding the session-level slot and issue locks. No network I/O under repo row locks. */
  async process(id: string, ownsLock: () => boolean = () => true) {
    const selected = await this.prisma.syncJob.findUnique({ where: { id } });
    if (!selected) return;
    const claim = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Repository" WHERE id=${selected.repositoryId} FOR UPDATE`;
      const job = await tx.syncJob.findUniqueOrThrow({ where: { id } });
      if (
        !['PENDING', 'PROCESSING', 'RETRY_WAIT'].includes(job.status) ||
        (job.status === 'RETRY_WAIT' && job.nextRetryAt && job.nextRetryAt > new Date())
      )
        return null;
      const repository = await tx.repository.findUniqueOrThrow({ where: { id: job.repositoryId } });
      const issue = await tx.issue.findUniqueOrThrow({ where: { id: job.issueId } });
      // retryCount counts automatic retries, excluding the initial attempt. Recovering a crashed
      // PROCESSING attempt reconciles CREATE first and does not consume another retry.
      const retryCount = job.retryCount + (job.status === 'RETRY_WAIT' ? 1 : 0);
      await tx.syncJob.update({
        where: { id },
        data: { status: 'PROCESSING', retryCount, nextRetryAt: null },
      });
      const owner = await tx.repositoryMember.findFirst({
        where: {
          repositoryId: job.repositoryId,
          userId: repository.connectedById,
          role: 'OWNER',
          isActive: true,
        },
        include: { user: true },
      });
      return { job: { ...job, retryCount }, issue, repository, user: owner?.user ?? null };
    });
    if (!claim || !ownsLock()) return;
    const { job, issue, repository, user } = claim;
    try {
      if (repository.providerType !== 'GITHUB' || !repository.owner) throw Object.assign(new Error('Invalid provider'), {status:422});
      if (!user) throw Object.assign(new Error('No active connector'), { status: 403 });
      await this.github.requireWrite(user, repository.owner, repository.name);
      let number = issue.number;
      if (number === null) {
        // Reconcile the stable hidden marker before EVERY create, including process restarts and
        // a timeout after GitHub accepted POST. Do not use the search API's delayed index.
        const existing = (
          await this.github.listIssues(user, repository.owner, repository.name)
        ).find((candidate) => localIdFromBody(candidate.body) === issue.id);
        if (!ownsLock()) return;
        const gh =
          existing ??
          (await this.github.createIssue(user, repository.owner, repository.name, {
            title: issue.title,
            body: syncBody(issue.body, issue.id),
            labels: labelsOf(issue).map((l) => l.name),
            assignees: assigneesOf(issue).map((a) => a.login),
          }));
        number = gh.number;
        if (!ownsLock()) return;
        await this.prisma.issue.update({
          where: { id: issue.id },
          data: {
            githubId: BigInt(gh.id),
            number,
            htmlUrl: gh.html_url,
            githubCreatedAt: new Date(gh.created_at),
          },
        });
      }
      if (!ownsLock()) return;
      const gh = await this.github.updateIssue(user, repository.owner, repository.name, number, {
        title: issue.title,
        body: syncBody(issue.body, issue.id),
        labels: labelsOf(issue).map((l) => l.name),
        assignees: assigneesOf(issue).map((a) => a.login),
        state: issue.state,
      });
      const returned = toIssueFields(gh);
      const names = (values: string[]) => JSON.stringify(values.map((v) => v.toLowerCase()).sort());
      if (
        returned.title !== issue.title ||
        (returned.body ?? '') !== (issue.body ?? '') ||
        returned.state !== issue.state ||
        names(returned.labels.map((l) => l.name)) !== names(labelsOf(issue).map((l) => l.name)) ||
        names(returned.assignees.map((a) => a.login)) !==
          names(assigneesOf(issue).map((a) => a.login))
      ) {
        // GitHub can silently ignore assignees when a collaborator is no longer assignable.
        throw Object.assign(new Error('GitHub did not accept all compatible fields'), {
          status: 422,
        });
      }
      let parentNumber: number | null = null;
      if (issue.parentId) {
        const parent = await this.prisma.issue.findUniqueOrThrow({ where: { id: issue.parentId } });
        if (parent.number === null) {
          if (parent.syncStatus === 'NEEDS_ATTENTION')
            throw Object.assign(new Error('Parent sync failed'), { status: 422 });
          throw new SyncDependencyError();
        }
        parentNumber = parent.number;
      }
      if (!ownsLock()) return;
      await this.github.setParent(user, repository.owner, repository.name, gh, parentNumber);
      if (!ownsLock()) return;
      await this.complete(job, issue, new Date(gh.updated_at));
    } catch (error) {
      if (ownsLock()) await this.fail(job, issue, error);
    }
  }
  private async complete(job: SyncJob, snapshot: Issue, githubUpdatedAt: Date) {
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Repository" WHERE id=${job.repositoryId} FOR UPDATE`;
      const current = await tx.issue.findUniqueOrThrow({ where: { id: snapshot.id } });
      // A deletion/transfer webhook may commit after the HTTP response, before this commit.
      if (current.syncStatus === 'NEEDS_ATTENTION') {
        await tx.syncJob.update({
          where: { id: job.id },
          data: {
            status: 'FAILED',
            processedAt: new Date(),
            nextRetryAt: null,
            lastError: 'Issue trên GitHub đã bị xóa hoặc chuyển repository. Owner cần kiểm tra.',
          },
        });
        return current;
      }
      const latest = current.syncVersion === snapshot.syncVersion;
      await tx.syncJob.update({
        where: { id: job.id },
        data: {
          status: latest ? 'SUCCEEDED' : 'PENDING',
          processedAt: latest ? new Date() : null,
          lastError: null,
          nextRetryAt: null,
          operation: 'UPDATE',
        },
      });
      return tx.issue.update({
        where: { id: snapshot.id },
        data: {
          syncStatus: latest ? 'SYNCED' : 'PENDING_SYNC',
          lastSyncedAt: new Date(),
          githubUpdatedAt:
            !current.githubUpdatedAt || githubUpdatedAt > current.githubUpdatedAt
              ? githubUpdatedAt
              : undefined,
        },
      });
    });
    await this.emit(row);
  }
  private async fail(job: SyncJob, snapshot: Issue, error: unknown) {
    const failure = syncFailure(error);
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Repository" WHERE id=${job.repositoryId} FOR UPDATE`;
      const current = await tx.issue.findUniqueOrThrow({ where: { id: job.issueId } });
      const decision = retryDecision(
        job.retryCount,
        failure.temporary && current.syncStatus !== 'NEEDS_ATTENTION',
      );
      // A rejection of an older snapshot must not park the user's already-corrected data.
      if (current.syncVersion !== snapshot.syncVersion) {
        await tx.syncJob.update({
          where: { id: job.id },
          data: {
            status: 'PENDING',
            lastError: null,
            nextRetryAt: null,
            processedAt: null,
          },
        });
        return tx.issue.update({
          where: { id: job.issueId },
          data: { syncStatus: 'PENDING_SYNC' },
        });
      }
      await tx.syncJob.update({
        where: { id: job.id },
        data: {
          ...decision,
          lastError: failure.message,
          processedAt: decision.status === 'FAILED' ? new Date() : null,
        },
      });
      return tx.issue.update({
        where: { id: job.issueId },
        data: {
          syncStatus: decision.status === 'FAILED' ? 'NEEDS_ATTENTION' : 'PENDING_SYNC',
        },
      });
    });
    await this.emit(row);
  }
  private async emit(row: Issue) {
    const graph = await this.prisma.issue.findMany({
      where: { repoId: row.repoId },
      select: { id: true, parentId: true, estimateMinutes: true },
    });
    this.realtime.emitIssueUpdated(row.repoId, {
      ...toIssueDto(row),
      ...estimateTotals(graph, row.id),
    });
  }
}
