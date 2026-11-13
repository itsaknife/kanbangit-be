import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  descendantIds,
  estimateTotals,
  githubStateForStatus,
  statusFromGithub,
  validateHierarchy,
  validatePlanning,
  type HierarchyNode,
} from './issue.rules.js';

const node = (
  id: string,
  parentId: string | null = null,
  estimateMinutes: number | null = null,
): HierarchyNode => ({ id, parentId, estimateMinutes });

function expectBadRequest(action: () => void, code: string): void {
  expect(action).toThrow(BadRequestException);
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getStatus()).toBe(400);
    expect((error as BadRequestException).getResponse()).toEqual({
      code,
      message: expect.any(String),
    });
  }
}

describe('validateHierarchy', () => {
  const tree = [node('root'), node('child', 'root'), node('grandchild', 'child')];

  it('allows a new root and new issues at levels two and three', () => {
    expect(() => validateHierarchy([], 'new', null)).not.toThrow();
    expect(() => validateHierarchy(tree, 'new', 'root')).not.toThrow();
    expect(() => validateHierarchy(tree, 'new', 'child')).not.toThrow();
  });

  it('rejects a parent absent from the repository nodes', () => {
    expectBadRequest(() => validateHierarchy(tree, 'new', 'missing'), 'INVALID_PARENT_ISSUE');
  });

  it.each(['root', 'new'])('rejects self-parenting for %s', (id) => {
    expectBadRequest(() => validateHierarchy(tree, id, id), 'INVALID_PARENT_ISSUE');
  });

  it.each(['child', 'grandchild'])('rejects moving a root under its descendant %s', (id) => {
    expectBadRequest(() => validateHierarchy(tree, 'root', id), 'INVALID_PARENT_ISSUE');
  });

  it('rejects creating a fourth level', () => {
    expectBadRequest(() => validateHierarchy(tree, 'new', 'grandchild'), 'INVALID_PARENT_ISSUE');
  });

  it('counts the entire moved subtree, not only the target depth', () => {
    const nodes = [...tree, node('destination')];
    expectBadRequest(() => validateHierarchy(nodes, 'root', 'destination'), 'INVALID_PARENT_ISSUE');
    expect(() => validateHierarchy(nodes, 'child', 'destination')).not.toThrow();
  });

  it('rejects moving a two-level subtree under a level-two parent', () => {
    const nodes = [...tree, node('other'), node('leaf', 'other')];
    expectBadRequest(() => validateHierarchy(nodes, 'other', 'child'), 'INVALID_PARENT_ISSUE');
  });

  it('uses the proposed parent when detaching or repairing an old cycle', () => {
    expect(() => validateHierarchy(tree, 'child', null)).not.toThrow();
    expect(() => validateHierarchy([node('a', 'b'), node('b', 'a')], 'a', null)).not.toThrow();
    expect(() => validateHierarchy([node('a', 'missing')], 'a', null)).not.toThrow();
  });

  it('rejects an existing ancestor cycle without hanging', () => {
    expectBadRequest(
      () => validateHierarchy([node('a', 'b'), node('b', 'a')], 'new', 'a'),
      'INVALID_PARENT_ISSUE',
    );
  });

  it('rejects a missing ancestor and an overdeep subtree even when detached', () => {
    expectBadRequest(
      () => validateHierarchy([node('a', 'missing')], 'new', 'a'),
      'INVALID_PARENT_ISSUE',
    );
    expectBadRequest(
      () => validateHierarchy([...tree, node('fourth', 'grandchild')], 'root', null),
      'INVALID_PARENT_ISSUE',
    );
  });

  it('does not mutate nodes or reject unrelated malformed branches', () => {
    const nodes = Object.freeze([
      Object.freeze(node('root')),
      Object.freeze(node('a', 'b')),
      Object.freeze(node('b', 'a')),
    ]);
    expect(() => validateHierarchy([...nodes], 'new', 'root')).not.toThrow();
    expect(nodes).toEqual([node('root'), node('a', 'b'), node('b', 'a')]);
  });
});

describe('descendantIds', () => {
  const nodes = [node('root'), node('a', 'root'), node('b', 'root'), node('c', 'a'), node('other')];

  it('includes all descendants once, excluding the root and unrelated nodes', () => {
    expect(descendantIds(nodes, 'root').sort()).toEqual(['a', 'b', 'c']);
    expect(descendantIds(nodes, 'a')).toEqual(['c']);
  });

  it('returns no descendants for a leaf or an unknown root', () => {
    expect(descendantIds(nodes, 'c')).toEqual([]);
    expect(descendantIds(nodes, 'unknown')).toEqual([]);
    expect(descendantIds([], 'root')).toEqual([]);
  });

  it('remains bounded for cycles and duplicate edges and never returns the root', () => {
    expect(descendantIds([node('a', 'b'), node('b', 'a'), node('b', 'a')], 'a')).toEqual(['b']);
    expect(descendantIds([node('a', 'a')], 'a')).toEqual([]);
  });

  it('handles long malformed chains without recursive stack overflow', () => {
    const chain = Array.from({ length: 10_000 }, (_, index) =>
      node(String(index), index === 0 ? null : String(index - 1)),
    );
    expect(descendantIds(chain, '0')).toHaveLength(9_999);
  });
});

