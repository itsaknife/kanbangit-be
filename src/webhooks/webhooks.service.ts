import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
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

  async handle(event: string | undefined, payload: unknown, delivery: string): Promise<void> {
    if (event !== 'issues') return; // ping và các sự kiện khác không cần xử lý

    if (!payload || typeof payload !== 'object')
      throw new BadRequestException('Webhook payload không hợp lệ');
    const { action, issue, repository } = payload as IssuesEventPayload;
    if (
      !repository ||
      !Number.isSafeInteger(repository.id) ||
      !issue ||
      !Number.isSafeInteger(issue.id) ||
      !Number.isSafeInteger(issue.number) ||
      typeof action !== 'string' ||
      typeof issue.title !== 'string' ||
      !['open', 'closed'].includes(issue.state) ||
      !Array.isArray(issue.labels) ||
      !Number.isFinite(Date.parse(issue.updated_at)) ||
      !Number.isFinite(Date.parse(issue.created_at))
    )
      throw new BadRequestException('Webhook issue không hợp lệ');
    if (issue.pull_request) return;
    const connected = await this.prisma.repository.findUnique({
      where: { githubId: BigInt(repository.id) },
    });
    if (!connected) return; // repository chưa kết nối

    this.logger.debug(`${connected.fullName} #${issue.number}: ${action}`);
    const result = await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Repository" WHERE id=${connected.id} FOR UPDATE`;
        if (await tx.webhookEvent.findUnique({ where: { githubDeliveryId: delivery } }))
          return null;
        const applied = await this.issues.applyWebhook(connected.id, action, issue, tx);
        await tx.webhookEvent.create({
          data: {
            repositoryId: connected.id,
            githubDeliveryId: delivery,
            eventType: 'issues',
            processedAt: new Date(),
          },
        });
        return applied;
      },
      { timeout: 30000 },
    );
    await this.issues.publishGithub(result);
  }
}
