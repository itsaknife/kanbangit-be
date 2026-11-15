import 'reflect-metadata';
import { randomUUID, createHmac } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { Client } from 'pg';
import { parse } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe, type ExecutionContext, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { PrismaClient, type User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Env } from '../config/env.js';
import { AccessService } from '../access/access.service.js';
import { GithubService } from '../github/github.service.js';
import type { GithubIssue } from '../github/github.types.js';
import { IssuesService } from '../issues/issues.service.js';
import type { EmbeddingService } from '../ai/embedding.service.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { WebhooksService } from '../webhooks/webhooks.service.js';
import { WebhooksController } from '../webhooks/webhooks.controller.js';
import { SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';
import { SyncWorker } from './sync.worker.js';
import { syncBody } from './sync.rules.js';

describe.skipIf(process.env.RUN_M5_DB_TESTS !== '1')(
  'M5 PostgreSQL outbox/worker/webhook/API',
  { timeout: 30000 },
  () => {
    const schema = 'm5_test_' + randomUUID().replaceAll('-', '');
    let sql: Client,
      db: PrismaClient,
      worker: SyncWorker,
      worker2: SyncWorker,
      issues: IssuesService,
      sync: SyncService,
      hooks: WebhooksService,
      app: INestApplication;
    let owner: User, member: User, outsider: User, repoId: string, trackerId: string;
    let config: ConfigService<Env, true>;
    const realtime = { emitIssueCreated: vi.fn(), emitIssueUpdated: vi.fn() };
    const github = {
      requireWrite: vi.fn(),
      listIssues: vi.fn(),
      createIssue: vi.fn(),
      updateIssue: vi.fn(),
      setParent: vi.fn(),
    };
    let counter = 100;
    const gh = (overrides: Partial<GithubIssue> = {}): GithubIssue => ({
      id: 9000 + counter,
      number: counter,
      title: 'GitHub',
      body: '',
      state: 'open',
      labels: [],
      assignees: [],
      user: { login: 'owner', avatar_url: '' },
      html_url: `https://github.com/owner/repo/issues/${counter}`,
      created_at: '2020-01-01T00:00:00Z',
      updated_at: '2020-01-02T00:00:00Z',
      closed_at: null,
      ...overrides,
    });
    const create = (payload = {}) =>
      issues.create(member, repoId, { trackerId, title: 'Local', ...payload });
    const jobFor = (issueId: string) =>
      db.syncJob.findFirstOrThrow({ where: { issueId }, orderBy: { createdAt: 'desc' } });
    beforeAll(async () => {
      const raw = { ...parse(readFileSync('.env')), ...process.env };
      const ssl = raw.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false;
      sql = new Client({ connectionString: raw.DATABASE_URL, ssl, connectionTimeoutMillis: 10000 });
      await sql.connect();
      const vector = (
        await sql.query(
          "SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector'",
        )
      ).rows[0]?.nspname;
      if (!vector || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(vector))
        throw new Error('Existing vector extension required');
      await sql.query(`CREATE SCHEMA "${schema}"`);
      await sql.query(`SET search_path TO "${schema}","${vector}"`);
      for (const migration of readdirSync('prisma/migrations')
        .filter((n) => /^\d+_/.test(n))
        .sort())
        await sql.query(readFileSync(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
      db = new PrismaClient({
        adapter: new PrismaPg(
          {
            connectionString: raw.DATABASE_URL,
            ssl,
            options: `-c search_path=${schema},${vector}`,
          },
          { schema },
        ),
      });
      const user = (login: string, id: bigint) =>
        db.user.create({
          data: { login, githubId: id, avatarUrl: '', accessToken: 'fixture-only' },
        });
      owner = await user('owner', 11n);
      member = await user('member', 12n);
      outsider = await user('outsider', 13n);
      const repo = await db.repository.create({
        data: {
          githubId: 21n,
          name: 'repo',
          owner: 'owner',
          fullName: 'owner/repo',
          isPrivate: true,
          connectedById: owner.id,
        },
      });
      repoId = repo.id;
      for (const u of [owner, member])
        await db.repositoryMember.create({
          data: {
            repositoryId: repoId,
            githubUserId: u.githubId,
            userId: u.id,
            login: u.login,
            role: u.id === owner.id ? 'OWNER' : 'MEMBER',
          },
        });
      trackerId = (
        await db.tracker.create({
          data: { repositoryId: repoId, name: 'Task', prefix: 'TASK', color: '#123456' },
        })
      ).id;
      const access = new AccessService(
        github as unknown as GithubService,
        db as unknown as PrismaService,
      );
      issues = new IssuesService(
        db as unknown as PrismaService,
        github as unknown as GithubService,
        access,
        realtime as unknown as RealtimeGateway,
        { queueRepo: vi.fn() } as unknown as EmbeddingService,
      );
      sync = new SyncService(
        db as unknown as PrismaService,
        access,
        realtime as unknown as RealtimeGateway,
      );
      config = new ConfigService({
        DATABASE_URL: raw.DATABASE_URL,
        DATABASE_SSL: raw.DATABASE_SSL === 'true',
        SYNC_WORKER_ENABLED: false,
        GITHUB_WEBHOOK_SECRET: 'test-secret',
      }) as ConfigService<Env, true>;
      worker = new SyncWorker(
        db as unknown as PrismaService,
        github as unknown as GithubService,
        realtime as unknown as RealtimeGateway,
        config,
      );
      worker2 = new SyncWorker(
        db as unknown as PrismaService,
        github as unknown as GithubService,
        realtime as unknown as RealtimeGateway,
        config,
      );
      hooks = new WebhooksService(config, db as unknown as PrismaService, issues);
      Reflect.defineMetadata('design:paramtypes', [SyncService], SyncController);
      Reflect.defineMetadata('design:paramtypes', [WebhooksService], WebhooksController);
      const module = await Test.createTestingModule({
        controllers: [SyncController, WebhooksController],
        providers: [
          { provide: SyncService, useValue: sync },
          { provide: WebhooksService, useValue: hooks },
        ],
      })
        .overrideGuard(JwtAuthGuard)
        .useValue({
          canActivate(ctx: ExecutionContext) {
            const req = ctx.switchToHttp().getRequest();
            const u = [owner, member, outsider].find((u) => u.id === req.headers['x-test-user']);
            if (!u) return false;
            req.user = u;
            return true;
          },
        })
        .compile();
      app = module.createNestApplication({ rawBody: true });
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
      await app.init();
    });
    afterAll(async () => {
      await app?.close();
      await worker?.onModuleDestroy();
      await worker2?.onModuleDestroy();
      await db?.$disconnect();
      if (sql) {
        await sql.query('ROLLBACK');
        await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await sql.end();
      }
    });
    beforeEach(async () => {
      vi.resetAllMocks();
      await db.issue.deleteMany();
      await db.webhookEvent.deleteMany();
      await db.repositoryMember.updateMany({ data: { isActive: true } });
      github.requireWrite.mockResolvedValue(undefined);
      github.listIssues.mockResolvedValue([]);
      github.setParent.mockResolvedValue(undefined);
      github.createIssue.mockImplementation(async (_u, _o, _r, payload) =>
        gh({ ...payload, number: ++counter, id: 9000 + counter }),
      );
      github.updateIssue.mockImplementation(async (_u, _o, _r, number, payload) =>
        gh({ ...payload, number, id: 9000 + number }),
      );
    });
    it('commits local CRUD and one outbox before any GitHub call; coalesces latest edits', async () => {
      const issue = await create();
      await issues.update(member, repoId, issue.id, { title: 'Latest', body: 'Latest body' });
      expect(github.createIssue).not.toHaveBeenCalled();
      expect(await db.syncJob.count()).toBe(1);
      await worker.process((await jobFor(issue.id)).id);
      expect(github.createIssue.mock.calls[0]?.[3]).toMatchObject({ title: 'Latest' });
      expect(await sync.info(member, repoId, issue.id)).toMatchObject({
        syncStatus: 'SYNCED',
        retryCount: 0,
      });
      expect(await db.issue.findUniqueOrThrow({ where: { id: issue.id } })).toMatchObject({
        title: 'Latest',
        body: 'Latest body',
        issueCode: issue.issueCode,
      });
    });
    it('does not enqueue KanbanGit-only fields or transitions which remain GitHub open', async () => {
      const issue = await create();
      await worker.process((await jobFor(issue.id)).id);
      await issues.update(member, repoId, issue.id, {
        estimateMinutes: 60,
        status: 'verified',
        startDate: '2020-01-01',
      });
      expect(await db.syncJob.count()).toBe(1);
    });
    it('rolls back the issue when outbox insertion fails', async () => {
      await sql.query(
        `CREATE FUNCTION reject_sync() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$`,
      );
      await sql.query(
        `CREATE TRIGGER reject_sync BEFORE INSERT ON "SyncJob" FOR EACH ROW EXECUTE FUNCTION reject_sync()`,
      );
      try {
        await expect(create()).rejects.toThrow();
        expect(await db.issue.count()).toBe(0);
      } finally {
        await sql.query('DROP TRIGGER reject_sync ON "SyncJob"');
        await sql.query('DROP FUNCTION reject_sync()');
      }
    });
    it('sends a newer edit after an in-flight snapshot rather than marking it synced', async () => {
      const issue = await create();
      let edited = false;
      github.updateIssue.mockImplementation(async (_u, _o, _r, number, payload) => {
        if (!edited) {
          edited = true;
          await issues.update(member, repoId, issue.id, { title: 'Changed during request' });
        }
        return gh({ ...payload, number });
      });
      const job = await jobFor(issue.id);
      await worker.process(job.id);
      expect(await jobFor(issue.id)).toMatchObject({ status: 'PENDING' });
      expect((await sync.info(member, repoId, issue.id)).syncStatus).toBe('PENDING_SYNC');
      await worker.process(job.id);
      expect(github.createIssue).toHaveBeenCalledTimes(1);
      expect(github.updateIssue.mock.lastCall?.[4]).toMatchObject({
        title: 'Changed during request',
      });
      expect((await sync.info(member, repoId, issue.id)).syncStatus).toBe('SYNCED');
    });
    it('retains local changes on network failure and retries five times, five minutes apart', async () => {
      const issue = await create();
      const job = await jobFor(issue.id);
      github.requireWrite.mockRejectedValue(new Error('private access token'));
      await worker.process(job.id);
      let row = await jobFor(issue.id);
      expect(row).toMatchObject({ retryCount: 0, status: 'RETRY_WAIT' });
      expect(row.nextRetryAt!.getTime() - Date.now()).toBeGreaterThan(290000);
      await worker.process(job.id);
      expect(github.requireWrite).toHaveBeenCalledTimes(1);
      for (let i = 1; i <= 5; i++) {
        await db.syncJob.update({ where: { id: job.id }, data: { nextRetryAt: new Date(0) } });
        await worker.process(job.id);
        row = await jobFor(issue.id);
        expect(row.retryCount).toBe(i);
      }
      expect(row.status).toBe('FAILED');
      expect(github.requireWrite).toHaveBeenCalledTimes(6);
      expect(await sync.info(member, repoId, issue.id)).toMatchObject({
        syncStatus: 'NEEDS_ATTENTION',
        retryCount: 5,
      });
      expect(row.lastError).not.toContain('private');
      expect((await db.issue.findUniqueOrThrow({ where: { id: issue.id } })).title).toBe('Local');
    });
    it('a failure for an obsolete snapshot cannot park a corrected issue', async () => {
      const issue = await create();
      github.updateIssue.mockImplementationOnce(async () => {
        await issues.update(member, repoId, issue.id, { title: 'Corrected during request' });
        throw { status: 422 };
      });
      const job = await jobFor(issue.id);
      await worker.process(job.id);
      expect(await jobFor(issue.id)).toHaveProperty('status', 'PENDING');
      expect((await sync.info(member, repoId, issue.id)).syncStatus).toBe('PENDING_SYNC');
      await worker.process(job.id);
      expect((await sync.info(member, repoId, issue.id)).syncStatus).toBe('SYNCED');
    });
    it.each([401, 403, 404, 422])(
      'permanent HTTP %s fails immediately, Owner retry starts with zero',
      async (status) => {
        const issue = await create();
        github.requireWrite.mockRejectedValue({ status });
        await worker.process((await jobFor(issue.id)).id);
        expect((await sync.info(member, repoId, issue.id)).syncStatus).toBe('NEEDS_ATTENTION');
        await expect(sync.retry(member, repoId, issue.id)).rejects.toThrow();
        expect(await sync.retry(owner, repoId, issue.id)).toEqual({ queued: 1 });
        expect((await sync.info(owner, repoId, issue.id)).retryCount).toBe(0);
        expect(await sync.retry(owner, repoId, issue.id)).toEqual({ queued: 0 });
      },
    );
    it('reconciles timeout-after-create with marker and never sends another POST', async () => {
      const issue = await create();
      const job = await jobFor(issue.id);
      const accepted = gh({ body: syncBody(null, issue.id) });
      github.createIssue.mockImplementationOnce(async () => {
        github.listIssues.mockResolvedValue([accepted]);
        throw new Error('timeout after accepted');
      });
      await worker.process(job.id);
      await db.syncJob.update({ where: { id: job.id }, data: { nextRetryAt: new Date(0) } });
      await worker.process(job.id);
      expect(github.createIssue).toHaveBeenCalledTimes(1);
      expect((await sync.info(member, repoId, issue.id)).syncStatus).toBe('SYNCED');
    });
    it('does not claim SYNCED when GitHub silently ignores a requested assignee', async () => {
      const assignee = await db.repositoryMember.findFirstOrThrow({ where: { userId: member.id } });
      const issue = await create({ assigneeId: assignee.id });
      github.updateIssue.mockImplementationOnce(async (_u, _o, _r, number, payload) =>
        gh({ ...payload, number, assignees: [] }),
      );
      await worker.process((await jobFor(issue.id)).id);
      expect((await sync.info(member, repoId, issue.id)).syncStatus).toBe('NEEDS_ATTENTION');
      expect((await issues.get(member, repoId, issue.id)).assigneeId).toBe(assignee.id);
    });
    it('recovers PROCESSING after restart and resolves one CREATE webhook into the local row', async () => {
      const issue = await create();
      const job = await jobFor(issue.id);
      const accepted = gh({ body: syncBody('Local', issue.id) });
      await hooks.handle(
        'issues',
        { action: 'opened', issue: accepted, repository: { id: 21 } },
        randomUUID(),
      );
      expect(await db.issue.count()).toBe(1);
      await db.syncJob.update({ where: { id: job.id }, data: { status: 'PROCESSING' } });
      await worker.process(job.id);
      expect(github.createIssue).not.toHaveBeenCalled();
      expect((await sync.info(member, repoId, issue.id)).syncStatus).toBe('SYNCED');
    });
    it('two workers process each issue once and global concurrency does not exceed five', async () => {
      for (let i = 0; i < 8; i++) await create();
      let concurrent = 0,
        peak = 0;
      github.requireWrite.mockImplementation(async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await new Promise((r) => setTimeout(r, 20));
        concurrent--;
      });
      await Promise.all([worker.drain(), worker2.drain()]);
      await worker.drain();
      expect(peak).toBeLessThanOrEqual(5);
      expect(github.createIssue).toHaveBeenCalledTimes(8);
      expect(await db.issue.count({ where: { syncStatus: 'SYNCED' } })).toBe(8);
    });
    it('batch retry includes NEEDS_ATTENTION only and isolates failures', async () => {
      const a = await create(),
        b = await create(),
        pending = await create();
      github.requireWrite.mockRejectedValue({ status: 401 });
      await worker.process((await jobFor(a.id)).id);
      await worker.process((await jobFor(b.id)).id);
      expect(await sync.retry(owner, repoId)).toEqual({ queued: 2 });
      github.requireWrite.mockResolvedValue(undefined);
      github.createIssue.mockRejectedValueOnce({ status: 422 });
      await worker.drain();
      expect(await db.issue.count({ where: { syncStatus: 'SYNCED' } })).toBe(2);
      expect(await db.issue.count({ where: { syncStatus: 'NEEDS_ATTENTION' } })).toBe(1);
      expect(await jobFor(pending.id)).toHaveProperty('retryCount', 0);
    });
    it('preserves detailed status when GitHub echoes and maps external close/reopen', async () => {
      const issue = await create({ status: 'verified' });
      await worker.process((await jobFor(issue.id)).id);
      const local = await db.issue.findUniqueOrThrow({ where: { id: issue.id } });
      await issues.applyWebhook(
        repoId,
        'edited',
        gh({ number: local.number!, title: 'From GitHub', updated_at: '2020-01-03T00:00:00Z' }),
      );
      expect((await issues.get(member, repoId, issue.id)).status).toBe('verified');
      await issues.applyWebhook(
        repoId,
        'closed',
        gh({ number: local.number!, state: 'closed', updated_at: '2020-01-04T00:00:00Z' }),
      );
      expect((await issues.get(member, repoId, issue.id)).status).toBe('closed');
      await issues.applyWebhook(
        repoId,
        'reopened',
        gh({ number: local.number!, updated_at: '2020-01-05T00:00:00Z' }),
      );
      expect((await issues.get(member, repoId, issue.id)).status).toBe('reopen');
    });
    it('webhook delivery dedup is atomic under concurrency; old events cannot overwrite local pending data', async () => {
      const issue = await create();
      const payload = {
        action: 'opened',
        issue: gh({ body: syncBody('', issue.id) }),
        repository: { id: 21 },
      };
      const delivery = randomUUID();
      await Promise.all([
        hooks.handle('issues', payload, delivery),
        hooks.handle('issues', payload, delivery),
      ]);
      expect(await db.webhookEvent.count()).toBe(1);
      expect(await db.issue.count()).toBe(1);
      expect((await issues.get(member, repoId, issue.id)).title).toBe('Local');
    });
    it('signature, payload and delivery validation are enforced over HTTP', async () => {
      const payload = JSON.stringify({ action: 'opened', issue: gh(), repository: { id: 21 } });
      const post = (delivery?: string, signature?: string) => {
        let r = request(app.getHttpServer())
          .post('/webhooks/github')
          .set('content-type', 'application/json')
          .set('x-github-event', 'issues');
        if (delivery) r = r.set('x-github-delivery', delivery);
        if (signature) r = r.set('x-hub-signature-256', signature);
        return r.send(payload);
      };
      expect((await post(randomUUID())).status).toBe(401);
      const signature =
        'sha256=' + createHmac('sha256', 'test-secret').update(payload).digest('hex');
      expect((await post(undefined, signature)).status).toBe(400);
      expect((await post(randomUUID(), signature)).status).toBe(200);
      await expect(hooks.handle('issues', {}, randomUUID())).rejects.toThrow();
    });
    it('Member can view sync details; queue/retry are Owner-only and UUID/pagination validated', async () => {
      const issue = await create();
      const root = `/repositories/${repoId}`;
      expect(
        (
          await request(app.getHttpServer())
            .get(`${root}/issues/${issue.id}/sync`)
            .set('x-test-user', member.id)
        ).status,
      ).toBe(200);
      for (const user of [member, outsider]) {
        expect(
          (await request(app.getHttpServer()).get(`${root}/sync/queue`).set('x-test-user', user.id))
            .status,
        ).toBe(403);
        expect(
          (
            await request(app.getHttpServer())
              .post(`${root}/sync/retry`)
              .set('x-test-user', user.id)
          ).status,
        ).toBe(403);
      }
      expect(
        (
          await request(app.getHttpServer())
            .get(`${root}/sync/queue?limit=101`)
            .set('x-test-user', owner.id)
        ).status,
      ).toBe(400);
      expect(
        (
          await request(app.getHttpServer())
            .get(`${root}/issues/not-uuid/sync`)
            .set('x-test-user', owner.id)
        ).status,
      ).toBe(400);
      const response = await request(app.getHttpServer())
        .get(`${root}/sync/queue`)
        .set('x-test-user', owner.id);
      expect(response.body.data).toHaveLength(1);
      expect(JSON.stringify(response.body)).not.toContain('fixture-only');
    });
    it('a deletion webhook after the HTTP response cannot be overwritten by worker completion', async () => {
      const issue = await create();
      github.setParent.mockImplementationOnce(async (_user, _owner, _repo, remote) => {
        await issues.applyWebhook(repoId, 'deleted', {
          ...remote,
          updated_at: '2030-01-01T00:00:00Z',
        });
      });
      await worker.process((await jobFor(issue.id)).id);
      expect((await sync.info(member, repoId, issue.id)).syncStatus).toBe('NEEDS_ATTENTION');
      expect(await jobFor(issue.id)).toHaveProperty('status', 'FAILED');
      expect((await issues.get(member, repoId, issue.id)).title).toBe('Local');
    });
    it('inactive connector cannot write GitHub; inactive members cannot read sync info', async () => {
      const issue = await create();
      await db.repositoryMember.updateMany({
        where: { userId: owner.id },
        data: { isActive: false },
      });
      await worker.process((await jobFor(issue.id)).id);
      expect(github.createIssue).not.toHaveBeenCalled();
      expect((await sync.info(member, repoId, issue.id)).syncStatus).toBe('NEEDS_ATTENTION');
      await db.repositoryMember.updateMany({
        where: { userId: member.id },
        data: { isActive: false },
      });
      await expect(sync.info(member, repoId, issue.id)).rejects.toThrow();
    });
    it('closed/canceled CREATEs close remotely, parent dependency is retried without duplicate create', async () => {
      const parent = await create({ status: 'canceled' }),
        child = await create({ parentId: parent.id, status: 'closed' });
      const childJob = await jobFor(child.id);
      await worker.process(childJob.id);
      expect((await jobFor(child.id)).status).toBe('RETRY_WAIT');
      await worker.process((await jobFor(parent.id)).id);
      await db.syncJob.update({ where: { id: childJob.id }, data: { nextRetryAt: new Date(0) } });
      await worker.process(childJob.id);
      expect(github.createIssue).toHaveBeenCalledTimes(2);
      const localParent = await db.issue.findUniqueOrThrow({ where: { id: parent.id } });
      expect(github.setParent.mock.lastCall?.[4]).toBe(localParent.number);
      expect(github.updateIssue.mock.lastCall?.[4]).toMatchObject({ state: 'closed' });
      expect((await sync.info(member, repoId, child.id)).syncStatus).toBe('SYNCED');
    });
  },
);
