import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { GeminiService } from './gemini.service.js';

const BATCH_SIZE = 20;
const MAX_TEXT_LENGTH = 2000;

/** Nội dung dùng để tạo vector của một issue: tiêu đề + mô tả (cắt bớt nếu quá dài). */
export function buildIssueText(title: string, body: string | null | undefined): string {
  return `${title}\n\n${body ?? ''}`.trim().slice(0, MAX_TEXT_LENGTH);
}

/** Vector viết dưới dạng chuỗi mà pgvector hiểu, ví dụ "[0.1,0.2,0.3]". */
export function toVectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}

interface PendingIssue {
  id: number;
  title: string;
  body: string | null;
}

/** Tạo và lưu vector cho issue để phục vụ tìm issue gần giống (pgvector). */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly running = new Set<number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly gemini: GeminiService,
  ) {}

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.gemini.embed([text], 'query');
    if (!vector?.length) throw new Error('Không tạo được vector cho nội dung issue');
    return vector;
  }

  /** Xóa vector cũ của issue (khi tiêu đề hoặc mô tả đổi) để lần sau tạo lại. */
  async invalidate(issueId: number): Promise<void> {
    await this.prisma.$executeRaw`UPDATE "Issue" SET embedding = NULL WHERE id = ${issueId}`;
  }

  /**
   * Tạo vector cho các issue của repository chưa có vector, chạy nền (không chờ kết quả).
   * Gói miễn phí có giới hạn lượt gọi nên làm theo từng lô, gặp lỗi thì dừng và để lần sau làm tiếp.
   */
  queueRepo(repoId: number): void {
    if (!this.gemini.isConfigured || this.running.has(repoId)) return;
    this.running.add(repoId);
    void this.embedPending(repoId)
      .catch((error: Error) =>
        this.logger.warn(`Dừng tạo vector cho repo ${repoId}: ${error.message}`),
      )
      .finally(() => this.running.delete(repoId));
  }

  private async embedPending(repoId: number): Promise<void> {
    for (;;) {
      const pending = await this.prisma.$queryRaw<PendingIssue[]>`
        SELECT id, title, body FROM "Issue"
        WHERE "repoId" = ${repoId} AND embedding IS NULL
        ORDER BY id LIMIT ${BATCH_SIZE}`;
      if (pending.length === 0) return;

      const vectors = await this.gemini.embed(
        pending.map((issue) => buildIssueText(issue.title, issue.body)),
        'document',
      );
      if (vectors.length !== pending.length)
        throw new Error('Số vector trả về không khớp số issue');

      for (const [index, issue] of pending.entries()) {
        const literal = toVectorLiteral(vectors[index] ?? []);
        await this.prisma
          .$executeRaw`UPDATE "Issue" SET embedding = ${literal}::vector WHERE id = ${issue.id}`;
      }
    }
  }
}
