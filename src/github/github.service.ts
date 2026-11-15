import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Octokit } from 'octokit';
import type { Env } from '../config/env.js';
import { IN_PROGRESS_LABEL_DEFINITION, STANDARD_LABELS } from '../common/constants/issues.js';
import { decrypt } from '../common/utils/crypto.js';
import type { User } from '../generated/prisma/client.js';
import type { GithubIssue, GithubRepo, GithubMember } from './github.types.js';

const REPO_CACHE_MS = 60_000;

/** Mọi lời gọi tới GitHub đều đi qua đây, dùng token của chính người dùng đang thao tác. */
@Injectable()
export class GithubService {
  private readonly logger = new Logger(GithubService.name);
  private readonly repoCache = new Map<string, { expiresAt: number; repos: GithubRepo[] }>();

  constructor(private readonly config: ConfigService<Env, true>) {}

  client(user: Pick<User, 'accessToken'>): Octokit {
    const key = this.config.get('TOKEN_ENCRYPTION_KEY', { infer: true });
    // The durable outbox owns retries, including ambiguous CREATE responses.
    return new Octokit({
      auth: decrypt(user.accessToken, key),
      request: { timeout: 30000 },
      retry: { enabled: false },
      throttle: { enabled: false },
    });
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
      ownerType: repo.owner.type,
    }));
    this.repoCache.set(user.id, { expiresAt: Date.now() + REPO_CACHE_MS, repos });
    return repos;
  }

  async createPersonalRepo(
    user: User,
    input: { name: string; description?: string; visibility: 'PUBLIC' | 'PRIVATE' },
  ): Promise<GithubRepo> {
    const { data } = await this.client(user).rest.repos.createForAuthenticatedUser({
      name: input.name,
      description: input.description,
      private: input.visibility === 'PRIVATE',
      has_issues: true,
    });
    this.repoCache.delete(user.id);
    return {
      id: data.id,
      name: data.name,
      owner: data.owner.login,
      fullName: data.full_name,
      description: data.description,
      isPrivate: data.private,
      openIssuesCount: data.open_issues_count,
      canManage: true,
      ownerType: data.owner.type,
    };
  }

  async listMembers(user: User, owner: string, repo: string): Promise<GithubMember[]> {
    const octokit = this.client(user);
    const [collaborators, ownerResponse] = await Promise.all([
      octokit.paginate(octokit.rest.repos.listCollaborators, {
        owner,
        repo,
        affiliation: 'all',
        per_page: 100,
      }),
      octokit.rest.users.getByUsername({ username: owner }),
    ]);
    const members: GithubMember[] = collaborators.map((member) => ({
      githubUserId: BigInt(member.id),
      login: member.login,
      avatarUrl: member.avatar_url,
      githubPermission: member.permissions?.admin
        ? 'ADMIN'
        : member.permissions?.maintain
          ? 'MAINTAIN'
          : member.permissions?.push
            ? 'WRITE'
            : member.permissions?.triage
              ? 'TRIAGE'
              : member.permissions?.pull
                ? 'READ'
                : 'UNKNOWN',
    }));
    const account = ownerResponse.data;
    const ownerMember: GithubMember = {
      githubUserId: BigInt(account.id),
      login: account.login,
      avatarUrl: account.avatar_url,
      githubPermission: 'ADMIN',
    };
    return [
      ...members.filter((member) => member.githubUserId !== ownerMember.githubUserId),
      ownerMember,
    ];
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

  async getIssue(user: User, owner: string, repo: string, number: number): Promise<GithubIssue> {
    return (await this.client(user).rest.issues.get({ owner, repo, issue_number: number })).data;
  }

  async requireWrite(user: User, owner: string, repo: string) {
    const { data } = await this.client(user).rest.repos.get({ owner, repo });
    if (!data.permissions?.push && !data.permissions?.admin && !data.permissions?.maintain)
      throw Object.assign(new Error('GitHub write permission required'), { status: 403 });
  }

  async getParent(
    user: User,
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<GithubIssue | null> {
    try {
      return (
        await this.client(user).request('GET /repos/{owner}/{repo}/issues/{issue_number}/parent', {
          owner,
          repo,
          issue_number: issueNumber,
        })
      ).data as GithubIssue;
    } catch (error) {
      if ((error as { status?: number }).status === 404) return null;
      throw error;
    }
  }

  async setParent(
    user: User,
    owner: string,
    repo: string,
    child: GithubIssue,
    parentNumber: number | null,
  ) {
    const previous = await this.getParent(user, owner, repo, child.number);
    if ((previous?.number ?? null) === parentNumber) return;
    if (previous)
      await this.client(user).request(
        'DELETE /repos/{owner}/{repo}/issues/{issue_number}/sub_issue',
        { owner, repo, issue_number: previous.number, sub_issue_id: child.id },
      );
    if (parentNumber !== null)
      await this.client(user).request(
        'POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues',
        { owner, repo, issue_number: parentNumber, sub_issue_id: child.id },
      );
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

  /** Những người có thể được giao issue trong repository (chủ repo và các collaborator). */
  async listAssignees(
    user: User,
    owner: string,
    repo: string,
  ): Promise<Array<{ login: string; avatarUrl: string }>> {
    const octokit = this.client(user);
    const users = await octokit.paginate(octokit.rest.issues.listAssignees, {
      owner,
      repo,
      per_page: 100,
    });
    return users.map((u) => ({ login: u.login, avatarUrl: u.avatar_url }));
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
