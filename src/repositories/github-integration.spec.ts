import { describe, expect, it, vi } from 'vitest';
import { validate } from 'class-validator';
import { MembersService } from './members.service.js';
import { RepositoriesService } from './repositories.service.js';
import { AccessService } from '../access/access.service.js';
import { CreateRepositoryDto } from './dto/create-repository.dto.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { GithubService } from '../github/github.service.js';
import type { IssuesService } from '../issues/issues.service.js';
import type { RealtimeGateway } from '../realtime/realtime.gateway.js';
import type { Repository, User } from '../generated/prisma/client.js';

const user = { id: '10000000-0000-4000-8000-000000000001', githubId: 1n, login: 'owner' } as User;
const repo = {
  id: '10000000-0000-4000-8000-000000000100',
  githubId: 100n,
  owner: 'owner',
  name: 'app',
  connectedById: '10000000-0000-4000-8000-000000000001',
  importCompleted: true,
} as Repository;

function fixture() {
  const tx = {
    $queryRaw: vi.fn(async () => []),
    user: { findUnique: vi.fn(async (): Promise<{ id: string } | null> => null) },
    repositoryMember: {
      upsert: vi.fn(
        async (_args: { create: Record<string, unknown>; update: Record<string, unknown> }) => ({}),
      ),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findMany: vi.fn(async () => [
        { id: 'member-uuid', githubUserId: 2n, userId: null, role: 'MEMBER', isActive: true },
      ]),
      findUnique: vi.fn(async () => ({ role: 'MEMBER', isActive: true, userId: user.id })),
    },
    repository: {
      findUnique: vi.fn(async () => repo),
      upsert: vi.fn(async () => repo),
      update: vi.fn(async () => repo),
      findMany: vi.fn(async () => [{ id: '10000000-0000-4000-8000-000000000100' }]),
    },
    issue: { groupBy: vi.fn(async () => []), count: vi.fn(async () => 0) },
    tracker: { upsert: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    trackerPrefix: { upsert: vi.fn() },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (operation: unknown) =>
      typeof operation === 'function'
        ? operation(tx)
        : Promise.all(operation as Promise<unknown>[]),
    ),
  };
  const github = {
    listMembers: vi.fn(async () => [
      { githubUserId: 1n, login: 'owner', avatarUrl: 'a', githubPermission: 'ADMIN' },
      { githubUserId: 2n, login: 'guest', avatarUrl: 'b', githubPermission: 'WRITE' },
    ]),
    listRepos: vi.fn(async () => [{ ...repo, id: 100, canManage: true, ownerType: 'User' }]),
    createPersonalRepo: vi.fn(async () => ({ ...repo, id: 100, fullName: 'owner/app' })),
    ensureLabels: vi.fn(),
    ensureWebhook: vi.fn(async () => 99),
  };
  const realtime = { refreshRepoAccess: vi.fn() };
  const members = new MembersService(
    prisma as unknown as PrismaService,
    github as unknown as GithubService,
    realtime as unknown as RealtimeGateway,
  );
  const access = new AccessService(
    github as unknown as GithubService,
    prisma as unknown as PrismaService,
  );
  const issues = { backfill: vi.fn() };
  const repositories = new RepositoriesService(
    prisma as unknown as PrismaService,
    github as unknown as GithubService,
    access,
    issues as unknown as IssuesService,
    members,
  );
  return { tx, prisma, github, realtime, members, access, issues, repositories };
}

