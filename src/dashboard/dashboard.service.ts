import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessService } from '../access/access.service.js';
import { getWeekRange, listWeekDays, toLocalDateString } from '../common/utils/week.js';
import type { Env } from '../config/env.js';
import { IssueStatus, type User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface DashboardStatsDto {
  weekStart: string;
  weekEnd: string;
  totalIssues: number;
  todo: number;
  inProgress: number;
  done: number;
  closedThisWeek: number;
  members: Array<{
    login: string;
    avatarUrl: string;
    todo: number;
    inProgress: number;
    done: number;
  }>;
  dailyClosed: Array<{ date: string; count: number }>;
}

/** Thống kê của cả repository: tổng quan, khối lượng việc từng thành viên, và số issue xong theo ngày trong tuần. */
@Injectable()
export class DashboardService {
  constructor(
    private readonly access: AccessService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async getStats(user: User, repoId: number, weekStart?: string): Promise<DashboardStatsDto> {
    await this.access.requireMember(user, repoId);

    const offset = this.config.get('TZ_OFFSET_MINUTES', { infer: true });
    let range;
    try {
      range = getWeekRange(weekStart, offset);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }

    const issues = await this.prisma.issue.findMany({
      where: { repoId },
      select: { status: true, assignees: true, closedAt: true },
    });

    const dailyClosed = new Map(listWeekDays(range.weekStart).map((date) => [date, 0]));
    const members = new Map<string, DashboardStatsDto['members'][number]>();
    let todo = 0;
    let inProgress = 0;
    let done = 0;
    let closedThisWeek = 0;

    for (const issue of issues) {
      if (issue.status === IssueStatus.todo) todo += 1;
      else if (issue.status === IssueStatus.in_progress) inProgress += 1;
      else done += 1;

      if (issue.closedAt && issue.closedAt >= range.startUtc && issue.closedAt < range.endUtc) {
        closedThisWeek += 1;
        const day = toLocalDateString(issue.closedAt, offset);
        dailyClosed.set(day, (dailyClosed.get(day) ?? 0) + 1);
      }

      for (const assignee of issue.assignees as Array<{ login: string; avatarUrl: string }>) {
        const member = members.get(assignee.login) ?? {
          login: assignee.login,
          avatarUrl: assignee.avatarUrl,
          todo: 0,
          inProgress: 0,
          done: 0,
        };
        if (issue.status === IssueStatus.todo) member.todo += 1;
        else if (issue.status === IssueStatus.in_progress) member.inProgress += 1;
        else member.done += 1;
        members.set(assignee.login, member);
      }
    }

    return {
      weekStart: range.weekStart,
      weekEnd: range.weekEnd,
      totalIssues: issues.length,
      todo,
      inProgress,
      done,
      closedThisWeek,
      members: [...members.values()].sort(
        (a, b) => b.todo + b.inProgress + b.done - (a.todo + a.inProgress + a.done),
      ),
      dailyClosed: [...dailyClosed].map(([date, count]) => ({ date, count })),
    };
  }
}
