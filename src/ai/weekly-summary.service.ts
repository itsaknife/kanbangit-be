import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessService } from '../access/access.service.js';
import { getWeekRange } from '../common/utils/week.js';
import type { Env } from '../config/env.js';
import {
  IssueStatus,
  type Issue,
  type User,
  type WeeklySummary,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GeminiService } from './gemini.service.js';

const MAX_LISTED_ISSUES = 30;

export interface WeeklySummaryDto {
  id: number;
  weekStart: string;
  weekEnd: string;
  content: string;
  createdAt: string;
}

const SYSTEM_PROMPT = `Bạn là trợ lý viết báo cáo tiến độ cho nhóm phát triển phần mềm.
Viết bằng tiếng Việt, giọng văn tự nhiên, ngắn gọn (4 đến 8 câu, một đoạn văn).
Chỉ dùng dữ liệu được cung cấp, tuyệt đối không bịa thêm issue, người phụ trách hay con số.
Nêu rõ: tuần này nhóm hoàn thành những gì, hiện ai đang làm việc gì, và còn bao nhiêu việc chưa bắt đầu.
Nếu không có hoạt động nào trong tuần thì nói thẳng như vậy.`;

function assigneeNames(issue: Issue): string {
  const assignees = issue.assignees as Array<{ login: string }>;
  return assignees.length > 0 ? assignees.map((a) => a.login).join(', ') : 'chưa giao cho ai';
}

function describe(issues: Issue[]): string {
  if (issues.length === 0) return '(không có)';
  const lines = issues
    .slice(0, MAX_LISTED_ISSUES)
    .map((issue) => `- #${issue.number} "${issue.title}" (phụ trách: ${assigneeNames(issue)})`);
  if (issues.length > MAX_LISTED_ISSUES)
    lines.push(`- ... và ${issues.length - MAX_LISTED_ISSUES} issue khác`);
  return lines.join('\n');
}

function toDto(summary: WeeklySummary): WeeklySummaryDto {
  return {
    id: summary.id,
    weekStart: summary.weekStart,
    weekEnd: summary.weekEnd,
    content: summary.content,
    createdAt: summary.createdAt.toISOString(),
  };
}

@Injectable()
export class WeeklySummaryService {
  constructor(
    private readonly access: AccessService,
    private readonly prisma: PrismaService,
    private readonly gemini: GeminiService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Báo cáo gần nhất của repository (mọi thành viên đều đọc được). */
  async getLatest(user: User, repoId: number): Promise<WeeklySummaryDto> {
    await this.access.requireMember(user, repoId);
    const latest = await this.prisma.weeklySummary.findFirst({
      where: { repoId },
      orderBy: { createdAt: 'desc' },
    });
    if (!latest) throw new NotFoundException('Chưa có báo cáo nào');
    return toDto(latest);
  }

  /** Tạo báo cáo mới bằng LLM. Chỉ owner được bấm, để tiết kiệm lượt gọi của gói miễn phí. */
  async generate(user: User, repoId: number, weekStart?: string): Promise<WeeklySummaryDto> {
    await this.access.requireConnectedOwner(user, repoId);

    let range;
    try {
      range = getWeekRange(weekStart, this.config.get('TZ_OFFSET_MINUTES', { infer: true }));
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }

    const issues = await this.prisma.issue.findMany({
      where: { repoId },
      orderBy: { number: 'asc' },
    });
    const inRange = (date: Date | null) => !!date && date >= range.startUtc && date < range.endUtc;

    const closedThisWeek = issues.filter((issue) => inRange(issue.closedAt));
    const openedThisWeek = issues.filter((issue) => inRange(issue.githubCreatedAt));
    const inProgress = issues.filter((issue) => issue.status === IssueStatus.in_progress);
    const todoCount = issues.filter((issue) => issue.status === IssueStatus.todo).length;

    const prompt = `Tuần từ ${range.weekStart} đến ${range.weekEnd}.

Issue đã hoàn thành trong tuần (${closedThisWeek.length}):
${describe(closedThisWeek)}

Issue mới tạo trong tuần: ${openedThisWeek.length}

Issue đang được thực hiện hiện tại (${inProgress.length}):
${describe(inProgress)}

Số issue chưa bắt đầu (cột "Cần làm"): ${todoCount}`;

    const content = await this.gemini.generateText(SYSTEM_PROMPT, prompt);
    const saved = await this.prisma.weeklySummary.create({
      data: {
        repoId,
        weekStart: range.weekStart,
        weekEnd: range.weekEnd,
        content,
        createdById: user.id,
      },
    });
    return toDto(saved);
  }
}
