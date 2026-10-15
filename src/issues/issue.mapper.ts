import type { IssueDto } from '../common/types/issue.dto.js';
import { IN_PROGRESS_LABEL } from '../common/constants/issues.js';
import { deriveStatus } from '../common/utils/issue-status.js';
import { IssueState, type Issue, type IssueStatus } from '../generated/prisma/client.js';
import type { GithubIssue } from '../github/github.types.js';

export type IssueLabelData = {
  name: string;
  color: string;
};

export type IssueUserData = {
  login: string;
  avatarUrl: string;
};

/** Các trường của bản sao issue trong database, tính từ dữ liệu GitHub. */
export interface IssueFields {
  githubId: bigint;
  number: number;
  title: string;
  body: string | null;
  state: IssueState;
  status: IssueStatus;
  labels: IssueLabelData[];
  assignees: IssueUserData[];
  authorLogin: string | null;
  authorAvatar: string | null;
  htmlUrl: string;
  githubCreatedAt: Date;
  githubUpdatedAt: Date;
  closedAt: Date | null;
}

/** Danh sách nhãn của issue GitHub (GitHub có thể trả nhãn dạng chuỗi hoặc đối tượng). */
function readLabels(labels: GithubIssue['labels']): IssueLabelData[] {
  return labels.flatMap((label) => {
    if (typeof label === 'string') return [{ name: label, color: 'ededed' }];
    return label.name ? [{ name: label.name, color: label.color ?? 'ededed' }] : [];
  });
}

export function toIssueFields(gh: GithubIssue): IssueFields {
  const allLabels = readLabels(gh.labels);
  const state = gh.state === 'closed' ? IssueState.closed : IssueState.open;

  return {
    githubId: BigInt(gh.id),
    number: gh.number,
    title: gh.title,
    body: gh.body ?? null,
    state,
    status: deriveStatus(
      state,
      allLabels.map((label) => label.name),
    ),
    // Nhãn "in progress" chỉ dùng để biểu diễn cột Kanban nên không đưa ra giao diện như một nhãn thường
    labels: allLabels.filter((label) => label.name.toLowerCase() !== IN_PROGRESS_LABEL),
    assignees: (gh.assignees ?? []).map((user) => ({
      login: user.login,
      avatarUrl: user.avatar_url,
    })),
    authorLogin: gh.user?.login ?? null,
    authorAvatar: gh.user?.avatar_url ?? null,
    htmlUrl: gh.html_url,
    githubCreatedAt: new Date(gh.created_at),
    githubUpdatedAt: new Date(gh.updated_at),
    closedAt: gh.closed_at ? new Date(gh.closed_at) : null,
  };
}

/** Chuỗi đại diện cho nội dung issue, dùng để biết webhook gửi về có thật sự khác dữ liệu đang lưu không. */
export function signatureOf(
  fields: Pick<
    IssueFields,
    'title' | 'body' | 'state' | 'status' | 'labels' | 'assignees' | 'closedAt'
  >,
): string {
  return JSON.stringify([
    fields.title,
    fields.body,
    fields.state,
    fields.status,
    fields.labels,
    fields.assignees,
    fields.closedAt?.getTime() ?? null,
  ]);
}

/** Nhãn và người được giao lưu dạng JSON trong database, đọc ra với đúng kiểu. */
export const labelsOf = (issue: Pick<Issue, 'labels'>) =>
  issue.labels as unknown as IssueLabelData[];
export const assigneesOf = (issue: Pick<Issue, 'assignees'>) =>
  issue.assignees as unknown as IssueUserData[];

export function toIssueDto(issue: Issue): IssueDto {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    status: issue.status,
    labels: labelsOf(issue),
    assignees: assigneesOf(issue),
    author: issue.authorLogin
      ? { login: issue.authorLogin, avatarUrl: issue.authorAvatar ?? '' }
      : null,
    htmlUrl: issue.htmlUrl,
    createdAt: issue.githubCreatedAt.toISOString(),
    updatedAt: issue.githubUpdatedAt.toISOString(),
    closedAt: issue.closedAt?.toISOString() ?? null,
  };
}
