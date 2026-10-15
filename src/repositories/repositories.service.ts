import { Injectable } from '@nestjs/common';
import { AccessService } from '../access/access.service.js';
import type { User } from '../generated/prisma/client.js';
import { IssueState } from '../generated/prisma/client.js';
import { GithubService } from '../github/github.service.js';
import type { GithubRepo } from '../github/github.types.js';
import { IssuesService } from '../issues/issues.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Hình dạng repository trả cho frontend. `canManage` cho biết người dùng có phải owner không. */
export interface RepositoryDto {
  id: number;
  name: string;
  owner: string;
  fullName: string;
  description: string | null;
  isPrivate: boolean;
  isConnected: boolean;
  openIssuesCount: number;
  canManage: boolean;
}

@Injectable()
export class RepositoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubService,
    private readonly access: AccessService,
    private readonly issues: IssuesService,
  ) {}

  /** Repository của người dùng trên GitHub, kèm đã kết nối hay chưa và người dùng có phải owner không. */
  async list(user: User): Promise<RepositoryDto[]> {
    const repos = await this.github.listRepos(user);
    const openCounts = await this.countOpenIssues(repos.map((repo) => repo.id));
    return repos.map((repo) => this.toDto(repo, openCounts));
  }

  async get(user: User, repoId: number): Promise<RepositoryDto> {
    const { github } = await this.access.requireAccess(user, repoId);
    return this.toDto(github, await this.countOpenIssues([repoId]));
  }

  /**
   * Kết nối repository (chỉ owner): tạo nhãn chuẩn, đăng ký webhook, lấy toàn bộ issue hiện có.
   * Có thể bấm lại nhiều lần mà không bị trùng.
   */
  async connect(user: User, repoId: number): Promise<RepositoryDto> {
    const { github } = await this.access.requireOwner(user, repoId);

    const repository = await this.prisma.repository.upsert({
      where: { id: github.id },
      create: {
        id: github.id,
        name: github.name,
        owner: github.owner,
        fullName: github.fullName,
        description: github.description,
        isPrivate: github.isPrivate,
        connectedById: user.id,
      },
      update: {
        name: github.name,
        owner: github.owner,
        fullName: github.fullName,
        description: github.description,
        isPrivate: github.isPrivate,
      },
    });

    await this.github.ensureLabels(user, repository.owner, repository.name);
    const webhookId = await this.github.ensureWebhook(user, repository.owner, repository.name);
    await this.prisma.repository.update({
      where: { id: repository.id },
      data: { webhookId: BigInt(webhookId) },
    });
    await this.issues.backfill(user, repository);

    return this.toDto(github, await this.countOpenIssues([repoId]));
  }

  /** Số issue đang mở của các repository đã kết nối (đếm từ database). Repo chưa kết nối không có trong kết quả. */
  private async countOpenIssues(repoIds: number[]): Promise<Map<number, number>> {
    const connected = await this.prisma.repository.findMany({
      where: { id: { in: repoIds } },
      select: { id: true },
    });
    const connectedIds = connected.map((repo) => repo.id);
    const grouped = await this.prisma.issue.groupBy({
      by: ['repoId'],
      where: { repoId: { in: connectedIds }, state: IssueState.open },
      _count: { _all: true },
    });
    const counts = new Map<number, number>(connectedIds.map((id) => [id, 0]));
    for (const row of grouped) counts.set(row.repoId, row._count._all);
    return counts;
  }

  private toDto(repo: GithubRepo, openCounts: Map<number, number>): RepositoryDto {
    const connectedCount = openCounts.get(repo.id);
    return {
      id: repo.id,
      name: repo.name,
      owner: repo.owner,
      fullName: repo.fullName,
      description: repo.description,
      isPrivate: repo.isPrivate,
      isConnected: connectedCount !== undefined,
      openIssuesCount: connectedCount ?? repo.openIssuesCount,
      canManage: repo.canManage,
    };
  }
}