describe('estimateTotals', () => {
  it('sums all descendants separately from the independent parent estimate', () => {
    const nodes = [
      node('root', null, 600),
      node('a', 'root', 180),
      node('b', 'a', 240),
      node('x', null, 90),
    ];
    expect(estimateTotals(nodes, 'root')).toEqual({
      subIssueEstimateMinutes: 420,
      combinedEstimateMinutes: 1_020,
    });
    expect(nodes[0].estimateMinutes).toBe(600);
  });

  it.each([
    { nodes: [], id: 'missing' },
    { nodes: [node('root')], id: 'root' },
    { nodes: [node('root'), node('a', 'root')], id: 'root' },
  ])('keeps combined estimate null when all estimates are absent: $nodes', ({ nodes, id }) => {
    expect(estimateTotals(nodes, id)).toEqual({
      subIssueEstimateMinutes: 0,
      combinedEstimateMinutes: null,
    });
  });

  it.each([
    { nodes: [node('root', null, 0)], sub: 0, combined: 0 },
    { nodes: [node('root'), node('a', 'root', 0)], sub: 0, combined: 0 },
    { nodes: [node('root'), node('a', 'root', 60)], sub: 60, combined: 60 },
    { nodes: [node('root', null, 30), node('a', 'root')], sub: 0, combined: 30 },
  ])('distinguishes explicit estimates from missing ones: $nodes', ({ nodes, sub, combined }) => {
    expect(estimateTotals(nodes, 'root')).toEqual({
      subIssueEstimateMinutes: sub,
      combinedEstimateMinutes: combined,
    });
  });

  it('does not count the parent twice in malformed cyclic input', () => {
    expect(estimateTotals([node('a', 'b', 30), node('b', 'a', 60)], 'a')).toEqual({
      subIssueEstimateMinutes: 60,
      combinedEstimateMinutes: 90,
    });
  });
});

describe('validatePlanning', () => {
  it('allows absent fields, one-sided dates, and equal dates', () => {
    expect(() => validatePlanning(undefined, undefined, undefined)).not.toThrow();
    expect(() => validatePlanning(null, null, null)).not.toThrow();
    expect(() => validatePlanning('2026-11-13', null, 0)).not.toThrow();
    expect(() => validatePlanning(undefined, '2026-11-13', 30)).not.toThrow();
    expect(() => validatePlanning('2026-11-13', '2026-11-13', 120)).not.toThrow();
    expect(() => validatePlanning('2026-12-31', '2027-01-01', 90)).not.toThrow();
  });

  it.each(['2000-02-29', '2024-02-29', '2400-02-29', '0001-01-01', '0096-02-29', '9999-12-31'])(
    'accepts real calendar dates including leap years: %s',
    (date) => expect(() => validatePlanning(date, date, null)).not.toThrow(),
  );

  it.each([
    '',
    '2026-2-01',
    '2026-02-1',
    '26-02-01',
    '10000-01-01',
    '0000-01-01',
    '2026-00-01',
    '2026-13-01',
    '2026-01-00',
    '2026-01-32',
    '2026-04-31',
    '2026-02-29',
    '1900-02-29',
    '2100-02-29',
    '2024-02-30',
    '2026-11-13T00:00:00Z',
    ' 2026-11-13',
    '2026-11-13 ',
    '2026-11-13\n',
  ])('rejects invalid calendar dates in either field: %j', (date) => {
    expectBadRequest(() => validatePlanning(date, null, null), 'VALIDATION_ERROR');
    expectBadRequest(() => validatePlanning(null, date, null), 'VALIDATION_ERROR');
  });

  it('rejects reversed date ranges', () => {
    expectBadRequest(() => validatePlanning('2027-01-01', '2026-12-31', null), 'VALIDATION_ERROR');
  });

  it.each([-30, -1, 1, 15, 45, 75, 30.5, NaN, Infinity, -Infinity])(
    'rejects estimates outside nonnegative integer half-hour steps: %s',
    (estimate) =>
      expectBadRequest(() => validatePlanning(null, null, estimate), 'VALIDATION_ERROR'),
  );

  it.each([0, 30, 60, 90, 600])('accepts estimate minutes %s', (estimate) => {
    expect(() => validatePlanning(null, null, estimate)).not.toThrow();
  });
});

const statuses = [
  'todo',
  'in_progress',
  'done',
  'verified',
  'closed',
  'reopen',
  'rejected',
  'paused',
  'canceled',
];

describe('githubStateForStatus', () => {
  it.each(statuses)('maps %s according to the nine-status specification', (status) => {
    expect(githubStateForStatus(status)).toBe(
      status === 'closed' || status === 'canceled' ? 'closed' : 'open',
    );
  });
});

describe('statusFromGithub', () => {
  it.each(['open', 'closed', null] as const)(
    'initializes imports with previous state %s',
    (previous) => {
      expect(statusFromGithub(undefined, previous, 'open')).toBe('todo');
      expect(statusFromGithub(undefined, previous, 'closed')).toBe('closed');
    },
  );

  it.each(statuses)('preserves local %s on unchanged or unknown GitHub state', (status) => {
    expect(statusFromGithub(status, 'open', 'open')).toBe(status);
    expect(statusFromGithub(status, 'closed', 'closed')).toBe(status);
    expect(statusFromGithub(status, null, 'open')).toBe(status);
    expect(statusFromGithub(status, null, 'closed')).toBe(status);
  });

  it.each(statuses)('applies real GitHub state edges to local %s', (status) => {
    expect(statusFromGithub(status, 'open', 'closed')).toBe('closed');
    expect(statusFromGithub(status, 'closed', 'open')).toBe('reopen');
  });
});
