import { describe, expect, it } from 'vitest';
import { buildBoard, demoBoard, formatRecord, groupBoard, toDashboardIssue } from '../src/core';
import type { AdapterComment, AdapterIssue, IssueSnapshot, TurnRecord } from '../src/core';
import { buildSnapshot } from '../src/core/snapshot';

const NOW = new Date('2026-11-21T10:00:00.000Z');

function issue(overrides: Partial<AdapterIssue> = {}): AdapterIssue {
  return {
    number: 1,
    title: 'One',
    url: 'https://example.test/1',
    state: 'open',
    labels: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    author: 'jungingwon4',
    ...overrides,
  };
}

function comment(id: string, body: string, createdAt: string): AdapterComment {
  return { id, body, author: 'devin', createdAt, url: `https://example.test/c/${id}` };
}

function handoff(issueNumber: number, at: string, id = `h-${issueNumber}`, summary = 'Done.'): TurnRecord {
  return {
    type: 'handoff',
    id,
    issue: issueNumber,
    at,
    from: 'devin',
    to: 'human',
    summary,
    artifacts: { prs: ['https://example.test/pr/1'], branches: [], checks: [{ name: 'ci', status: 'failure' }], files: [] },
    needsHumanDecision: 'Go?',
  };
}

describe('buildBoard', () => {
  it('keeps open issues and counts each column', () => {
    const board = buildBoard(
      [
        buildSnapshot(issue({ number: 1, labels: ['ball:human'] }), []),
        buildSnapshot(issue({ number: 2, labels: ['ball:agent:devin'] }), []),
        buildSnapshot(issue({ number: 3, labels: ['ball:blocked'] }), []),
        buildSnapshot(issue({ number: 4 }), []),
        buildSnapshot(issue({ number: 5, state: 'closed', labels: ['ball:human'] }), []),
      ],
      { source: 'github', repo: 'o/r', now: NOW },
    );

    expect(board.counts).toEqual({ human: 1, agent: 1, blocked: 1, unassigned: 1, total: 4 });
    expect(board.issues.map((row) => row.number).sort()).toEqual([1, 2, 3, 4]);
    expect(board.repo).toBe('o/r');
    expect(board.generatedAt).toBe(NOW.toISOString());
  });

  it('puts human decisions first', () => {
    const board = buildBoard(
      [
        buildSnapshot(issue({ number: 1, labels: ['ball:agent:devin'] }), []),
        buildSnapshot(issue({ number: 2, labels: ['ball:human'] }), []),
      ],
      { source: 'github', repo: null, now: NOW },
    );
    expect(board.issues[0]?.number).toBe(2);
  });

  it('maps a timeline, its artifacts and the last question', () => {
    const snapshot = buildSnapshot(
      issue({ number: 7, labels: ['ball:human'] }),
      [comment('1', 'hello', NOW.toISOString()), comment('2', formatRecord(handoff(7, NOW.toISOString())), NOW.toISOString())],
    );
    const row = toDashboardIssue(snapshot);

    expect(row.column).toBe('human');
    expect(row.needsHumanDecision).toBe('Go?');
    expect(row.timeline).toHaveLength(1);
    expect(row.timeline[0]).toMatchObject({ type: 'handoff', actor: 'devin', to: 'human', url: 'https://example.test/c/2' });
    expect(row.checkSummary).toEqual({ success: 0, failure: 1, pending: 0 });
    expect(row.lastActivityAt).toBe(NOW.toISOString());
  });

  it('marks a conflicting label set as blocked and flags it', () => {
    const row = toDashboardIssue(buildSnapshot(issue({ labels: ['ball:human', 'ball:agent:devin'] }), []));
    expect(row.column).toBe('blocked');
    expect(row.conflict).toEqual(['ball:human', 'ball:agent:devin']);
    expect(row.blockedReason).toContain('conflicting ball labels');
  });

  it('flags drift between labels and the timeline', () => {
    const snapshot = buildSnapshot(
      issue({ labels: ['ball:agent:codex'] }),
      [comment('1', formatRecord(handoff(1, NOW.toISOString())), NOW.toISOString())],
    );
    const row = toDashboardIssue(snapshot);
    expect(row.drift).toBe(true);
    expect(row.column).toBe('agent');
  });

  it('orders records by comment time, not by input order', () => {
    const earlier = handoff(1, new Date(NOW.getTime() - 3600_000).toISOString(), 'newer', 'newer');
    const older = handoff(1, new Date(NOW.getTime() - 7200_000).toISOString(), 'older', 'older');
    const snapshot: IssueSnapshot = buildSnapshot(issue({ labels: ['ball:human'] }), [
      comment('2', formatRecord(earlier), new Date(NOW.getTime() - 3600_000).toISOString()),
      comment('1', formatRecord(older), new Date(NOW.getTime() - 7200_000).toISOString()),
    ]);
    expect(snapshot.records.map((entry) => entry.record.id)).toEqual(['older', 'newer']);
  });
});

describe('groupBoard', () => {
  it('sorts agent lanes by workload', async () => {
    const board = await demoBoard(NOW);
    const groups = groupBoard(board);
    expect(groups.human.length).toBeGreaterThan(0);
    expect(groups.agents.map((lane) => lane.agent)).toEqual(['codex', 'devin']);
    expect(groups.blocked.some((row) => row.conflict !== null)).toBe(true);
    expect(groups.unassigned).toHaveLength(1);
  });

  it('keeps every issue in exactly one group', async () => {
    const board = await demoBoard(NOW);
    const groups = groupBoard(board);
    const grouped = [
      ...groups.human.map((row) => row.number),
      ...groups.agents.flatMap((lane) => lane.issues.map((row) => row.number)),
      ...groups.blocked.map((row) => row.number),
      ...groups.unassigned.map((row) => row.number),
    ];
    expect(grouped.sort((a, b) => a - b)).toEqual(board.issues.map((row) => row.number).sort((a, b) => a - b));
  });
});
