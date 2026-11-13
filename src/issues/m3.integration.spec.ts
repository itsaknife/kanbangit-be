import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { parse } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient, type User, type IssueStatus } from '../generated/prisma/client.js';
import { AccessService } from '../access/access.service.js';
import type { GithubService } from '../github/github.service.js';
import type { GithubIssue } from '../github/github.types.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { RealtimeGateway } from '../realtime/realtime.gateway.js';
import type { EmbeddingService } from '../ai/embedding.service.js';
import type { CreateIssueDto } from './dto/create-issue.dto.js';
import { IssuesService } from './issues.service.js';

// Explicit opt-in; migrations and all fixtures live in a disposable private schema.
// Never run prisma migrate deploy/db push or query application public tables here.
describe.skipIf(process.env.RUN_M3_DB_TESTS !== '1')(
  'M3 isolated PostgreSQL issue workflows',
  { timeout: 30000 },
  () => {
    const schema = `m3_test_${randomUUID().replaceAll('-', '')}`;
    let client: Client;
    let prisma: PrismaClient;
    let access: AccessService;
    let service: IssuesService;
    let owner: User;
    let member: User;
    let repoId: string;
    let otherRepoId: string;
    let trackerId: string;
    let foreignTrackerId: string;
    let memberId: string;
    let foreignMemberId: string;
    let remoteId = 5000;
    let connected = false;
    const offline = async () => {
      throw new Error('GitHub must not be called by local operations');
    };
    const github = {
      listRepos: vi.fn(offline),
      listIssues: vi.fn(offline),
      createIssue: vi.fn(offline),
      updateIssue: vi.fn(offline),
    };
    const realtime = {
      emitIssueCreated: vi.fn(),
      emitIssueUpdated: vi.fn(),
      emitIssueDeleted: vi.fn(),
    };
    const embeddings = { queueRepo: vi.fn() };

    beforeAll(async () => {
      const config = { ...(existsSync('.env') ? parse(readFileSync('.env')) : {}), ...process.env };
      const connectionString = config.DATABASE_URL;
      if (!connectionString) throw new Error('DATABASE_URL required for RUN_M3_DB_TESTS=1');
      const ssl = config.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false;
      client = new Client({
        connectionString,
        ssl,
        connectionTimeoutMillis: 10000,
        statement_timeout: 20000,
      });
      await client.connect();
      connected = true;
      const extension = await client.query<{ nspname: string }>(
        `SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector'`,
      );
      const vectorSchema = extension.rows[0]?.nspname;
      if (!vectorSchema || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(vectorSchema))
        throw new Error('Existing pgvector extension required');
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}","${vectorSchema}"`);
      const migrations = readdirSync(resolve('prisma/migrations'))
        .filter((name) => /^\d+_/.test(name))
        .sort();
      expect(migrations).toContain('202611130006_issue_management');
      for (const migration of migrations) {
        await client.query(
          readFileSync(resolve('prisma/migrations', migration, 'migration.sql'), 'utf8'),
        );
      }
      // Fail closed before starting Prisma if migration tables escaped isolation.
      const location = await client.query<{ table_schema: string }>(
        `SELECT table_schema FROM information_schema.tables WHERE table_schema=$1 AND table_name IN ('Issue','SyncJob','IssueStatusHistory')`,
        [schema],
      );
      expect(location.rows).toHaveLength(3);
      prisma = new PrismaClient({
        adapter: new PrismaPg(
          { connectionString, ssl, options: `-c search_path=${schema},${vectorSchema}` },
          { schema },
        ),
      });
      await prisma.$connect();
      access = new AccessService(
        github as unknown as GithubService,
        prisma as unknown as PrismaService,
      );
      service = new IssuesService(
        prisma as unknown as PrismaService,
        github as unknown as GithubService,
        access,
        realtime as unknown as RealtimeGateway,
        embeddings as unknown as EmbeddingService,
      );
      owner = await prisma.user.create({
        data: { githubId: 1n, login: 'owner', avatarUrl: 'avatar', accessToken: 'ciphertext' },
      });
      member = await prisma.user.create({
        data: { githubId: 2n, login: 'member', avatarUrl: 'avatar', accessToken: 'ciphertext' },
      });
    }, 60000);

    afterAll(async () => {
      if (prisma) await prisma.$disconnect();
      if (client && connected) {
        try {
          await client.query('ROLLBACK');
          if (!/^m3_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe cleanup schema');
          await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        } finally {
          await client.end();
        }
      }
    }, 30000);

    beforeEach(async () => {
      vi.clearAllMocks();
      remoteId += 1;
      const createRepo = async () => {
        const suffix = randomUUID();
        const repo = await prisma.repository.create({
          data: {
            githubId: BigInt(`0x${suffix.replaceAll('-', '').slice(0, 12)}`),
            name: suffix,
            owner: owner.login,
            fullName: `owner/${suffix}`,
            isPrivate: true,
            connectedById: owner.id,
          },
        });
        await prisma.repositoryMember.create({
          data: {
            repositoryId: repo.id,
            githubUserId: owner.githubId,
            login: owner.login,
            userId: owner.id,
            role: 'OWNER',
          },
        });
        const membership = await prisma.repositoryMember.create({
          data: {
            repositoryId: repo.id,
            githubUserId: member.githubId,
            login: member.login,
            userId: member.id,
            role: 'MEMBER',
          },
        });
        const tracker = await prisma.tracker.create({
          data: { repositoryId: repo.id, name: 'Task', prefix: 'TASK', color: '#123456' },
        });
        return { repo, membership, tracker };
      };
      const local = await createRepo();
      const foreign = await createRepo();
      repoId = local.repo.id;
      trackerId = local.tracker.id;
      memberId = local.membership.id;
      otherRepoId = foreign.repo.id;
      foreignTrackerId = foreign.tracker.id;
      foreignMemberId = foreign.membership.id;
    }, 30000);

    afterEach(() => {
      vi.restoreAllMocks();
      for (const call of Object.values(github)) expect(call).not.toHaveBeenCalled();
    });

    const create = (dto: Partial<CreateIssueDto> = {}) =>
      service.create(member, repoId, { title: 'Local task', trackerId, ...dto });
    const jobs = (issueId: string) =>
      prisma.syncJob.findMany({ where: { issueId, status: 'PENDING' } });
    const history = (issueId: string) =>
      prisma.issueStatusHistory.findMany({ where: { issueId }, orderBy: { createdAt: 'asc' } });
    const webhook = (extra: Partial<GithubIssue> = {}): GithubIssue => ({
      id: remoteId,
      number: 1,
      title: 'Remote title',
      body: 'Remote body',
      state: 'open',
      labels: [],
      assignees: [],
      user: { login: 'author', avatar_url: 'avatar' },
      html_url: 'https://github.com/o/r/issues/1',
      created_at: '2026-11-01T00:00:00Z',
      updated_at: '2026-11-02T00:00:00Z',
      closed_at: null,
      ...extra,
    });
    async function linked(dto: Partial<CreateIssueDto> = {}) {
      const issue = await create(dto);
      await prisma.issue.update({
        where: { id: issue.id },
        data: {
          githubId: BigInt(remoteId),
          number: 1,
          syncStatus: 'SYNCED',
          githubUpdatedAt: new Date('2026-11-01T00:00:00Z'),
        },
      });
      await prisma.syncJob.updateMany({
        where: { issueId: issue.id },
        data: { status: 'COMPLETED' },
      });
      return issue;
    }

    it('commits local UUID issue, actor history and CREATE outbox before realtime with GitHub offline', async () => {
      const issue = await create({
        assigneeId: memberId,
        estimateMinutes: 60,
        startDate: '2026-11-13',
        endDate: '2026-11-14',
      });
      expect(issue).toMatchObject({
        number: null,
        htmlUrl: null,
        issueCode: 'TASK-001',
        syncStatus: 'PENDING_SYNC',
        assigneeId: memberId,
        startDate: '2026-11-13',
        endDate: '2026-11-14',
        estimateMinutes: 60,
      });
      expect(issue.id).toMatch(/^[a-f0-9-]{36}$/);
      expect(await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } })).toMatchObject({
        githubId: null,
        number: null,
      });
      expect(await jobs(issue.id)).toEqual([
        expect.objectContaining({ operation: 'CREATE', repositoryId: repoId }),
      ]);
      expect(await history(issue.id)).toEqual([
        expect.objectContaining({
          toStatus: 'todo',
          fromStatus: null,
          changedById: memberId,
          source: 'APP',
        }),
      ]);
      expect(realtime.emitIssueCreated).toHaveBeenCalledWith(
        repoId,
        expect.objectContaining({ id: issue.id }),
      );
      expect((await service.get(member, repoId, issue.id)).id).toBe(issue.id);
    });

    it.each(['foreign', 'inactive'] as const)(
      'rejects %s assignees and Trackers without partial writes',
      async (kind) => {
        let badTracker = foreignTrackerId;
        let badMember = foreignMemberId;
        if (kind === 'inactive') {
          await prisma.tracker.update({ where: { id: trackerId }, data: { isActive: false } });
          await prisma.repositoryMember.update({
            where: { id: memberId },
            data: { isActive: false },
          });
          badTracker = trackerId;
          badMember = memberId;
        }
        await expect(
          service.create(owner, repoId, { title: 'Rejected tracker', trackerId: badTracker }),
        ).rejects.toThrow();
        if (kind === 'inactive')
          await prisma.tracker.update({ where: { id: trackerId }, data: { isActive: true } });
        await expect(
          service.create(owner, repoId, {
            title: 'Rejected assignee',
            trackerId,
            assigneeId: badMember,
          }),
        ).rejects.toThrow();
        expect(await prisma.issue.count({ where: { repoId } })).toBe(0);
        expect(await prisma.syncJob.count({ where: { repositoryId: repoId } })).toBe(0);
        expect(realtime.emitIssueCreated).not.toHaveBeenCalled();
      },
    );

    it('rejects multiple assignees and validates update repository boundaries in service and SQL', async () => {
      await expect(create({ assignees: ['owner', 'member'] })).rejects.toThrow();
      const issue = await create();
      for (const patch of [{ trackerId: foreignTrackerId }, { assigneeId: foreignMemberId }]) {
        await expect(service.update(member, repoId, issue.id, patch)).rejects.toThrow();
        await expect(
          prisma.issue.update({ where: { id: issue.id }, data: patch }),
        ).rejects.toThrow();
      }
      await expect(service.get(member, otherRepoId, issue.id)).rejects.toThrow();
      await expect(
        service.update(member, otherRepoId, issue.id, { title: 'Stolen' }),
      ).rejects.toThrow();
    });

    it.each([-30, 1, 45, 30.5])('rolls back invalid estimate %s', async (estimateMinutes) => {
      await expect(create({ estimateMinutes })).rejects.toThrow();
      expect(await prisma.issue.count({ where: { repoId } })).toBe(0);
      expect(await prisma.syncJob.count({ where: { repositoryId: repoId } })).toBe(0);
    });

    it.each([
      { startDate: '2026-02-30' },
      { endDate: '2026-13-01' },
      { startDate: '2026-11-15', endDate: '2026-11-14' },
    ])('rejects invalid calendar planning %j', async (dto) => {
      await expect(create(dto)).rejects.toThrow();
      expect(await prisma.issue.count({ where: { repoId } })).toBe(0);
    });

    it('validates partial dates against stored dates, allows zero and null, and keeps local planning SYNCED', async () => {
      const issue = await linked({
        startDate: '2026-11-13',
        endDate: '2026-11-14',
        estimateMinutes: 30,
      });
      await expect(
        service.update(member, repoId, issue.id, { startDate: '2026-11-15' }),
      ).rejects.toThrow();
      await expect(
        service.update(member, repoId, issue.id, { endDate: '2026-11-12' }),
      ).rejects.toThrow();
      const updated = await service.update(member, repoId, issue.id, {
        estimateMinutes: 0,
        endDate: '2026-11-15',
      });
      expect(updated).toMatchObject({
        syncStatus: 'SYNCED',
        estimateMinutes: 0,
        endDate: '2026-11-15',
      });
      expect(await jobs(issue.id)).toHaveLength(0);
      expect(
        await service.update(member, repoId, issue.id, {
          startDate: null,
          endDate: null,
          estimateMinutes: null,
        }),
      ).toMatchObject({ startDate: null, endDate: null, dueDate: null, estimateMinutes: null });
      await expect(
        prisma.issue.update({ where: { id: issue.id }, data: { estimateMinutes: 45 } }),
      ).rejects.toThrow();
      await expect(
        prisma.issue.update({
          where: { id: issue.id },
          data: { startDate: new Date('2026-11-15'), endDate: new Date('2026-11-14') },
        }),
      ).rejects.toThrow();
    });

    it('rejects cycles, foreign parents, fourth levels and moving a deep subtree; rollback preserves graph', async () => {
      const root = await create();
      const child = await create({ parentId: root.id });
      const grandchild = await create({ parentId: child.id });
      const otherRoot = await create();
      const foreign = await service.create(member, otherRepoId, {
        title: 'Foreign',
        trackerId: foreignTrackerId,
      });
      await expect(service.setParent(member, repoId, root.id, root.id)).rejects.toThrow();
      await expect(service.setParent(member, repoId, root.id, grandchild.id)).rejects.toThrow();
      await expect(service.setParent(member, repoId, root.id, otherRoot.id)).rejects.toThrow();
      await expect(service.setParent(member, repoId, child.id, foreign.id)).rejects.toThrow();
      await expect(create({ parentId: grandchild.id })).rejects.toThrow();
      await expect(
        prisma.issue.update({ where: { id: child.id }, data: { parentId: foreign.id } }),
      ).rejects.toThrow();
      expect(await service.get(member, repoId, root.id)).toHaveProperty('parentId', null);
      expect(await service.get(member, repoId, child.id)).toHaveProperty('parentId', root.id);
      expect(await service.setParent(member, repoId, child.id, null)).toHaveProperty(
        'parentId',
        null,
      );
    });

    it('computes descendant totals without replacing own estimate, including pagination and filtering', async () => {
      const root = await create({ estimateMinutes: 30 });
      const child = await create({ parentId: root.id, estimateMinutes: 60 });
      await create({ parentId: child.id, estimateMinutes: 90 });
      expect(await service.get(member, repoId, root.id)).toMatchObject({
        estimateMinutes: 30,
        subIssueEstimateMinutes: 150,
        combinedEstimateMinutes: 180,
      });
      expect(await service.get(member, repoId, child.id)).toMatchObject({
        estimateMinutes: 60,
        subIssueEstimateMinutes: 90,
        combinedEstimateMinutes: 150,
      });
      const result = await service.list(member, repoId, {
        search: root.issueCode.toLowerCase(),
        page: 1,
        limit: 1,
      });
      expect(Array.isArray(result)).toBe(false);
      if (Array.isArray(result)) throw new Error('Expected paginated result');
      expect(result.data).toEqual([
        expect.objectContaining({ id: root.id, combinedEstimateMinutes: 180 }),
      ]);
      expect(result.pagination).toMatchObject({ total: 1, totalPages: 1 });
      const children = await service.subIssues(member, repoId, root.id);
      expect(Array.isArray(children) ? children : children.data).toEqual([
        expect.objectContaining({ id: child.id }),
      ]);
      const empty = await create();
      expect(await service.get(member, repoId, empty.id)).toMatchObject({
        subIssueEstimateMinutes: 0,
        combinedEstimateMinutes: null,
      });
    });

    it('preserves issue codes through Tracker changes and rejects direct SQL code mutation', async () => {
      const issue = await create();
      const tracker = await prisma.tracker.create({
        data: { repositoryId: repoId, name: 'Bug', prefix: 'BUG', color: '#654321' },
      });
      expect(
        await service.update(member, repoId, issue.id, { trackerId: tracker.id }),
      ).toMatchObject({ issueCode: issue.issueCode, trackerId: tracker.id });
      await expect(
        prisma.issue.update({ where: { id: issue.id }, data: { issueCode: 'FORGED-001' } }),
      ).rejects.toThrow();
    });

    it('coalesces concurrent pending CREATE jobs and creates UPDATE after prior job completion', async () => {
      const issue = await create();
      await Promise.all(
        ['One', 'Two', 'Three'].map((title) => service.update(member, repoId, issue.id, { title })),
      );
      expect(await jobs(issue.id)).toEqual([expect.objectContaining({ operation: 'CREATE' })]);
      await prisma.syncJob.updateMany({
        where: { issueId: issue.id },
        data: { status: 'COMPLETED' },
      });
      await prisma.issue.update({
        where: { id: issue.id },
        data: { githubId: BigInt(remoteId), number: 1, syncStatus: 'SYNCED' },
      });
      await service.update(member, repoId, issue.id, { body: 'Changed' });
      const pending = await jobs(issue.id);
      expect(pending).toEqual([expect.objectContaining({ operation: 'UPDATE' })]);
      expect(
        new Set(
          (await prisma.syncJob.findMany({ where: { issueId: issue.id } })).map(
            (job) => job.idempotencyKey,
          ),
        ).size,
      ).toBe(2);
    });

    it('does not queue unchanged assignment or labels and allows retaining an inactive historical assignee', async () => {
      const issue = await linked({ assigneeId: memberId, labels: ['bug'] });
      await prisma.repositoryMember.update({ where: { id: memberId }, data: { isActive: false } });
      expect(
        await service.update(owner, repoId, issue.id, { assigneeId: memberId, labels: ['bug'] }),
      ).toHaveProperty('syncStatus', 'SYNCED');
      expect(await jobs(issue.id)).toHaveLength(0);
      expect(await history(issue.id)).toHaveLength(1);
    });

    it('maps all nine statuses and records transitions once with an existing member actor', async () => {
      const issue = await create();
      const statuses: IssueStatus[] = [
        'in_progress',
        'done',
        'verified',
        'closed',
        'reopen',
        'rejected',
        'paused',
        'canceled',
        'todo',
      ];
      for (const status of statuses) {
        const closed = status === 'closed' || status === 'canceled';
        const updated = await service.updateStatus(member, repoId, issue.id, status);
        expect(updated).toMatchObject({ status, state: closed ? 'closed' : 'open' });
        expect(updated.closedAt === null).toBe(!closed);
      }
      await service.updateStatus(member, repoId, issue.id, 'todo');
      const rows = await history(issue.id);
      expect(rows.map((row) => row.toStatus)).toEqual(['todo', ...statuses]);
      expect(rows.every((row) => row.changedById === memberId && row.source === 'APP')).toBe(true);
      expect(rows.slice(1).map((row) => row.fromStatus)).toEqual([
        'todo',
        ...statuses.slice(0, -1),
      ]);
      expect(await jobs(issue.id)).toHaveLength(1);
    });

    it('preserves local planning, hierarchy, code and status on webhook edits; records close/reopen history', async () => {
      const parent = await create();
      const issue = await linked({
        parentId: parent.id,
        startDate: '2026-11-13',
        endDate: '2026-11-15',
        estimateMinutes: 90,
        status: 'done',
      });
      await service.applyWebhook(repoId, 'edited', webhook());
      expect(await service.get(member, repoId, issue.id)).toMatchObject({
        title: 'Remote title',
        issueCode: issue.issueCode,
        trackerId,
        parentId: parent.id,
        startDate: '2026-11-13',
        endDate: '2026-11-15',
        estimateMinutes: 90,
        status: 'done',
        state: 'open',
      });
      await service.applyWebhook(
        repoId,
        'closed',
        webhook({
          state: 'closed',
          updated_at: '2026-11-03T00:00:00Z',
          closed_at: '2026-11-03T00:00:00Z',
        }),
      );
      await service.applyWebhook(
        repoId,
        'reopened',
        webhook({ updated_at: '2026-11-04T00:00:00Z' }),
      );
      await service.applyWebhook(
        repoId,
        'edited',
        webhook({ title: 'Stale', updated_at: '2026-11-02T00:00:00Z' }),
      );
      expect(await service.get(member, repoId, issue.id)).toMatchObject({
        status: 'reopen',
        state: 'open',
        title: 'Remote title',
      });
      expect((await history(issue.id)).map((row) => [row.toStatus, row.source])).toEqual([
        ['done', 'APP'],
        ['closed', 'GITHUB_WEBHOOK'],
        ['reopen', 'GITHUB_WEBHOOK'],
      ]);
      expect(await jobs(issue.id)).toHaveLength(0);
    });

    it('protects pending local edits from webhooks and preserves rows on deletion/transfer', async () => {
      const issue = await linked();
      await service.update(member, repoId, issue.id, { title: 'Pending local title' });
      await service.applyWebhook(repoId, 'edited', webhook());
      expect(await service.get(member, repoId, issue.id)).toHaveProperty(
        'title',
        'Pending local title',
      );
      for (const action of ['deleted', 'transferred']) {
        await service.applyWebhook(repoId, action, webhook());
        expect(await service.get(member, repoId, issue.id)).toHaveProperty(
          'syncStatus',
          'NEEDS_ATTENTION',
        );
      }
      expect(await history(issue.id)).toHaveLength(1);
      expect(await jobs(issue.id)).toHaveLength(1);
      expect(realtime.emitIssueDeleted).not.toHaveBeenCalled();
    });

    it('only Owner can cascade close; keeps rows, hierarchy, history and coalesced jobs', async () => {
      const root = await linked();
      const child = await create({ parentId: root.id });
      const grandchild = await create({ parentId: child.id });
      const unrelated = await create();
      await expect(service.cascadeClose(member, repoId, root.id)).rejects.toThrow();
      expect(await service.get(member, repoId, root.id)).toHaveProperty('status', 'todo');
      const result = await service.cascadeClose(owner, repoId, root.id);
      expect(result.data).toHaveLength(3);
      for (const issue of [root, child, grandchild]) {
        expect(await service.get(member, repoId, issue.id)).toMatchObject({
          status: 'closed',
          state: 'closed',
        });
        expect(await jobs(issue.id)).toHaveLength(1);
        expect(await history(issue.id)).toHaveLength(2);
      }
      expect(await jobs(root.id)).toEqual([expect.objectContaining({ operation: 'UPDATE' })]);
      expect(await service.get(member, repoId, grandchild.id)).toHaveProperty('parentId', child.id);
      expect(await service.get(member, repoId, unrelated.id)).toHaveProperty('status', 'todo');
      await service.cascadeClose(owner, repoId, root.id);
      expect(await history(root.id)).toHaveLength(2);
      expect(await prisma.issue.count({ where: { repoId } })).toBe(4);
    });

    it('revalidates membership inside the transaction even after the initial access check passed', async () => {
      const issue = await create();
      const original = access.requireMember.bind(access);
      vi.spyOn(access, 'requireMember').mockImplementationOnce(async (user, id) => {
        const allowed = await original(user, id);
        await prisma.repositoryMember.update({
          where: { id: memberId },
          data: { isActive: false },
        });
        return allowed;
      });
      await expect(service.update(member, repoId, issue.id, { title: 'Denied' })).rejects.toThrow();
      expect(await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } })).toHaveProperty(
        'title',
        'Local task',
      );
      await expect(service.list(member, repoId)).rejects.toThrow();
      await expect(service.get(member, repoId, issue.id)).rejects.toThrow();
      await expect(create()).rejects.toThrow();
      expect(await history(issue.id)).toHaveLength(1);
      expect(await jobs(issue.id)).toHaveLength(1);
    });
  },
);
