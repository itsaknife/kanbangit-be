import type { IssueStatus } from '../../generated/prisma/client.js';

export interface IssueDto {
  id: string;
  trackerId: string;
  issueCode: string;
  number: number | null;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  status: IssueStatus;
  labels: Array<{ name: string; color: string }>;
  assignees: Array<{ login: string; avatarUrl: string }>;
  assigneeId: string | null;
  author: { login: string; avatarUrl: string } | null;
  htmlUrl: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  dueDate: string | null;
  startDate: string | null;
  endDate: string | null;
  estimateMinutes: number | null;
  parentId: string | null;
  subIssueEstimateMinutes?: number;
  combinedEstimateMinutes?: number | null;
  syncStatus: 'PENDING_SYNC' | 'SYNCED' | 'NEEDS_ATTENTION';
}