describe('M1 GitHub Integration', () => {
  it('validates repo name, visibility and description length', async () => {
    for (const body of [
      { name: '../bad', visibility: 'PUBLIC' },
      { name: 'ok', visibility: 'ORG' },
      { name: '', visibility: 'PRIVATE' },
      { name: 'ok', visibility: 'PUBLIC', description: 'x'.repeat(351) },
    ]) {
      expect(
        (await validate(Object.assign(new CreateRepositoryDto(), body))).length,
      ).toBeGreaterThan(0);
    }
    expect(
      await validate(
        Object.assign(new CreateRepositoryDto(), { name: 'my-repo', visibility: 'PRIVATE' }),
      ),
    ).toEqual([]);
  });

  it('imports members without creating fake Users and preserves role on resync', async () => {
    const f = fixture();
    const result = await f.members.sync(user, repo);
    expect(f.tx.repositoryMember.upsert.mock.calls[0]?.[0]).toMatchObject({
      create: { role: 'MEMBER', userId: null },
      update: { isActive: true },
    });
    expect(f.tx.repositoryMember.upsert.mock.calls[1]?.[0]).toMatchObject({
      create: { role: 'MEMBER', githubUserId: 2n },
    });
    for (const [args] of f.tx.repositoryMember.upsert.mock.calls)
      expect(args.update).not.toHaveProperty('role');
    expect(result[0]?.githubUserId).toBe('2');
    expect(f.realtime.refreshRepoAccess).toHaveBeenCalledWith(
      '10000000-0000-4000-8000-000000000100',
    );
  });

  it('deactivates missing members without deleting history', async () => {
    const f = fixture();
    await f.members.sync(user, repo);
    expect(f.tx.repositoryMember.updateMany).toHaveBeenCalledWith({
      where: {
        repositoryId: '10000000-0000-4000-8000-000000000100',
        githubUserId: { notIn: [1n, 2n] },
      },
      data: { isActive: false },
    });
  });

  it('links an existing User by GitHub identity rather than username', async () => {
    const f = fixture();
    f.tx.user.findUnique.mockResolvedValue({ id: '10000000-0000-4000-8000-000000000001' });
    await f.members.sync(user, repo);
    expect(f.tx.user.findUnique).toHaveBeenCalledWith({
      where: { githubId: 2n },
      select: { id: true },
    });
    expect(f.tx.repositoryMember.upsert.mock.calls[0]?.[0]).toMatchObject({
      update: { userId: '10000000-0000-4000-8000-000000000001' },
    });
  });

  it('does not deactivate members when GitHub fails before completing pagination', async () => {
    const f = fixture();
    f.github.listMembers.mockRejectedValueOnce(new Error('GitHub down'));
    await expect(f.members.sync(user, repo)).rejects.toThrow('GitHub down');
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('denies internal MEMBER even if GitHub admin; inactive membership cannot read', async () => {
    const f = fixture();
    await expect(
      f.access.requireConnectedOwner(user, '10000000-0000-4000-8000-000000000100'),
    ).rejects.toThrow();
    f.tx.repositoryMember.findUnique.mockResolvedValueOnce({
      role: 'OWNER',
      isActive: false,
      userId: user.id,
    });
    await expect(
      f.access.requireMember(user, '10000000-0000-4000-8000-000000000100'),
    ).rejects.toThrow();
  });

  it('permits internal Owner independently of GitHub admin for local role checks', async () => {
    const f = fixture();
    f.tx.repositoryMember.findUnique.mockResolvedValue({
      role: 'OWNER',
      isActive: true,
      userId: user.id,
    });
    f.github.listRepos.mockResolvedValue([
      { ...repo, id: 100, canManage: false, ownerType: 'User' },
    ]);
    await expect(
      f.access.requireConnectedOwner(user, '10000000-0000-4000-8000-000000000100'),
    ).resolves.toHaveProperty('connected.id', '10000000-0000-4000-8000-000000000100');
  });

  it('rejects organization import', async () => {
    const f = fixture();
    f.tx.repositoryMember.findUnique.mockResolvedValue({
      role: 'OWNER',
      isActive: true,
      userId: user.id,
    });
    f.github.listRepos.mockResolvedValue([
      { ...repo, id: 100, canManage: true, ownerType: 'Organization' },
    ]);
    await expect(f.repositories.import(user, '100')).rejects.toThrow('cá nhân');
    expect(f.tx.repository.upsert).not.toHaveBeenCalled();
  });

  it('connect seeds six trackers and only marks completed after backfill', async () => {
    const f = fixture();
    f.tx.repositoryMember.findUnique.mockResolvedValue({
      role: 'OWNER',
      isActive: true,
      userId: user.id,
    });
    await f.repositories.connect(user, '10000000-0000-4000-8000-000000000100');
    expect(f.tx.tracker.findMany).toHaveBeenCalled();
    expect(f.tx.repository.update).toHaveBeenLastCalledWith({
      where: { id: '10000000-0000-4000-8000-000000000100' },
      data: { importCompleted: true },
    });
    expect(f.issues.backfill).toHaveBeenCalled();
  });

  it('reports created GitHub repo after import failure so client can retry import, not create', async () => {
    const f = fixture();
    f.github.listRepos.mockRejectedValueOnce(new Error('offline'));
    await expect(
      f.repositories.create(user, { name: 'app', visibility: 'PRIVATE' }),
    ).rejects.toMatchObject({ response: { code: 'REPOSITORY_IMPORT_FAILED', githubId: '100' } });
    expect(f.github.createPersonalRepo).toHaveBeenCalledTimes(1);
  });
});
