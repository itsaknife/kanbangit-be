import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Octokit } from 'octokit';
import type { Env } from '../config/env.js';
import { IN_PROGRESS_LABEL_DEFINITION, STANDARD_LABELS } from '../common/constants/issues.js';
import { decrypt } from '../common/utils/crypto.js';
import type { User } from '../generated/prisma/client.js';
import type { GithubIssue, GithubRepo } from './github.types.js';

const REPO_CACHE_MS = 60_000;

/** Mọi lời gọi tới GitHub đều đi qua đây, dùng token của chính người dùng đang thao tác. */
@Injectable()
export class GithubService {
  private readonly logger = new Logger(GithubService.name);
  private readonly repoCache = new Map<number, { expiresAt: number; repos: GithubRepo[] }>();

  constructor(private readonly config: ConfigService<Env, true>) {}

  client(user: Pick<User, 'accessToken'>): Octokit {
    const key = this.config.get('TOKEN_ENCRYPTION_KEY', { infer: true });
    return new Octokit({ auth: decrypt(user.accessToken, key) });
  }

  /** Repository mà người dùng có quyền truy cập (lưu tạm 1 phút để đỡ gọi GitHub liên tục). */
  async listRepos(user: User, forceRefresh = false): Promise<GithubRepo[]> {
    const cached = this.repoCache.get(user.id);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.repos;

    const octokit = this.client(user);
    const data = await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
      per_page: 100,
      sort: 'updated',
      affiliation: 'owner,collaborator,organization_member',
    });

    const repos: GithubRepo[] = data.map((repo) => ({
      id: repo.id,
      name: repo.name,
      owner: repo.owner.login,
      fullName: repo.full_name,
      description: repo.description ?? null,
      isPrivate: repo.private,
      openIssuesCount: repo.open_issues_count ?? 0,
      canManage: repo.permissions?.admin ?? false,
    }));
    this.repoCache.set(user.id, { expiresAt: Date.now() + REPO_CACHE_MS, repos });
    return repos;
  }

  /** Toàn bộ issue (đang mở và đã đóng) của repository, không gồm Pull Request. */
  async listIssues(user: User, owner: string, repo: string): Promise<GithubIssue[]> {
    const octokit = this.client(user);
    const data = await octokit.paginate(octokit.rest.issues.listForRepo, {
      owner,
      repo,
      state: 'all',
      per_page: 100,
    });
    return data.filter((issue) => !issue.pull_request);
  }

  async createIssue(
    user: User,
    owner: string,
    repo: string,
    payload: { title: string; body?: string; labels?: string[]; assignees?: string[] },
  ): Promise<GithubIssue> {
    const { data } = await this.client(user).rest.issues.create({ owner, repo, ...payload });
    return data;
  }

  async updateIssue(
    user: User,
    owner: string,
    repo: string,
    issueNumber: number,
    payload: {
      title?: string;
      body?: string;
      labels?: string[];
      assignees?: string[];
      state?: 'open' | 'closed';
      state_reason?: 'completed' | 'reopened';
    },
  ): Promise<GithubIssue> {
    const { data } = await this.client(user).rest.issues.update({
      owner,
      repo,
      issue_number: issueNumber,
      ...payload,
    });
    return data;
  }

  /** Tạo các nhãn chuẩn (bug, enhancement, task) và nhãn "in progress" nếu repository chưa có. */
  async ensureLabels(user: User, owner: string, repo: string): Promise<void> {
    const octokit = this.client(user);
    const existing = await octokit.paginate(octokit.rest.issues.listLabelsForRepo, {
      owner,
      repo,
      per_page: 100,
    });
    const existingNames = new Set(existing.map((label) => label.name.toLowerCase()));

    for (const label of [...STANDARD_LABELS, IN_PROGRESS_LABEL_DEFINITION]) {
      if (existingNames.has(label.name)) continue;
      await octokit.rest.issues.createLabel({ owner, repo, ...label });
      this.logger.log(`Đã tạo nhãn "${label.name}" cho ${owner}/${repo}`);
    }
  }

  /** Đăng ký webhook nhận sự kiện issue. Nếu đã có webhook cùng địa chỉ thì dùng lại. */
  async ensureWebhook(user: User, owner: string, repo: string): Promise<number> {
    const octokit = this.client(user);
    const url = this.config.get('WEBHOOK_URL', { infer: true });
    const hooks = await octokit.paginate(octokit.rest.repos.listWebhooks, {
      owner,
      repo,
      per_page: 100,
    });
    const existing = hooks.find((hook) => hook.config.url === url);
    if (existing) return existing.id;

    const { data } = await octokit.rest.repos.createWebhook({
      owner,
      repo,
      events: ['issues'],
      active: true,
      config: {
        url,
        content_type: 'json',
        secret: this.config.get('GITHUB_WEBHOOK_SECRET', { infer: true }),
      },
    });
    return data.id;
  }
}
