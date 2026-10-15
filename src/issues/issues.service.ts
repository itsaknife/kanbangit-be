import { Injectable, NotFoundException } from '@nestjs/common';
import { AccessService } from '../access/access.service.js';
import { EmbeddingService } from '../ai/embedding.service.js';
import { IN_PROGRESS_LABEL } from '../common/constants/issues.js';
import type { IssueDto } from '../common/types/issue.dto.js';
import { type Issue, IssueStatus, type Repository, type User } from '../generated/prisma/client.js';
import { GithubService } from '../github/github.service.js';
import type { GithubIssue } from '../github/github.types.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import type { CreateIssueDto } from './dto/create-issue.dto.js';
import type { UpdateIssueDto } from './dto/update-issue.dto.js';
import { assigneesOf, labelsOf, signatureOf, toIssueDto, toIssueFields } from './issue.mapper.js';

interface UpsertResult {
  issue: Issue;
  created: boolean;
  /** Dữ liệu có thật sự thay đổi so với bản đang lưu hay không. */
  changed: boolean;
  /** Tiêu đề hoặc mô tả đổi, cần tạo lại vector. */
  textChanged: boolean;
}

/**
 * Trung tâm đồng bộ issue giữa GitHub và database.
 * Thao tác từ app: gọi GitHub trước, lấy kết quả GitHub trả về rồi mới lưu và báo cho các trình duyệt.
 * Thao tác từ GitHub: nhận qua webhook rồi lưu và báo cho các trình duyệt.
 */
@Injectable()
export class IssuesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubService,
    private readonly access: AccessService,
    private readonly realtime: RealtimeGateway,
    private readonly embeddings: EmbeddingService,
  ) {}

  async list(user: User, repoId: number): Promise<IssueDto[]> {
    await this.access.requireMember(user, repoId);
    const issues = await this.prisma.issue.findMany({
      where: { repoId },
      orderBy: { number: 'desc' },
    });
    return issues.map(toIssueDto);
  }

  async get(user: User, repoId: number, number: number): Promise<IssueDto> {
    await this.access.requireMember(user, repoId);
    return toIssueDto(await this.findOrFail(repoId, number));
  }

  async create(user: User, repoId: number, dto: CreateIssueDto): Promise<IssueDto> {
    const { connected } = await this.access.requireMember(user, repoId);
    const created = await this.github.createIssue(user, connected.owner, connected.name, dto);
    return this.saveAndBroadcast(repoId, created);
  }

  async update(user: User, repoId: number, number: number, dto: UpdateIssueDto): Promise<IssueDto> {
    const { connected } = await this.access.requireMember(user, repoId);
    const existing = await this.findOrFail(repoId, number);

    // Thay cả bộ nhãn trên GitHub thì phải giữ lại nhãn "in progress" nếu issue đang ở cột Đang làm
    const labels = dto.labels
      ? [...dto.labels, ...(existing.status === IssueStatus.in_progress ? [IN_PROGRESS_LABEL] : [])]
      : undefined;

    const updated = await this.github.updateIssue(user, connected.owner, connected.name, number, {
      title: dto.title,
      body: dto.body,
      labels,
      assignees: dto.assignees,
    });
    return this.saveAndBroadcast(repoId, updated);
  }

  /** Kéo thẻ sang cột khác: cập nhật nhãn/trạng thái (mở hoặc đóng) của issue trên GitHub. */
  async updateStatus(
    user: User,
    repoId: number,
    number: number,
    status: IssueStatus,
  ): Promise<IssueDto> {
    const { connected } = await this.access.requireMember(user, repoId);
    const existing = await this.findOrFail(repoId, number);

    const baseLabels = labelsOf(existing).map((label) => label.name);
    const payload =
      status === IssueStatus.done
        ? { state: 'closed' as const, state_reason: 'completed' as const, labels: baseLabels }
        : {
            state: 'open' as const,
            ...(existing.state === 'closed' && { state_reason: 'reopened' as const }),
            labels:
              status === IssueStatus.in_progress ? [...baseLabels, IN_PROGRESS_LABEL] : baseLabels,
          };

    const updated = await this.github.updateIssue(
      user,
      connected.owner,
      connected.name,
      number,
      payload,
    );
    return this.saveAndBroadcast(repoId, updated);
  }

  /** Lần đầu kết nối repository: lấy toàn bộ issue có sẵn trên GitHub về lưu. Trả về số issue đã lưu. */
  async backfill(
    user: User,
    repository: Pick<Repository, 'id' | 'owner' | 'name'>,
  ): Promise<number> {
    const issues = await this.github.listIssues(user, repository.owner, repository.name);
    for (const issue of issues) {
      await this.upsertFromGithub(repository.id, issue);
    }
    this.embeddings.queueRepo(repository.id);
    return issues.length;
  }

  /** Xử lý sự kiện `issues` từ webhook của GitHub. */
  async applyWebhook(repoId: number, action: string, gh: GithubIssue): Promise<void> {
    if (gh.pull_request) return;

    if (action === 'deleted' || action === 'transferred') {
      const removed = await this.prisma.issue.deleteMany({ where: { repoId, number: gh.number } });
      if (removed.count > 0) this.realtime.emitIssueDeleted(repoId, gh.number);
      return;
    }
    await this.saveAndBroadcast(repoId, gh);
  }

  /** Lưu issue từ GitHub và báo cho các trình duyệt đang mở. Bỏ qua nếu dữ liệu không đổi. */
  private async saveAndBroadcast(repoId: number, gh: GithubIssue): Promise<IssueDto> {
    const result = await this.upsertFromGithub(repoId, gh);
    if (result.textChanged) this.embeddings.queueRepo(repoId);

    const dto = toIssueDto(result.issue);
    if (result.created) this.realtime.emitIssueCreated(repoId, dto);
    else if (result.changed) this.realtime.emitIssueUpdated(repoId, dto);
    return dto;
  }

  /**
   * Ghi issue vào database.
   * - Bản cũ hơn bản đang lưu (webhook đến muộn) thì bỏ qua.
   * - Cùng nội dung (ví dụ webhook dội lại thay đổi do chính app vừa làm) thì không báo lại, tránh vòng lặp đồng bộ.
   */
  private async upsertFromGithub(repoId: number, gh: GithubIssue): Promise<UpsertResult> {
    const fields = toIssueFields(gh);
    const existing = await this.prisma.issue.findUnique({
      where: { repoId_number: { repoId, number: fields.number } },
    });

    if (existing) {
      const isStale = existing.githubUpdatedAt > fields.githubUpdatedAt;
      const isSame =
        signatureOf(fields) ===
        signatureOf({
          title: existing.title,
          body: existing.body,
          state: existing.state,
          status: existing.status,
          labels: labelsOf(existing),
          assignees: assigneesOf(existing),
          closedAt: existing.closedAt,
        });
      if (isStale || isSame)
        return { issue: existing, created: false, changed: false, textChanged: false };
    }

    const issue = await this.prisma.issue.upsert({
      where: { repoId_number: { repoId, number: fields.number } },
      create: { repoId, ...fields },
      update: fields,
    });
    const textChanged = !existing || existing.title !== issue.title || existing.body !== issue.body;
    if (existing && textChanged) await this.embeddings.invalidate(issue.id);

    return { issue, created: !existing, changed: true, textChanged };
  }

  private async findOrFail(repoId: number, number: number): Promise<Issue> {
    const issue = await this.prisma.issue.findUnique({
      where: { repoId_number: { repoId, number } },
    });
    if (!issue) throw new NotFoundException(`Không tìm thấy issue #${number}`);
    return issue;
  }
}
