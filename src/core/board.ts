import type { IssueSnapshot } from './snapshot';
import type { Artifacts, CheckRef, StoredRecord, TurnState } from './types';

export type BoardColumn = 'human' | 'agent' | 'blocked' | 'unassigned';

export interface TimelineEntry {
  readonly id: string;
  readonly type: 'handoff' | 'claim' | 'block' | 'resolve';
  readonly at: string;
  readonly actor: string;
  readonly to: string | null;
  readonly summary: string | null;
  readonly reason: string | null;
  readonly note: string | null;
  readonly artifacts: Artifacts | null;
  readonly needsHumanDecision: string | null;
  readonly url: string | null;
}

export interface DashboardIssue {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly column: BoardColumn;
  readonly agent: string | null;
  readonly blockedReason: string | null;
  readonly blockedSince: string | null;
  readonly needsHumanDecision: string | null;
  readonly labels: string[];
  readonly updatedAt: string;
  readonly lastActivityAt: string | null;
  readonly drift: boolean;
  readonly conflict: string[] | null;
  readonly timeline: TimelineEntry[];
  readonly problems: string[];
  readonly checkSummary: { readonly success: number; readonly failure: number; readonly pending: number };
}

export interface BoardCounts {
  readonly human: number;
  readonly agent: number;
  readonly blocked: number;
  readonly unassigned: number;
  readonly total: number;
}

export interface Board {
  readonly generatedAt: string;
  readonly source: 'github' | 'demo';
  readonly repo: string | null;
  readonly issues: DashboardIssue[];
  readonly counts: BoardCounts;
}

export interface AgentQueue {
  readonly agent: string;
  readonly issues: DashboardIssue[];
}

export interface BoardGroups {
  readonly human: DashboardIssue[];
  readonly agents: AgentQueue[];
  readonly blocked: DashboardIssue[];
  readonly unassigned: DashboardIssue[];
}

export function buildBoard(
  snapshots: readonly IssueSnapshot[],
  options: { source: 'github' | 'demo'; repo: string | null; now?: Date },
): Board {
  const now = options.now ?? new Date();
  const issues = snapshots
    .filter((snapshot) => snapshot.state === 'open')
    .map(toDashboardIssue)
    .sort(compareDashboardIssues);

  const counts: BoardCounts = {
    human: issues.filter((issue) => issue.column === 'human').length,
    agent: issues.filter((issue) => issue.column === 'agent').length,
    blocked: issues.filter((issue) => issue.column === 'blocked').length,
    unassigned: issues.filter((issue) => issue.column === 'unassigned').length,
    total: issues.length,
  };

  return {
    generatedAt: now.toISOString(),
    source: options.source,
    repo: options.repo,
    issues,
    counts,
  };
}

function compareDashboardIssues(a: DashboardIssue, b: DashboardIssue): number {
  if (a.column === 'human' && b.column !== 'human') return -1;
  if (b.column === 'human' && a.column !== 'human') return 1;
  return Date.parse(b.updatedAt || '0') - Date.parse(a.updatedAt || '0');
}

export function toDashboardIssue(snapshot: IssueSnapshot): DashboardIssue {
  const timeline = snapshot.records.map(toTimelineEntry);
  const needsHumanDecision = [...timeline].reverse().find((entry) => entry.needsHumanDecision)?.needsHumanDecision ?? null;

  return {
    number: snapshot.number,
    title: snapshot.title,
    url: snapshot.url,
    column: columnOf(snapshot.turn, snapshot.conflict),
    agent: snapshot.turn.phase === 'agent' ? snapshot.turn.agent : null,
    blockedReason: snapshot.turn.phase === 'blocked' ? snapshot.turn.reason : null,
    blockedSince: snapshot.turn.phase === 'blocked' ? snapshot.turn.since || null : null,
    needsHumanDecision,
    labels: snapshot.labels,
    updatedAt: snapshot.updatedAt,
    lastActivityAt: timeline.at(-1)?.at ?? null,
    drift: snapshot.drift,
    conflict: snapshot.conflict,
    timeline,
    problems: snapshot.problems.map((problem) => problem.message),
    checkSummary: countChecks(timeline.flatMap((entry) => entry.artifacts?.checks ?? [])),
  };
}

function columnOf(turn: TurnState, conflict: string[] | null): BoardColumn {
  if (conflict) return 'blocked';
  switch (turn.phase) {
    case 'human':
      return 'human';
    case 'agent':
      return 'agent';
    case 'blocked':
      return 'blocked';
    case 'unassigned':
      return 'unassigned';
  }
}

function toTimelineEntry(stored: StoredRecord): TimelineEntry {
  const { record } = stored;
  const actor = record.type === 'claim' ? record.agent : record.type === 'handoff' ? record.from : record.actor;
  const to = record.type === 'claim' || record.type === 'block' ? null : record.to;
  return {
    id: record.id,
    type: record.type,
    at: record.at,
    actor,
    to,
    summary: record.type === 'handoff' || record.type === 'claim' ? record.summary : null,
    reason: record.type === 'block' ? record.reason : null,
    note: record.type === 'resolve' ? record.note : null,
    artifacts: record.type === 'handoff' ? record.artifacts : null,
    needsHumanDecision: record.type === 'handoff' ? record.needsHumanDecision : null,
    url: stored.commentUrl,
  };
}

function countChecks(checks: readonly CheckRef[]): DashboardIssue['checkSummary'] {
  let success = 0;
  let failure = 0;
  let pending = 0;
  for (const check of checks) {
    if (check.status === 'success') success += 1;
    else if (check.status === 'failure') failure += 1;
    else if (check.status === 'pending') pending += 1;
  }
  return { success, failure, pending };
}

/** Splits the board into the three columns plus the agent lanes. */
export function groupBoard(board: Board): BoardGroups {
  const agents = new Map<string, DashboardIssue[]>();
  for (const issue of board.issues) {
    if (issue.column === 'agent' && issue.agent) {
      const lane = agents.get(issue.agent) ?? [];
      lane.push(issue);
      agents.set(issue.agent, lane);
    }
  }
  return {
    human: board.issues.filter((issue) => issue.column === 'human'),
    agents: [...agents.entries()]
      .map(([agent, issues]) => ({ agent, issues }))
      .sort((a, b) => b.issues.length - a.issues.length || a.agent.localeCompare(b.agent)),
    blocked: board.issues.filter((issue) => issue.column === 'blocked'),
    unassigned: board.issues.filter((issue) => issue.column === 'unassigned'),
  };
}
