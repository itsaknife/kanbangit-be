import { describe, expect, it } from 'vitest';
import { IssueState, IssueStatus } from '../../generated/prisma/client.js';
import { deriveStatus } from './issue-status.js';

describe('deriveStatus', () => {
  it('issue đã đóng là done, dù còn nhãn in progress', () => {
    expect(deriveStatus(IssueState.closed, ['in progress'])).toBe(IssueStatus.done);
  });

  it('issue đang mở có nhãn in progress là in_progress (không phân biệt hoa thường)', () => {
    expect(deriveStatus(IssueState.open, ['bug', 'In Progress'])).toBe(IssueStatus.in_progress);
  });

  it('issue đang mở không có nhãn trạng thái là todo', () => {
    expect(deriveStatus(IssueState.open, ['bug'])).toBe(IssueStatus.todo);
  });
});
