import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AccessService } from '../access/access.service.js';
import type { Repository, User } from '../generated/prisma/client.js';
import { GithubService } from '../github/github.service.js';
import { IssuesService } from '../issues/issues.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DEFAULT_TRACKERS } from './default-trackers.js';
import type { CreateRepositoryDto } from './dto/create-repository.dto.js';
import { MembersService } from './members.service.js';
@Injectable()
export class RepositoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubService,
    private readonly access: AccessService,
    private readonly issues: IssuesService,
    private readonly members: MembersService,
  ) {}
  async list(user: User) {
    const repos = await this.prisma.repository.findMany({
      where: { members: { some: { userId: user.id, isActive: true } } },
      orderBy: { connectedAt: 'desc' },
    });
    return Promise.all(repos.map((repo) => this.get(user, repo.id)));
  }
  async available(user: User) {
    const repos = (await this.github.listRepos(user, true)).filter(
      (repo) => repo.ownerType === 'User' && repo.canManage,
    );
    const existing = await this.prisma.repository.findMany({
      where: { githubId: { in: repos.map((repo) => BigInt(repo.id)) } },
      select: { githubId: true },
    });
    const ids = new Set(existing.map((repo) => repo.githubId.toString()));
    return repos
      .filter((repo) => !ids.has(String(repo.id)))
      .map(({ id, ...repo }) => ({ ...repo, githubId: String(id) }));
  }
  async get(user: User, repoId: string) {
    const { connected, member } = await this.access.requireMember(user, repoId);
    const openIssuesCount = await this.prisma.issue.count({ where: { repoId, state: 'open' } });
    return {
      id: connected.id,
      githubId: connected.githubId.toString(),
      name: connected.name,
      owner: connected.owner,
      fullName: connected.fullName,
      description: connected.description,
      isPrivate: connected.isPrivate,
      isConnected: connected.importCompleted,
      openIssuesCount,
      canManage: member.role === 'OWNER',
    };
  }
  async listAssignees(user: User, repoId: string) {
    await this.access.requireMember(user, repoId);
    return this.prisma.repositoryMember.findMany({
      where: { repositoryId: repoId, isActive: true },
      select: { id: true, login: true, avatarUrl: true },
    });
  }
  async import(user: User, githubId: string) {
    const github = (await this.github.listRepos(user, true)).find(
      (repo) => String(repo.id) === githubId,
    );
    if (!github)
      throw new BadRequestException('Repository GitHub không tồn tại hoặc không có quyền truy cập');
    if (!github.canManage)
      throw new ForbiddenException('Cần quyền quản trị GitHub để đăng ký webhook và import');
    if (github.ownerType === 'Organization')
      throw new BadRequestException('Chỉ hỗ trợ repository cá nhân');
    const existing = await this.prisma.repository.findUnique({
      where: { githubId: BigInt(githubId) },
    });
    if (existing) {
      await this.access.requireConnectedOwner(user, existing.id);
      return this.connect(user, existing.id);
    }
    const repository = await this.prisma.repository.create({
      data: {
        githubId: BigInt(githubId),
        name: github.name,
        owner: github.owner,
        fullName: github.fullName,
        description: github.description,
        isPrivate: github.isPrivate,
        connectedById: user.id,
        members: {
          create: {
            githubUserId: user.githubId,
            login: user.login,
            avatarUrl: user.avatarUrl,
            userId: user.id,
            role: 'OWNER',
            githubPermission: 'ADMIN',
          },
        },
        trackers: {
          create: DEFAULT_TRACKERS.map((tracker, displayOrder) => ({ ...tracker, displayOrder })),
        },
      },
    });
    return this.finishImport(user, repository);
  }
  async connect(user: User, repoId: string) {
    const { connected } = await this.access.requireConnectedOwner(user, repoId);
    const github = (await this.github.listRepos(user, true)).find(
      (repo) => BigInt(repo.id) === connected.githubId,
    );
    if (!github?.canManage)
      throw new ForbiddenException('GitHub không cho phép quản lý webhook repository');
    return this.finishImport(user, connected);
  }
  private async finishImport(user: User, repository: Repository) {
    await this.members.sync(user, repository);
    await this.prisma.$transaction(async (tx) => {
      const trackers = await tx.tracker.findMany({ where: { repositoryId: repository.id } });
      for (const tracker of trackers)
        await tx.trackerPrefix.upsert({
          where: { repositoryId_prefix: { repositoryId: repository.id, prefix: tracker.prefix } },
          create: { repositoryId: repository.id, trackerId: tracker.id, prefix: tracker.prefix },
          update: {},
        });
    });
    await this.github.ensureLabels(user, repository.owner, repository.name);
    const webhookId = await this.github.ensureWebhook(user, repository.owner, repository.name);
    await this.prisma.repository.update({
      where: { id: repository.id },
      data: { webhookId: BigInt(webhookId) },
    });
    await this.issues.backfill(user, repository);
    await this.prisma.repository.update({
      where: { id: repository.id },
      data: { importCompleted: true },
    });
    return this.get(user, repository.id);
  }
  async create(user: User, dto: CreateRepositoryDto) {
    const repo = await this.github.createPersonalRepo(user, dto);
    try {
      return await this.import(user, String(repo.id));
    } catch {
      throw new BadGatewayException({
        statusCode: 502,
        code: 'REPOSITORY_IMPORT_FAILED',
        message: `GitHub đã tạo ${repo.fullName}. Hãy tải lại danh sách và import lại, không tạo repository lần nữa.`,
        githubId: String(repo.id),
      });
    }
  }
  async listMembers(user: User, repoId: string) {
    await this.access.requireMember(user, repoId);
    return this.members.list(repoId);
  }
  async syncMembers(user: User, repoId: string) {
    const { connected } = await this.access.requireConnectedOwner(user, repoId);
    return this.members.sync(user, connected);
  }
  async transferOwner(user: User, repoId: string, memberId: string) {
    await this.access.ownerTransaction(user, repoId, async (tx) => {
      const target = await tx.repositoryMember.findFirst({
        where: { id: memberId, repositoryId: repoId, isActive: true, userId: { not: null } },
      });
      if (!target)
        throw new BadRequestException(
          'Owner mới phải là thành viên đang hoạt động và đã đăng nhập KanbanGit',
        );
      await tx.repositoryMember.updateMany({
        where: { repositoryId: repoId, role: 'OWNER' },
        data: { role: 'MEMBER' },
      });
      await tx.repositoryMember.update({ where: { id: target.id }, data: { role: 'OWNER' } });
    });
    return { message: 'Đã chuyển quyền Owner' };
  }
}
