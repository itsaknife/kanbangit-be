import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { parse } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient, type User } from '../generated/prisma/client.js';
import { AccessService } from '../access/access.service.js';
import { GithubService } from '../github/github.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RepositoriesService } from '../repositories/repositories.service.js';
import { IssuesService } from '../issues/issues.service.js';
import { TrackersService, allocateIssueCode } from './trackers.service.js';
import type { MembersService } from '../repositories/members.service.js';
import type { RealtimeGateway } from '../realtime/realtime.gateway.js';
import type { EmbeddingService } from '../ai/embedding.service.js';

// Opt in explicitly. Every DDL/DML operation targets a random private test schema;
// application public tables are never queried or modified.
describe.skipIf(process.env.RUN_M2_DB_TESTS !== '1')(
  'M2 PostgreSQL migration and domain invariants',
  () => {
    const schema = `m2_test_${randomUUID().replaceAll('-', '')}`;
    let client: Client;
    let prisma: PrismaClient;
    let access: AccessService;
    let trackers: TrackersService;
    let repositories: RepositoriesService;
    let owner: User;
    let member: User;
    let repoId: string;
    let otherRepoId: string;
    let taskId: string;
    let secondTrackerId: string;
    const github = {
      listRepos: vi.fn(async () => {
        throw new Error('GitHub offline');
      }),
      createIssue: vi.fn(),
      updateIssue: vi.fn(),
    };
    const realtime = {
      emitIssueUpdated: vi.fn(),
      emitIssueCreated: vi.fn(),
      emitIssueDeleted: vi.fn(),
    };
    let issues: IssuesService;
    beforeAll(async () => {
      const config = { ...parse(readFileSync(resolve('.env'))), ...process.env };
      const connectionString = config.DATABASE_URL;
      if (!connectionString) throw new Error('DATABASE_URL required for isolated schema test');
      const ssl = config.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false;
      client = new Client({
        connectionString,
        ssl,
        connectionTimeoutMillis: 10000,
        statement_timeout: 20000,
      });
      await client.connect();
      const extension = await client.query(
        `SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector'`,
      );
      if (!extension.rows[0]) throw new Error('vector extension required');
      const vectorSchema = String(extension.rows[0].nspname);
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(vectorSchema))
        throw new Error('Unexpected extension namespace');
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}",public,"${vectorSchema}"`);
      await client.query(
        readFileSync(
          resolve('prisma/migrations/202611110001_legacy_baseline/migration.sql'),
          'utf8',
        ),
      );
      await client.query(`INSERT INTO "User"(id,login,"avatarUrl","accessToken","updatedAt") VALUES(1,'owner','avatar','ciphertext',CURRENT_TIMESTAMP);
      INSERT INTO "Repository"(id,name,owner,"fullName","isPrivate","connectedById","webhookId") VALUES(100,'app','owner','owner/app',true,1,77);`);
      await client.query(
        `INSERT INTO "Issue"("githubId","repoId",number,title,state,status,"htmlUrl","githubCreatedAt","githubUpdatedAt","updatedAt","dueDate",embedding)
      VALUES(1001,100,1,'Legacy issue','closed','done','url','2026-11-01','2026-11-01',CURRENT_TIMESTAMP,'2026-11-14T20:00:00Z',$1::vector)`,
        [`[1,${Array(767).fill(0).join(',')}]`],
      );
      await client.query(
        readFileSync(
          resolve('prisma/migrations/202611110002_github_integration/migration.sql'),
          'utf8',
        ),
      );
      await client.query(
        readFileSync(
          resolve('prisma/migrations/202611110003_core_data_permission/migration.sql'),
          'utf8',
        ),
      );
      for (const migration of [
        '202611120004_display_profile',
        '202611130005_core_lookup_indexes',
        '202611130006_issue_management',
      ]) {
        await client.query(
          readFileSync(resolve(`prisma/migrations/${migration}/migration.sql`), 'utf8'),
        );
      }
      prisma = new PrismaClient({
        adapter: new PrismaPg(
          { connectionString, ssl, options: `-c search_path=${schema},public,${vectorSchema}` },
          { schema },
        ),
      });
      await prisma.$connect();
      const found = await prisma.user.findUniqueOrThrow({ where: { githubId: 1n } });
      owner = found;
      repoId = (await prisma.repository.findUniqueOrThrow({ where: { githubId: 100n } })).id;
      taskId = (
        await prisma.tracker.findFirstOrThrow({ where: { repositoryId: repoId, prefix: 'TASK' } })
      ).id;
      access = new AccessService(
        github as unknown as GithubService,
        prisma as unknown as PrismaService,
      );
      trackers = new TrackersService(prisma as unknown as PrismaService, access);
      repositories = new RepositoriesService(
        prisma as unknown as PrismaService,
        github as unknown as GithubService,
        access,
        {} as IssuesService,
        {} as MembersService,
      );
      issues = new IssuesService(
        prisma as unknown as PrismaService,
        github as unknown as GithubService,
        access,
        realtime as unknown as RealtimeGateway,
        { queueRepo: vi.fn() } as unknown as EmbeddingService,
      );
      member = await prisma.user.create({
        data: { githubId: 2n, login: 'member', avatarUrl: 'avatar', accessToken: 'ciphertext' },
      });
      await prisma.repositoryMember.create({
        data: {
          repositoryId: repoId,
          githubUserId: 2n,
          login: member.login,
          userId: member.id,
          role: 'MEMBER',
        },
      });
      otherRepoId = (
        await prisma.repository.create({
          data: {
            githubId: 200n,
            name: 'other',
            owner: 'owner',
            fullName: 'owner/other',
            isPrivate: true,
            connectedById: owner.id,
          },
        })
      ).id;
    }, 60000);
    afterAll(async () => {
      if (prisma) await prisma.$disconnect();
      if (client) {
        await client.query('ROLLBACK').catch(() => {});
        if (/^m2_test_[a-f0-9]{32}$/.test(schema))
          await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await client.end();
      }
    }, 30000);

    it('preserves legacy data, external IDs, vector and all UUID relationships', async () => {
      expect(owner.id).toMatch(/^[\da-f-]{36}$/);
      expect(owner.legacyId).toBe(1);
      const repo = await prisma.repository.findUniqueOrThrow({ where: { id: repoId } });
      expect(repo.connectedById).toBe(owner.id);
      expect(repo.githubId).toBe(100n);
      const issue = await prisma.issue.findUniqueOrThrow({ where: { githubId: 1001n } });
      expect(issue.issueCode).toBe('TASK-001');
      expect(issue.trackerId).toBe(taskId);
      expect(issue.legacyId).toBe(1);
      expect(issue.status).toBe('closed');
      expect(issue.dueDate?.toISOString()).toBe('2026-11-14T20:00:00.000Z');
      expect(issue.endDate?.toISOString().slice(0, 10)).toBe('2026-11-15');
      expect(await prisma.issueStatusHistory.findMany({ where: { issueId: issue.id } })).toEqual([
        expect.objectContaining({ toStatus: 'closed', source: 'SYSTEM' }),
      ]);
      const vector = await prisma.$queryRaw<
        Array<{ dims: number; value: string }>
      >`SELECT vector_dims(embedding) AS dims, embedding::text AS value FROM "Issue" WHERE id=${issue.id}`;
      expect(vector[0]?.dims).toBe(768);
      expect(vector[0]?.value).toBe(`[1,${Array(767).fill(0).join(',')}]`);
    });
    it('uses local membership while GitHub is offline and enforces Owner only', async () => {
      await expect(access.requireMember(member, repoId)).resolves.toHaveProperty(
        'member.role',
        'MEMBER',
      );
      await expect(
        trackers.create(member, repoId, { name: 'Forbidden', prefix: 'NO', color: '#123456' }),
      ).rejects.toThrow();
      expect(github.listRepos).not.toHaveBeenCalled();
    });
    it('creates and changes Tracker, preserves historical prefix reservations', async () => {
      const tracker = await trackers.create(owner, repoId, {
        name: 'Quality',
        prefix: 'QA',
        color: '#123456',
        displayOrder: 8,
      });
      secondTrackerId = tracker.id;
      await trackers.update(owner, repoId, tracker.id, { prefix: 'QC' });
      await expect(
        trackers.create(owner, repoId, { name: 'Other quality', prefix: 'QA', color: '#654321' }),
      ).rejects.toThrow('Prefix');
      await expect(
        trackers.update(owner, otherRepoId, tracker.id, { name: 'Wrong repo' }),
      ).rejects.toThrow();
    });
    async function createIssue(
      tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0],
      title: string,
      trackerId: string,
    ) {
      const code = await allocateIssueCode(tx, repoId, trackerId);
      const n = Number(code.issueCode.split('-').at(-1));
      return tx.issue.create({
        data: {
          ...code,
          repoId,
          number: 100 + n,
          githubId: BigInt(10000 + n),
          title,
          state: 'open',
          status: 'todo',
          htmlUrl: 'url',
          githubCreatedAt: new Date(),
          githubUpdatedAt: new Date(),
        },
      });
    }
    it('allocates codes atomically across concurrent real database transactions', async () => {
      const created = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          prisma.$transaction((tx) => createIssue(tx, `Concurrent ${i}`, taskId), {
            timeout: 30000,
          }),
        ),
      );
      expect(new Set(created.map((i) => i.issueCode)).size).toBe(8);
      expect(created.map((i) => i.issueCode).sort()).toEqual(
        Array.from({ length: 8 }, (_, i) => `TASK-${String(i + 2).padStart(3, '0')}`),
      );
    }, 60000);
    it('keeps Issue Code immutable when changing Tracker and rejects cross-repository relations', async () => {
      const issue = await prisma.issue.findUniqueOrThrow({ where: { githubId: 1001n } });
      const updated = await issues.update(member, repoId, 1, { trackerId: secondTrackerId });
      expect(updated.issueCode).toBe(issue.issueCode);
      expect(updated.trackerId).toBe(secondTrackerId);
      expect(github.updateIssue).not.toHaveBeenCalled();
      await expect(
        prisma.issue.update({ where: { id: issue.id }, data: { issueCode: 'FORGED-001' } }),
      ).rejects.toThrow();
      const foreign = await prisma.tracker.create({
        data: { repositoryId: otherRepoId, name: 'Foreign', prefix: 'FOREIGN', color: '#123456' },
      });
      await expect(
        prisma.issue.update({ where: { id: issue.id }, data: { trackerId: foreign.id } }),
      ).rejects.toThrow();
    });
    it('rejects inactive and foreign Trackers before GitHub creation', async () => {
      await trackers.setActive(owner, repoId, secondTrackerId, false);
      await expect(
        issues.create(member, repoId, { title: 'Should fail', trackerId: secondTrackerId }),
      ).rejects.toThrow();
      expect(github.createIssue).not.toHaveBeenCalled();
      await expect(
        prisma.$transaction((tx) => allocateIssueCode(tx, otherRepoId, taskId)),
      ).rejects.toThrow();
    });
    it('supports Issue Code search and rejects issue creation when every Tracker is inactive', async () => {
      const result = await issues.list(member, repoId, 'task-001');
      const list = Array.isArray(result) ? result : result.data;
      expect(list.some((issue) => issue.issueCode === 'TASK-001')).toBe(true);
      expect(list).toHaveLength(1);
      await prisma.tracker.updateMany({
        where: { repositoryId: repoId },
        data: { isActive: false },
      });
      await expect(prisma.$transaction((tx) => allocateIssueCode(tx, repoId))).rejects.toThrow();
    });
    it('transfers ownership atomically and removes former Owner privileges', async () => {
      await expect(repositories.transferOwner(owner, repoId, randomUUID())).rejects.toThrow();
      await expect(access.requireConnectedOwner(owner, repoId)).resolves.toHaveProperty(
        'member.role',
        'OWNER',
      );
      const target = await prisma.repositoryMember.findUniqueOrThrow({
        where: {
          repositoryId_githubUserId: { repositoryId: repoId, githubUserId: member.githubId },
        },
      });
      await repositories.transferOwner(owner, repoId, target.id);
      await expect(access.requireConnectedOwner(owner, repoId)).rejects.toThrow();
      await expect(access.requireConnectedOwner(member, repoId)).resolves.toHaveProperty(
        'member.role',
        'OWNER',
      );
    });
    it('preserves membership history while inactive members lose access', async () => {
      await prisma.repositoryMember.updateMany({
        where: { repositoryId: repoId, userId: owner.id },
        data: { isActive: false },
      });
      await expect(access.requireMember(owner, repoId)).rejects.toThrow();
      expect(
        await prisma.repositoryMember.count({ where: { repositoryId: repoId, userId: owner.id } }),
      ).toBe(1);
    });
    it('cascades repository-owned foundation rows without deleting Users', async () => {
      await prisma.repository.delete({ where: { id: repoId } });
      expect(await prisma.issue.count({ where: { repoId } })).toBe(0);
      expect(await prisma.tracker.count({ where: { repositoryId: repoId } })).toBe(0);
      expect(await prisma.trackerPrefix.count({ where: { repositoryId: repoId } })).toBe(0);
      expect(await prisma.repositoryMember.count({ where: { repositoryId: repoId } })).toBe(0);
      expect(await prisma.user.findUnique({ where: { id: owner.id } })).not.toBeNull();
    });
  },
);
