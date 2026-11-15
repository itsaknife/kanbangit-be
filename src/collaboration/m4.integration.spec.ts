import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { parse } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication, type ExecutionContext } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient, type User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CollaborationAccess } from './collaboration-access.service.js';
import { CollaborationChangeInterceptor } from './collaboration-change.interceptor.js';
import { WorklogsService } from '../worklogs/worklogs.service.js';
import { WorklogsController } from '../worklogs/worklogs.controller.js';
import { CommentsService } from '../comments/comments.service.js';
import { CommentsController } from '../comments/comments.controller.js';
import { NotificationsController } from '../notifications/notifications.controller.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import { AccessService } from '../access/access.service.js';
import { IssuesService } from '../issues/issues.service.js';
import type { GithubService } from '../github/github.service.js';
import type { EmbeddingService } from '../ai/embedding.service.js';

describe.skipIf(process.env.RUN_M4_DB_TESTS !== '1')(
  'M4 isolated PostgreSQL + HTTP workflows',
  { timeout: 30000 },
  () => {
    const schema = 'm4_test_' + randomUUID().replaceAll('-', '');
    let sql: Client,
      db: PrismaClient,
      access: CollaborationAccess,
      worklogs: WorklogsService,
      comments: CommentsService,
      notifications: NotificationsController,
      app: INestApplication;
    let owner: User,
      member: User,
      other: User,
      repoId: string,
      foreignRepoId: string,
      issueId: string,
      childId: string,
      foreignIssueId: string;
    let memberId: string, otherId: string, foreignMemberId: string, unlinkedId: string;
    const realtime = { emitCollaborationChanged: vi.fn(), emitIssueUpdated: vi.fn() };
    const body = {
      startAt: '2020-01-01T08:00:00+07:00',
      endAt: '2020-01-01T09:00:00+07:00',
      description: 'Implementation',
    };
    let connected = false;
    const trackedComments = new Set<string>();
    beforeAll(async () => {
      const config = { ...(existsSync('.env') ? parse(readFileSync('.env')) : {}), ...process.env };
      if (!config.DATABASE_URL) throw new Error('DATABASE_URL required');
      const ssl = config.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false;
      sql = new Client({
        connectionString: config.DATABASE_URL,
        ssl,
        connectionTimeoutMillis: 10000,
        statement_timeout: 20000,
      });
      await sql.connect();
      connected = true;
      const extension = await sql.query<{ nspname: string }>(
        "SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector'",
      );
      const vectorSchema = extension.rows[0]?.nspname;
      if (!vectorSchema || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(vectorSchema))
        throw new Error('Existing vector extension required');
      await sql.query(`CREATE SCHEMA "${schema}"`);
      await sql.query(`SET search_path TO "${schema}","${vectorSchema}"`);
      for (const migration of readdirSync(resolve('prisma/migrations'))
        .filter((n) => /^\d+_/.test(n))
        .sort())
        await sql.query(
          readFileSync(resolve('prisma/migrations', migration, 'migration.sql'), 'utf8'),
        );
      const tables = await sql.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name IN ('Worklog','Comment','Attachment','CommentMention','Notification')",
        [schema],
      );
      expect(tables.rows).toHaveLength(5);
      db = new PrismaClient({
        adapter: new PrismaPg(
          {
            connectionString: config.DATABASE_URL,
            ssl,
            options: `-c search_path=${schema},${vectorSchema}`,
          },
          { schema },
        ),
      });
      await db.$connect();
      access = new CollaborationAccess(db as unknown as PrismaService);
      worklogs = new WorklogsService(access);
      comments = new CommentsService(access);
      notifications = new NotificationsController(db as unknown as PrismaService);
      const user = async (login: string, id: bigint) =>
        db.user.create({
          data: { githubId: id, login, avatarUrl: 'avatar', accessToken: 'not-a-real-token' },
        });
      owner = await user('owner', 1001n);
      member = await user('member', 1002n);
      other = await user('other', 1003n);
      const repo = async (name: string, id: bigint) => {
        const r = await db.repository.create({
          data: {
            githubId: id,
            name,
            owner: owner.login,
            fullName: owner.login + '/' + name,
            isPrivate: true,
            connectedById: owner.id,
          },
        });
        const memberships = await Promise.all(
          [owner, member, other].map((u) =>
            db.repositoryMember.create({
              data: {
                repositoryId: r.id,
                githubUserId: u.githubId,
                login: u.login,
                userId: u.id,
                role: u.id === owner.id ? 'OWNER' : 'MEMBER',
              },
            }),
          ),
        );
        const tracker = await db.tracker.create({
          data: { repositoryId: r.id, name: 'Task', prefix: 'TASK', color: '#123456' },
        });
        const issue = await db.issue.create({
          data: {
            repoId: r.id,
            trackerId: tracker.id,
            title: name,
            issueCode: 'TASK-001',
            state: 'open',
            status: 'todo',
            estimateMinutes: 30,
          },
        });
        return { r, memberships, tracker, issue };
      };
      const first = await repo('first', 2001n),
        second = await repo('second', 2002n);
      repoId = first.r.id;
      foreignRepoId = second.r.id;
      issueId = first.issue.id;
      foreignIssueId = second.issue.id;
      [, memberId, otherId] = first.memberships.map((m) => m.id);
      foreignMemberId = second.memberships[1].id;
      childId = (
        await db.issue.create({
          data: {
            repoId,
            trackerId: first.tracker.id,
            title: 'child',
            issueCode: 'TASK-002',
            parentId: issueId,
            estimateMinutes: 30,
            state: 'open',
            status: 'todo',
          },
        })
      ).id;
      unlinkedId = (
        await db.repositoryMember.create({
          data: { repositoryId: repoId, githubUserId: 1004n, login: 'not-logged-in' },
        })
      ).id;
      // Vitest/esbuild does not emit TypeScript decorator metadata.
      Reflect.defineMetadata('design:paramtypes', [WorklogsService], WorklogsController);
      Reflect.defineMetadata('design:paramtypes', [CommentsService], CommentsController);
      Reflect.defineMetadata('design:paramtypes', [PrismaService], NotificationsController);
      Reflect.defineMetadata(
        'design:paramtypes',
        [RealtimeGateway],
        CollaborationChangeInterceptor,
      );
      const testing = await Test.createTestingModule({
        controllers: [WorklogsController, CommentsController, NotificationsController],
        providers: [
          { provide: PrismaService, useValue: db },
          { provide: CollaborationAccess, useValue: access },
          { provide: WorklogsService, useValue: worklogs },
          { provide: CommentsService, useValue: comments },
          { provide: RealtimeGateway, useValue: realtime },
          CollaborationChangeInterceptor,
        ],
      })
        .overrideGuard(JwtAuthGuard)
        .useValue({
          canActivate: (context: ExecutionContext) => {
            const req = context
              .switchToHttp()
              .getRequest<{ headers: Record<string, string>; user?: User }>();
            req.user =
              req.headers['x-test-user'] === 'owner'
                ? owner
                : req.headers['x-test-user'] === 'member'
                  ? member
                  : undefined;
            return !!req.user;
          },
        })
        .compile();
      app = testing.createNestApplication();
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
      await app.init();
    }, 60000);
    beforeEach(async () => {
      for (const id of trackedComments) await comments.remove(owner, repoId, id).catch(() => {});
      trackedComments.clear();
      await db.comment.deleteMany();
      await db.worklog.deleteMany();
      await db.repositoryMember.updateMany({ data: { isActive: true } });
      await db.issue.updateMany({ data: { state: 'open', status: 'todo', estimateMinutes: 30 } });
    }, 30000);
    afterAll(async () => {
      for (const id of trackedComments) await comments?.remove(owner, repoId, id).catch(() => {});
      if (app) await app.close();
      if (db) await db.$disconnect();
      if (connected) {
        try {
          if (!/^m4_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe schema cleanup');
          await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        } finally {
          await sql.end();
        }
      }
    }, 30000);
    it('persists local worklogs and calculated duration', async () => {
      await worklogs.create(member, repoId, issueId, body);
      const result = await worklogs.list(member, repoId, {});
      expect(result.data).toHaveLength(1);
      expect(result.totalMinutes).toBe(60);
      expect(JSON.stringify(result)).not.toContain('accessToken');
    });
    it('accepts adjacent worklogs', async () => {
      await worklogs.create(member, repoId, issueId, body);
      await expect(
        worklogs.create(member, repoId, childId, {
          ...body,
          startAt: body.endAt,
          endAt: '2020-01-01T10:00:00+07:00',
        }),
      ).resolves.toBeDefined();
    });
    it('rejects overlap across repositories for the same GitHub identity', async () => {
      await worklogs.create(member, repoId, issueId, body);
      await expect(
        worklogs.create(member, foreignRepoId, foreignIssueId, body),
      ).rejects.toMatchObject({ status: 409 });
    });
    it('serializes concurrent writes from different repository memberships', async () => {
      const result = await Promise.allSettled([
        worklogs.create(member, repoId, issueId, body),
        worklogs.create(member, foreignRepoId, foreignIssueId, body),
      ]);
      expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await db.worklog.count()).toBe(1);
    });
    it('allows another person at the same time', async () => {
      await worklogs.create(member, repoId, issueId, body);
      await expect(worklogs.create(other, repoId, issueId, body)).resolves.toBeDefined();
    });
    it('database trigger blocks bypassed overlap and computes duration', async () => {
      const row = await db.worklog.create({
        data: {
          issueId,
          memberId,
          githubUserId: 0n,
          startAt: new Date(body.startAt),
          endAt: new Date(body.endAt),
          durationMinutes: 999,
        },
      });
      expect(row.githubUserId).toBe(member.githubId);
      expect(row.durationMinutes).toBe(60);
      await expect(
        db.worklog.create({
          data: {
            issueId: foreignIssueId,
            memberId: foreignMemberId,
            githubUserId: 0n,
            startAt: new Date(body.startAt),
            endAt: new Date(body.endAt),
            durationMinutes: 999,
          },
        }),
      ).rejects.toThrow();
    });
    it('database trigger blocks cross-repository author assignment', async () => {
      await expect(
        db.worklog.create({
          data: {
            issueId,
            memberId: foreignMemberId,
            githubUserId: member.githubId,
            startAt: new Date(body.startAt),
            endAt: new Date(body.endAt),
            durationMinutes: 60,
          },
        }),
      ).rejects.toThrow();
    });
    it('records on Closed without reopening or queueing sync', async () => {
      await db.issue.update({
        where: { id: issueId },
        data: { status: 'closed', state: 'closed' },
      });
      await worklogs.create(member, repoId, issueId, body);
      expect((await db.issue.findUniqueOrThrow({ where: { id: issueId } })).status).toBe('closed');
      expect(await db.syncJob.count()).toBe(0);
    });
    it('member cannot log for another member or foreign repository member', async () => {
      await expect(
        worklogs.create(member, repoId, issueId, { ...body, memberId: otherId }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        worklogs.create(owner, repoId, issueId, { ...body, memberId: foreignMemberId }),
      ).rejects.toMatchObject({ status: 400 });
    });
    it('owner can create and edit for another member; author remains unchanged', async () => {
      const row = await worklogs.create(owner, repoId, issueId, { ...body, memberId: otherId });
      await worklogs.update(owner, repoId, row.id, { ...body, endAt: '2020-01-01T10:00:00+07:00' });
      expect((await db.worklog.findUniqueOrThrow({ where: { id: row.id } })).memberId).toBe(
        otherId,
      );
    });
    it('member can edit own, cannot edit others or delete any', async () => {
      const a = await worklogs.create(member, repoId, issueId, body);
      const b = await worklogs.create(other, repoId, issueId, body);
      await expect(worklogs.update(member, repoId, a.id, body)).resolves.toBeDefined();
      await expect(worklogs.update(member, repoId, b.id, body)).rejects.toMatchObject({
        status: 403,
      });
      await expect(worklogs.remove(member, repoId, a.id)).rejects.toMatchObject({ status: 403 });
      await worklogs.remove(owner, repoId, a.id);
    });
    it('editing rechecks overlap', async () => {
      await worklogs.create(member, repoId, issueId, body);
      const row = await worklogs.create(member, repoId, childId, {
        ...body,
        startAt: body.endAt,
        endAt: '2020-01-01T10:00:00+07:00',
      });
      await expect(worklogs.update(member, repoId, row.id, body)).rejects.toMatchObject({
        status: 409,
      });
    });
    it('Time module is personal for Member and repository-wide for Owner', async () => {
      await worklogs.create(member, repoId, issueId, body);
      await worklogs.create(other, repoId, issueId, body);
      expect((await worklogs.list(member, repoId, {})).totalMinutes).toBe(60);
      expect((await worklogs.list(owner, repoId, {})).totalMinutes).toBe(120);
      await expect(worklogs.list(member, repoId, { memberId: otherId })).rejects.toMatchObject({
        status: 403,
      });
    });
    it('issue worklogs become visible only after participation; no descendant rows mixed in', async () => {
      await worklogs.create(other, repoId, issueId, body);
      expect((await worklogs.list(member, repoId, { issueId })).canView).toBe(false);
      await worklogs.create(member, repoId, issueId, body);
      await worklogs.create(owner, repoId, childId, body);
      expect((await worklogs.list(member, repoId, { issueId })).data).toHaveLength(2);
    });
    it('clips and allocates only selected Vietnam days', async () => {
      await worklogs.create(member, repoId, issueId, {
        startAt: '2020-01-01T23:00:00+07:00',
        endAt: '2020-01-03T01:00:00+07:00',
      });
      const result = await worklogs.list(member, repoId, {
        period: 'custom',
        from: '2020-01-02',
        to: '2020-01-02',
      });
      expect(result.totalMinutes).toBe(1440);
      expect(result.data[0].durationMinutes).toBe(1560);
      expect(result.daily).toEqual([{ date: '2020-01-02', durationMinutes: 1440 }]);
    });
    it('direct/tree warnings recompute after estimate increase and worklog deletion', async () => {
      const row = await worklogs.create(member, repoId, issueId, body);
      await worklogs.create(other, repoId, childId, body);
      const result = await worklogs.summary(owner, repoId, issueId);
      expect(result.directOverEstimate).toBe(true);
      expect(result.combinedOverEstimate).toBe(true);
      expect(result.combinedMinutes).toBe(120);
      await db.issue.update({ where: { id: issueId }, data: { estimateMinutes: 180 } });
      expect((await worklogs.summary(owner, repoId, issueId)).combinedOverEstimate).toBe(false);
      await worklogs.remove(owner, repoId, row.id);
      expect((await worklogs.summary(owner, repoId, issueId)).directMinutes).toBe(0);
    });
    it('never leaks tree aggregate through an issue where descendants are private', async () => {
      await worklogs.create(member, repoId, issueId, body);
      await worklogs.create(other, repoId, childId, body);
      const result = await worklogs.summary(member, repoId, issueId);
      expect(result.directMinutes).toBe(60);
      expect(result.combinedMinutes).toBeNull();
      expect(result.combinedOverEstimate).toBe(false);
    });
    it('retains historical worklogs after member removal', async () => {
      await worklogs.create(member, repoId, issueId, body);
      await db.repositoryMember.update({ where: { id: memberId }, data: { isActive: false } });
      await expect(worklogs.list(member, repoId, {})).rejects.toMatchObject({ status: 403 });
      expect((await worklogs.list(owner, repoId, {})).data).toHaveLength(1);
    });
    it('comment author and Owner have edit/delete permission', async () => {
      const row = await comments.create(member, repoId, issueId, '**Markdown**');
      await expect(comments.update(other, repoId, row.id, 'bad')).rejects.toMatchObject({
        status: 403,
      });
      await comments.update(owner, repoId, row.id, 'Owner edit');
      expect((await comments.list(member, repoId, issueId)).data[0].authorId).toBe(memberId);
      await expect(comments.remove(other, repoId, row.id)).rejects.toMatchObject({ status: 403 });
      await comments.remove(member, repoId, row.id);
    });
    it('deduplicates mentions, ignores self, and only notifies newly added people', async () => {
      const token = (u: User) => `[@${u.login}](mention:${u.id})`;
      const row = await comments.create(
        member,
        repoId,
        issueId,
        token(other) + ' ' + token(other) + ' ' + token(member),
      );
      expect((await notifications.list(other)).unreadCount).toBe(1);
      expect((await notifications.list(member)).unreadCount).toBe(0);
      await comments.update(member, repoId, row.id, 'Removed mention');
      await comments.update(member, repoId, row.id, token(other) + ' ' + token(owner));
      expect(await db.notification.count({ where: { userId: other.id } })).toBe(1);
      expect(await db.notification.count({ where: { userId: owner.id } })).toBe(1);
    });
    it('rejects mention IDs outside active repository membership', async () => {
      await db.repositoryMember.update({ where: { id: otherId }, data: { isActive: false } });
      await expect(
        comments.create(member, repoId, issueId, `[@other](mention:${other.id})`),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        comments.create(member, repoId, issueId, `[@missing](mention:${randomUUID()})`),
      ).rejects.toMatchObject({ status: 400 });
      expect(await db.comment.count()).toBe(0);
      await expect(
        comments.create(member, repoId, issueId, `[@not-logged-in](mention:${unlinkedId})`),
      ).rejects.toMatchObject({ status: 400 });
    });
    it('Owner edit sends no self-notification to Owner', async () => {
      const row = await comments.create(member, repoId, issueId, 'Initial');
      await comments.update(owner, repoId, row.id, `[@owner](mention:${owner.id})`);
      expect(await db.notification.count()).toBe(0);
    });
    it('notification read is private and revoked membership hides issue titles', async () => {
      const row = await comments.create(member, repoId, issueId, `[@other](mention:${other.id})`);
      const notification = (await notifications.list(other)).data[0];
      await expect(notifications.read(member, notification.id)).rejects.toMatchObject({
        status: 404,
      });
      await notifications.read(other, notification.id);
      expect((await notifications.list(other)).unreadCount).toBe(0);
      await db.repositoryMember.update({ where: { id: otherId }, data: { isActive: false } });
      expect((await notifications.list(other)).data).toEqual([]);
      await comments.remove(owner, repoId, row.id);
      expect(await db.notification.count()).toBe(0);
    });
    it('attachment upload, authorized download, deletion and private DTO', async () => {
      const row = await comments.create(member, repoId, issueId, 'Attached file');
      trackedComments.add(row.id);
      const buffer = Buffer.from('const answer = 42;');
      const file = await comments.upload(member, repoId, row.id, {
        originalname: 'answer.ts',
        mimetype: 'text/plain',
        buffer,
        size: buffer.length,
      });
      expect(file).not.toHaveProperty('storageKey');
      expect((await comments.download(other, repoId, file.id)).buffer.equals(buffer)).toBe(true);
      await expect(comments.removeAttachment(other, repoId, file.id)).rejects.toMatchObject({
        status: 403,
      });
      await expect(comments.download(owner, foreignRepoId, file.id)).rejects.toMatchObject({
        status: 404,
      });
      await db.repositoryMember.update({ where: { id: otherId }, data: { isActive: false } });
      await expect(comments.download(other, repoId, file.id)).rejects.toMatchObject({
        status: 403,
      });
      await comments.removeAttachment(owner, repoId, file.id);
      await expect(comments.download(member, repoId, file.id)).rejects.toMatchObject({
        status: 404,
      });
    });
    it('HTTP validates DTOs, permissions and upload limits', async () => {
      const server = app.getHttpServer();
      await request(server).get(`/repositories/${repoId}/worklogs`).expect(403);
      await request(server)
        .post(`/repositories/${repoId}/issues/${issueId}/worklogs`)
        .set('x-test-user', 'member')
        .send({ ...body, startAt: 'invalid' })
        .expect(400);
      const row = await comments.create(member, repoId, issueId, 'files');
      trackedComments.add(row.id);
      await request(server)
        .post(`/repositories/${repoId}/comments/${row.id}/attachments`)
        .set('x-test-user', 'member')
        .attach('file', Buffer.alloc(2097153, 65), 'big.txt')
        .expect(413);
      const response = await request(server)
        .post(`/repositories/${repoId}/comments/${row.id}/attachments`)
        .set('x-test-user', 'member')
        .attach('file', Buffer.from('hello'), 'note.txt')
        .expect(201);
      const download = await request(server)
        .get(`/repositories/${repoId}/attachments/${response.body.id}`)
        .set('x-test-user', 'owner')
        .expect(200);
      expect(download.headers['cache-control']).toBe('private, no-store');
      expect(download.headers['x-content-type-options']).toBe('nosniff');
      expect(download.headers['content-disposition']).toContain('attachment');
      await request(server)
        .patch(`/repositories/${repoId}/comments/${row.id}`)
        .set('x-test-user', 'owner')
        .send({ content: 'Updated' })
        .expect(200);
      expect(realtime.emitCollaborationChanged).toHaveBeenCalledWith(repoId);
    });
    it('database serializes direct concurrent overlapping inserts across repos', async () => {
      const create = (targetIssue: string, targetMember: string) =>
        db.worklog.create({
          data: {
            issueId: targetIssue,
            memberId: targetMember,
            githubUserId: member.githubId,
            startAt: new Date(body.startAt),
            endAt: new Date(body.endAt),
            durationMinutes: 60,
          },
        });
      const results = await Promise.allSettled([
        create(issueId, memberId),
        create(foreignIssueId, foreignMemberId),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await db.worklog.count()).toBe(1);
    });
    it('CASCADE CLOSE deletes only subtree worklogs transactionally', async () => {
      const github = {} as GithubService;
      const issues = new IssuesService(
        db as unknown as PrismaService,
        github,
        new AccessService(github, db as unknown as PrismaService),
        realtime as unknown as RealtimeGateway,
        { queueRepo: vi.fn() } as unknown as EmbeddingService,
      );
      await worklogs.create(member, repoId, issueId, body);
      await worklogs.create(other, repoId, childId, body);
      await worklogs.create(owner, foreignRepoId, foreignIssueId, body);
      await issues.cascadeClose(owner, repoId, issueId);
      expect(await db.worklog.count({ where: { issue: { repoId } } })).toBe(0);
      expect(await db.worklog.count()).toBe(1);
      expect(await db.issue.count({ where: { repoId } })).toBe(2);
      await db.syncJob.deleteMany();
    });
    it('CASCADE CLOSE rolls back worklog deletion if history write fails', async () => {
      const github = {} as GithubService;
      const issues = new IssuesService(
        db as unknown as PrismaService,
        github,
        new AccessService(github, db as unknown as PrismaService),
        realtime as unknown as RealtimeGateway,
        { queueRepo: vi.fn() } as unknown as EmbeddingService,
      );
      await worklogs.create(member, repoId, issueId, body);
      await worklogs.create(other, repoId, childId, body);
      await sql.query(
        `CREATE FUNCTION m4_fail_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'M4_TEST_ROLLBACK'; END $$`,
      );
      await sql.query(
        'CREATE TRIGGER m4_test_history_failure BEFORE INSERT ON "IssueStatusHistory" FOR EACH ROW EXECUTE FUNCTION m4_fail_history()',
      );
      try {
        await expect(issues.cascadeClose(owner, repoId, issueId)).rejects.toThrow();
        expect(await db.worklog.count({ where: { issue: { repoId } } })).toBe(2);
        expect((await db.issue.findUniqueOrThrow({ where: { id: issueId } })).status).toBe('todo');
      } finally {
        await sql.query('DROP TRIGGER m4_test_history_failure ON "IssueStatusHistory"');
        await sql.query('DROP FUNCTION m4_fail_history()');
      }
    });
  },
);
