import { IssueState, IssueStatus } from '../../generated/prisma/client.js';
import { IN_PROGRESS_LABEL } from '../constants/issues.js';

/** Suy ra cột Kanban từ trạng thái và nhãn của issue trên GitHub. */
export function deriveStatus(state: IssueState, labelNames: string[]): IssueStatus {
  if (state === IssueState.closed) return IssueStatus.done;
  const inProgress = labelNames.some((name) => name.toLowerCase() === IN_PROGRESS_LABEL);
  return inProgress ? IssueStatus.in_progress : IssueStatus.todo;
}
