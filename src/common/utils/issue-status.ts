import { IssueState, IssueStatus } from '../../generated/prisma/client.js';

/** Initial import only. Existing issues preserve local status unless GitHub state changes. */
export function deriveStatus(state: IssueState, _labelNames: string[]): IssueStatus {
  return state === IssueState.closed ? IssueStatus.closed : IssueStatus.todo;
}
