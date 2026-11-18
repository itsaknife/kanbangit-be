import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { Client } from 'pg';
import { parse } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { ConfigService } from '@nestjs/config';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { PrismaClient, type User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { IdentityService, type ProviderAccount } from './identity.service.js';
import { ProjectsController } from '../repositories/projects.controller.js';
import { RepositoriesService } from '../repositories/repositories.service.js';
import { MembersService } from '../repositories/members.service.js';
import { AccessService } from '../access/access.service.js';
import { IssuesService } from '../issues/issues.service.js';
import { CollaborationAccess } from '../collaboration/collaboration-access.service.js';
import { WorklogsService } from '../worklogs/worklogs.service.js';
import { CommentsService } from '../comments/comments.service.js';
import type { GithubService } from '../github/github.service.js';
import type { RealtimeGateway } from '../realtime/realtime.gateway.js';
import type { EmbeddingService } from '../ai/embedding.service.js';
import type { Env } from '../config/env.js';
describe.skipIf(process.env.RUN_M6_DB_TESTS !== '1')(
  'M6 migration and provider-independent projects',
  { timeout: 60000 },
  () => {
    const schema = 'm6_test_' + randomUUID().replaceAll('-', '');
    let sql: Client,
      db: PrismaClient,
      identity: IdentityService,
      projects: ProjectsController,
      issues: IssuesService,
      worklogs: WorklogsService,
      comments: CommentsService,
      owner: User;
    let projectId: string, issueId: string;
    const github = new Proxy(
      {},
      {
        get: () =>
          vi.fn(() => {
            throw Error('Unexpected GitHub call for local Project');
          }),
      },
    ) as GithubService;
    const realtime = {
      emitIssueCreated: vi.fn(),
      emitIssueUpdated: vi.fn(),
      refreshRepoAccess: vi.fn(),
    } as unknown as RealtimeGateway;
    const account = (
      id: string,
      email: string,
      provider: 'GOOGLE' | 'GITHUB' = 'GOOGLE',
    ): ProviderAccount => ({
      provider,
      providerUserId: id,
      email,
      emailVerified: true,
      login: 'external',
      name: 'Person',
      avatarUrl: '',
      accessToken: null,
    });
    beforeAll(async () => {
      const env = { ...parse(readFileSync('.env')), ...process.env };
      const ssl = env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false;
      sql = new Client({ connectionString: env.DATABASE_URL, ssl, connectionTimeoutMillis: 10000 });
      await sql.connect();
      const vector = (
        await sql.query(
          "SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector'",
        )
      ).rows[0].nspname;
      if (!/^[a-z_]+$/.test(vector)) throw Error('Invalid extension schema');
      await sql.query(`CREATE SCHEMA "${schema}"`);
      await sql.query(`SET search_path TO "${schema}","${vector}"`);
      for (const migration of readdirSync('prisma/migrations')
        .filter((n) => /^\d+_/.test(n))
        .sort()) {
        if (migration.startsWith('202611170009'))
          await sql.query(
            `INSERT INTO "User"(id,"githubId",login,"avatarUrl","accessToken","updatedAt") VALUES ('legacy-user',77,'legacy','','encrypted-legacy',now())`,
          );
        await sql.query(readFileSync(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
      }
      db = new PrismaClient({
        adapter: new PrismaPg(
          {
            connectionString: env.DATABASE_URL,
            ssl,
            options: `-c search_path=${schema},${vector}`,
          },
          { schema },
        ),
      });
      const prisma = db as PrismaService;
      const config = new ConfigService({ TOKEN_ENCRYPTION_KEY: 'a'.repeat(64) }) as ConfigService<
        Env,
        true
      >;
      identity = new IdentityService(prisma, config);
      // This migration fixture has no live provider token. Model reauthentication
      // of the legacy account; unverified legacy metadata is tested separately.
      await db.authIdentity.updateMany({
        where: { providerUserId: '77' },
        data: { email: 'legacy@example.test', emailVerified: true },
      });
      const access = new AccessService(github, prisma);
      issues = new IssuesService(prisma, github, access, realtime, {
        queueRepo: vi.fn(),
      } as unknown as EmbeddingService);
      const repos = new RepositoriesService(
        prisma,
        github,
        access,
        issues,
        new MembersService(prisma, github, realtime),
      );
      projects = new ProjectsController(prisma, repos);
      const collaboration = new CollaborationAccess(prisma);
      worklogs = new WorklogsService(collaboration);
      comments = new CommentsService(collaboration);
      owner = await identity.resolve(account('google-owner', 'owner@example.test'));
    }, 60000);
    afterAll(async () => {
      await db?.$disconnect();
      if (sql) {
        if (/^m6_test_[0-9a-f]+$/.test(schema))
          await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await sql.end();
      }
    }, 60000);
    it('backfills encrypted GitHub identity without changing the legacy User UUID', async () => {
      expect(
        await db.authIdentity.findUnique({
          where: { provider_providerUserId: { provider: 'GITHUB', providerUserId: '77' } },
        }),
      ).toMatchObject({ userId: 'legacy-user', accessToken: 'encrypted-legacy' });
    });
    it('resolves the same identity and blocks verified-email collisions without linking', async () => {
      expect((await identity.resolve(account('google-owner', 'owner@example.test'))).id).toBe(
        owner.id,
      );
      await expect(
        identity.resolve(account('different', 'owner@example.test', 'GITHUB')),
      ).rejects.toThrow('ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER');
    });
    it('links explicitly, prevents takeover and prevents unlinking the last provider', async () => {
      await identity.resolve(account('88', 'owner@example.test', 'GITHUB'), owner.id);
      expect((await identity.resolve(account('88', 'owner@example.test', 'GITHUB'))).id).toBe(
        owner.id,
      );
      await expect(
        identity.resolve(account('77', 'other@example.test', 'GITHUB'), owner.id),
      ).rejects.toThrow('IDENTITY_OWNED_BY_ANOTHER_USER');
      await identity.unlink(owner, 'GITHUB');
      await expect(identity.unlink(owner, 'GOOGLE')).rejects.toThrow();
    });
    it('creates a local project with six trackers and Owner, without a GitHub request', async () => {
      const p = await projects.create(owner, { name: 'Local', description: 'Local project' });
      projectId = p.id;
      expect(p.providerType).toBe('KANBANGIT');
      expect(p.githubId).toBeNull();
      expect(await db.tracker.count({ where: { repositoryId: projectId } })).toBe(6);
      expect(
        await db.repositoryMember.findFirst({
          where: { repositoryId: projectId, userId: owner.id },
        }),
      ).toMatchObject({ role: 'OWNER', githubUserId: null });
    });
    it('supports local issue CRUD/hierarchy/status with no outbox and enforces permissions', async () => {
      const tracker = await db.tracker.findFirstOrThrow({ where: { repositoryId: projectId } });
      const row = await issues.create(owner, projectId, {
        title: 'Local issue',
        trackerId: tracker.id,
      });
      issueId = row.id;
      expect((await issues.update(owner, projectId, issueId, { title: 'Updated' })).title).toBe(
        'Updated',
      );
      expect(await db.syncJob.count()).toBe(0);
      expect((await issues.get(owner, projectId, issueId)).syncStatus).toBe('SYNCED');
      const outsider = await identity.resolve(account('outsider', 'outsider@example.test'));
      await expect(issues.get(outsider, projectId, issueId)).rejects.toThrow();
    });
    it('supports local worklogs and comments, and rejects overlapping time', async () => {
      const timing = {
        startAt: '2026-01-01T01:00:00Z',
        endAt: '2026-01-01T02:00:00Z',
        description: 'Work',
      };
      await worklogs.create(owner, projectId, issueId, timing);
      await expect(worklogs.create(owner, projectId, issueId, timing)).rejects.toThrow();
      expect(await comments.create(owner, projectId, issueId, 'Local comment')).toBeTruthy();
    });
    it('reconciles pre-login GitHub worklogs with the linked User across projects', async () => {
      const manager = await identity.resolve(account('manager', 'manager@example.test'));
      const p = await db.repository.create({
        data: {
          name: 'External',
          fullName: 'manager/external',
          owner: 'manager',
          githubId: 1234n,
          isPrivate: false,
          connectedById: manager.id,
          members: {
            create: { userId: manager.id, githubUserId: 100n, login: 'manager', role: 'OWNER' },
          },
        },
      });
      const ghost = await db.repositoryMember.create({
        data: { repositoryId: p.id, githubUserId: 99n, login: 'ghost' },
      });
      const t = await db.tracker.create({
        data: { repositoryId: p.id, name: 'Task', prefix: 'TASK', color: '#123456' },
      });
      const row = await issues.create(manager, p.id, { title: 'Historical', trackerId: t.id });
      const timing = { startAt: '2026-03-01T01:00:00Z', endAt: '2026-03-01T02:00:00Z' };
      await worklogs.create(manager, p.id, row.id, { ...timing, memberId: ghost.id });
      await identity.resolve(account('99', 'owner@example.test', 'GITHUB'), owner.id);
      expect(await db.worklog.findFirst({ where: { memberId: ghost.id } })).toMatchObject({
        personKey: owner.id,
      });
      await expect(worklogs.create(owner, projectId, issueId, timing)).rejects.toThrow();
    });
    it('enforces provider boundaries for direct database writes', async () => {
      await expect(
        db.webhookEvent.create({
          data: { repositoryId: projectId, githubDeliveryId: randomUUID(), eventType: 'issues' },
        }),
      ).rejects.toThrow();
      await expect(
        db.issue.update({ where: { id: issueId }, data: { number: 1 } }),
      ).rejects.toThrow();
    });
    it('permits only one of two Users to link the same identity concurrently', async () => {
      const a = await identity.resolve(account('801', 'a-link@example.test', 'GITHUB'));
      const b = await identity.resolve(account('802', 'b-link@example.test', 'GITHUB'));
      const shared = account('shared-google', 'shared@example.test');
      const results = await Promise.allSettled([
        identity.resolve(shared, a.id),
        identity.resolve(shared, b.id),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(
        await db.authIdentity.count({
          where: { provider: 'GOOGLE', providerUserId: 'shared-google' },
        }),
      ).toBe(1);
    });
    it('serializes concurrent first logins to one internal account', async () => {
      const result = await Promise.all([
        identity.resolve(account('same', 'same@example.test')),
        identity.resolve(account('same', 'same@example.test')),
      ]);
      expect(result[0].id).toBe(result[1].id);
    });
    it('uses the same Member permissions for local projects and preserves inactive history', async () => {
      const member = await identity.resolve(account('local-member', 'member@example.test'));
      const membership = await db.repositoryMember.create({
        data: { repositoryId: projectId, userId: member.id, login: member.login, role: 'MEMBER' },
      });
      expect(
        (await issues.update(member, projectId, issueId, { title: 'Member updated' })).title,
      ).toBe('Member updated');
      await expect(
        projects.owner(member, projectId, { memberId: membership.id }),
      ).rejects.toThrow();
      await db.repositoryMember.update({ where: { id: membership.id }, data: { isActive: false } });
      await expect(issues.get(member, projectId, issueId)).rejects.toThrow();
      expect(await db.issue.count({ where: { id: issueId } })).toBe(1);
    });
  },
);
