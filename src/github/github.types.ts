/** Repository của người dùng, đã rút gọn từ dữ liệu GitHub trả về. */
export interface GithubRepo {
  id: number;
  name: string;
  owner: string;
  fullName: string;
  description: string | null;
  isPrivate: boolean;
  openIssuesCount: number;
  /** Có quyền admin trên repository này (tức là "owner" theo cách hiểu của hệ thống). */
  canManage: boolean;
}

/** Phần dữ liệu issue của GitHub mà hệ thống dùng (từ REST API và từ webhook). */
export interface GithubIssue {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: string;
  labels: Array<string | { name?: string; color?: string | null }>;
  assignees?: Array<{ login: string; avatar_url: string }> | null;
  user: { login: string; avatar_url: string } | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull_request?: unknown;
}
