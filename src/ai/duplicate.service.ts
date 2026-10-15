import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessService } from '../access/access.service.js';
import type { Env } from '../config/env.js';
import type { User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { DuplicateCheckDto } from './dto/duplicate-check.dto.js';
import { buildIssueText, EmbeddingService, toVectorLiteral } from './embedding.service.js';
import { GeminiService } from './gemini.service.js';

const CANDIDATE_LIMIT = 3;
const BODY_PREVIEW_LENGTH = 800;

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  candidates: Array<{ issueNumber: number; title: string; reason: string }>;
}

interface CandidateRow {
  number: number;
  title: string;
  body: string | null;
  similarity: number;
}

const SYSTEM_PROMPT = `Bạn là trợ lý của nhóm phát triển phần mềm, nhiệm vụ là phát hiện issue bị trùng lặp.
Hai issue được coi là trùng khi chúng mô tả cùng một vấn đề hoặc cùng một yêu cầu, dù cách diễn đạt khác nhau.
Hai issue chỉ cùng chủ đề chung nhưng nói về việc khác nhau thì KHÔNG trùng.
Chỉ trả về các issue ứng viên thực sự trùng với issue mới. Nếu không có issue nào trùng thì trả về danh sách rỗng.
Lý do viết bằng tiếng Việt, ngắn gọn, một đến hai câu.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    duplicates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          issueNumber: { type: 'integer' },
          reason: { type: 'string' },
        },
        required: ['issueNumber', 'reason'],
      },
    },
  },
  required: ['duplicates'],
};

/**
 * Phát hiện issue trùng theo 2 bước:
 * 1. Embedding + pgvector chọn ra vài issue gần giống nhất (không dùng LLM).
 * 2. LLM đọc nội dung chữ của issue mới và các ứng viên để kết luận có trùng không, kèm lý do.
 */
@Injectable()
export class DuplicateService {
  private readonly logger = new Logger(DuplicateService.name);

  constructor(
    private readonly access: AccessService,
    private readonly prisma: PrismaService,
    private readonly embeddings: EmbeddingService,
    private readonly gemini: GeminiService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async check(user: User, repoId: number, dto: DuplicateCheckDto): Promise<DuplicateCheckResult> {
    await this.access.requireMember(user, repoId);

    // Bước 1: tìm ứng viên bằng vector
    const queryVector = await this.embeddings.embedQuery(buildIssueText(dto.title, dto.body));
    const literal = toVectorLiteral(queryVector);
    const rows = await this.prisma.$queryRaw<CandidateRow[]>`
      SELECT number, title, body, 1 - (embedding <=> ${literal}::vector) AS similarity
      FROM "Issue"
      WHERE "repoId" = ${repoId} AND embedding IS NOT NULL
      ORDER BY embedding <=> ${literal}::vector
      LIMIT ${CANDIDATE_LIMIT}`;

    const minSimilarity = this.config.get('DUPLICATE_MIN_SIMILARITY', { infer: true });
    const candidates = rows.filter((row) => Number(row.similarity) >= minSimilarity);
    if (candidates.length === 0) return { isDuplicate: false, candidates: [] };

    // Bước 2: LLM đọc nội dung chữ và kết luận
    const result = await this.gemini.generateJson<{
      duplicates: Array<{ issueNumber: number; reason: string }>;
    }>(SYSTEM_PROMPT, this.buildPrompt(dto, candidates), RESPONSE_SCHEMA);

    const byNumber = new Map(candidates.map((candidate) => [candidate.number, candidate]));
    const confirmed = (result.duplicates ?? []).flatMap((item) => {
      const candidate = byNumber.get(item.issueNumber);
      // Bỏ qua số issue LLM tự bịa ra, không nằm trong danh sách ứng viên
      return candidate
        ? [{ issueNumber: candidate.number, title: candidate.title, reason: item.reason }]
        : [];
    });
    this.logger.debug(
      `Repo ${repoId}: ${candidates.length} ứng viên, LLM xác nhận ${confirmed.length}`,
    );

    return { isDuplicate: confirmed.length > 0, candidates: confirmed };
  }

  private buildPrompt(dto: DuplicateCheckDto, candidates: CandidateRow[]): string {
    const candidateText = candidates
      .map(
        (candidate) =>
          `--- Issue #${candidate.number} ---\nTiêu đề: ${candidate.title}\nMô tả: ${(candidate.body ?? '(trống)').slice(0, BODY_PREVIEW_LENGTH)}`,
      )
      .join('\n\n');

    return `ISSUE MỚI
Tiêu đề: ${dto.title}
Mô tả: ${(dto.body ?? '(trống)').slice(0, BODY_PREVIEW_LENGTH)}

CÁC ISSUE ỨNG VIÊN (đã có trong hệ thống)
${candidateText}`;
  }
}
