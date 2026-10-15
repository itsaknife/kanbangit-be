import { describe, expect, it } from 'vitest';
import { IssueState, IssueStatus } from '../generated/prisma/client.js';
import type { GithubIssue } from '../github/github.types.js';
import { signatureOf, toIssueFields } from './issue.mapper.js';

const base: GithubIssue = {
  id: 3_000_000_001,
  number: 7,
  title: 'Lỗi đăng nhập',
  body: 'Không đăng nhập được',
  state: 'open',
  labels: [
    { name: 'bug', color: 'd73a4a' },
    { name: 'in progress', color: 'fbca04' },
  ],
  assignees: [{ login: 'huy', avatar_url: 'https://a/huy.png' }],
  user: { login: 'lan', avatar_url: 'https://a/lan.png' },
  html_url: 'https://github.com/o/r/issues/7',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
  closed_at: null,
};

describe('toIssueFields', () => {
  it('suy ra cột Đang làm từ nhãn và ẩn nhãn trạng thái khỏi danh sách nhãn', () => {
    const fields = toIssueFields(base);
    expect(fields.status).toBe(IssueStatus.in_progress);
    expect(fields.labels).toEqual([{ name: 'bug', color: 'd73a4a' }]);
  });

  it('giữ nguyên id lớn của GitHub (vượt 32 bit)', () => {
    expect(toIssueFields(base).githubId).toBe(3_000_000_001n);
  });

  it('issue đã đóng là done và có thời điểm đóng', () => {
    const fields = toIssueFields({ ...base, state: 'closed', closed_at: '2026-10-03T00:00:00Z' });
    expect(fields.state).toBe(IssueState.closed);
    expect(fields.status).toBe(IssueStatus.done);
    expect(fields.closedAt?.toISOString()).toBe('2026-10-03T00:00:00.000Z');
  });

  it('chấp nhận nhãn dạng chuỗi và issue không có người được giao', () => {
    const fields = toIssueFields({ ...base, labels: ['task'], assignees: null });
    expect(fields.labels).toEqual([{ name: 'task', color: 'ededed' }]);
    expect(fields.assignees).toEqual([]);
  });
});

describe('signatureOf', () => {
  it('giống nhau khi nội dung không đổi, khác nhau khi đổi trạng thái', () => {
    const a = toIssueFields(base);
    expect(signatureOf(a)).toBe(signatureOf(toIssueFields(base)));
    expect(signatureOf(a)).not.toBe(signatureOf(toIssueFields({ ...base, state: 'closed' })));
  });
});
