import { describe, expect, it } from 'vitest';
import { IssueState, IssueStatus } from '../../generated/prisma/client.js';
import { deriveStatus } from './issue-status.js';

describe('deriveStatus', () => {
  it('imports closed GitHub issues as closed', () => {
    expect(deriveStatus(IssueState.closed, ['in progress'])).toBe(IssueStatus.closed);
  });

  it('does not infer local progress from GitHub labels', () => {
    expect(deriveStatus(IssueState.open, ['bug', 'In Progress'])).toBe(IssueStatus.todo);
  });

  it('issue đang mở không có nhãn trạng thái là todo', () => {
    expect(deriveStatus(IssueState.open, ['bug'])).toBe(IssueStatus.todo);
  });
});
