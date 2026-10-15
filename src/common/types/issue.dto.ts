/** Hình dạng issue mà backend trả cho frontend (khớp với src/types/issue.types.ts bên frontend). */
export interface IssueDto {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  status: 'todo' | 'in_progress' | 'done';
  labels: Array<{ name: string; color: string }>;
  assignees: Array<{ login: string; avatarUrl: string }>;
  author: { login: string; avatarUrl: string } | null;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}
