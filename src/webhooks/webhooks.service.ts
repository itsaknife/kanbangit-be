import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Webhooks } from '@octokit/webhooks';
import type { Env } from '../config/env.js';
import type { GithubIssue } from '../github/github.types.js';
import { IssuesService } from '../issues/issues.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

interface IssuesEventPayload {
  action: string;
  issue: GithubIssue;
  repository: { id: number };
}

/** Nhận thay đổi từ GitHub (tạo, sửa, đóng, gắn nhãn, giao việc...) và cập nhật vào hệ thống. */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  private readonly webhooks: Webhooks;

  constructor(
    config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly issues: IssuesService,
  ) {
    this.webhooks = new Webhooks({ secret: config.get('GITHUB_WEBHOOK_SECRET', { infer: true }) });
  }

  /** Kiểm tra chữ ký để chắc chắn yêu cầu thật sự do GitHub gửi, không phải ai đó giả mạo. */
  async assertSignature(rawBody: string, signature: string | undefined): Promise<void> {
    const valid = signature
      ? await this.webhooks.verify(rawBody, signature).catch(() => false)
      : false;
    if (!valid) throw new UnauthorizedException('Chữ ký webhook không hợp lệ');
  }

  async handle(event: string | undefined, payload: unknown): Promise<void> {
    if (event !== 'issues') return; // ping và các sự kiện khác không cần xử lý

    const { action, issue, repository } = payload as IssuesEventPayload;
    const connected = await this.prisma.repository.findUnique({ where: { id: repository.id } });
    if (!connected) return; // repository chưa kết nối

    this.logger.debug(`${connected.fullName} #${issue.number}: ${action}`);
    await this.issues.applyWebhook(connected.id, action, issue);
  }
}
