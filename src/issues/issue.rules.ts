import { BadRequestException } from '@nestjs/common';

export type HierarchyNode = {
  id: string;
  parentId: string | null;
  estimateMinutes: number | null;
};

function invalidParent(message: string): never {
  throw new BadRequestException({ code: 'INVALID_PARENT_ISSUE', message });
}

function childrenByParent(nodes: HierarchyNode[]): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node.id);
    children.set(node.parentId, siblings);
  }
  return children;
}

export function validateHierarchy(
  nodes: HierarchyNode[],
  issueId: string,
  parentId: string | null,
): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ancestors = new Set([issueId]);
  let depth = 1;
  let current = parentId;
  while (current !== null) {
    if (ancestors.has(current)) invalidParent('Issue hierarchy cannot contain a cycle.');
    ancestors.add(current);
    const ancestor = byId.get(current);
    if (!ancestor) invalidParent('Parent issue must belong to the same repository.');
    depth += 1;
    current = ancestor.parentId;
  }

  // Replace the old edge: validation must describe the proposed hierarchy.
  const children = childrenByParent(nodes.filter((node) => node.id !== issueId));
  const pending = [{ id: issueId, depth }];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (visited.has(node.id)) invalidParent('Issue hierarchy cannot contain a cycle.');
    visited.add(node.id);
    if (node.depth > 3) invalidParent('Issue hierarchy cannot exceed three levels.');
    for (const child of children.get(node.id) ?? []) {
      pending.push({ id: child, depth: node.depth + 1 });
    }
  }
}

export function descendantIds(nodes: HierarchyNode[], rootId: string): string[] {
  const children = childrenByParent(nodes);
  const visited = new Set([rootId]);
  const pending = [...(children.get(rootId) ?? [])];
  const descendants: string[] = [];
  for (let index = 0; index < pending.length; index += 1) {
    const id = pending[index];
    if (visited.has(id)) continue;
    visited.add(id);
    descendants.push(id);
    pending.push(...(children.get(id) ?? []));
  }
  return descendants;
}

export function estimateTotals(
  nodes: HierarchyNode[],
  id: string,
): { subIssueEstimateMinutes: number; combinedEstimateMinutes: number | null } {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ownEstimate = byId.get(id)?.estimateMinutes ?? null;
  let hasEstimate = ownEstimate !== null;
  let subIssueEstimateMinutes = 0;
  for (const descendantId of descendantIds(nodes, id)) {
    const estimate = byId.get(descendantId)?.estimateMinutes ?? null;
    if (estimate !== null) {
      hasEstimate = true;
      subIssueEstimateMinutes += estimate;
    }
  }
  return {
    subIssueEstimateMinutes,
    combinedEstimateMinutes: hasEstimate ? (ownEstimate ?? 0) + subIssueEstimateMinutes : null,
  };
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysPerMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysPerMonth[month - 1];
}

export function validatePlanning(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
  estimateMinutes: number | null | undefined,
): void {
  for (const [field, value] of [
    ['startDate', startDate],
    ['endDate', endDate],
  ] as const) {
    if (value != null && !isCalendarDate(value)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `${field} must be a valid calendar date in YYYY-MM-DD format.`,
      });
    }
  }
  if (startDate != null && endDate != null && startDate > endDate) {
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Start date must not be after end date.',
    });
  }
  if (
    estimateMinutes != null &&
    (!Number.isInteger(estimateMinutes) || estimateMinutes < 0 || estimateMinutes % 30 !== 0)
  ) {
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Estimate minutes must be a nonnegative integer divisible by 30.',
    });
  }
}

export function githubStateForStatus(status: string): 'open' | 'closed' {
  return status === 'closed' || status === 'canceled' ? 'closed' : 'open';
}

export function statusFromGithub(
  previousStatus: string | undefined,
  previousGithubState: 'open' | 'closed' | null,
  state: 'open' | 'closed',
): string {
  if (previousStatus === undefined) return state === 'closed' ? 'closed' : 'todo';
  if (previousGithubState === 'open' && state === 'closed') return 'closed';
  if (previousGithubState === 'closed' && state === 'open') return 'reopen';
  return previousStatus;
}
