import type { Board, DashboardIssue } from '../core/board';
import { groupBoard } from '../core/board';
import type { TurnOutcome } from '../core/engine';
import type { TurnState } from '../core/types';

const ELLIPSIS = '…';

export function truncate(text: string, width: number): string {
  if (width <= 1) return ELLIPSIS;
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(1, width - 1)).trimEnd()}${ELLIPSIS}`;
}

/** Compact age: "now", "12m", "3h", "2d". */
export function relativeTime(iso: string | null, now: Date): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function shortOwner(name: string | null | undefined): string {
  if (!name) return 'nobody';
  return name === 'human' ? 'you' : name;
}

export interface BoardFormatOptions {
  readonly width?: number;
  readonly now?: Date;
}

/** The terminal rendering of `agent-ball status`. */
export function formatBoard(board: Board, options: BoardFormatOptions = {}): string {
  const width = options.width ?? 80;
  const now = options.now ?? new Date(board.generatedAt);
  const groups = groupBoard(board);
  const lines: string[] = [];

  const title = `agent-ball · ${board.repo ?? 'local'}`;
  const stats =
    `${board.counts.total} open · ${board.counts.human} need you · ` +
    `${board.counts.agent} with agents · ${board.counts.blocked} blocked`;
  lines.push(truncate(title, width));
  lines.push(truncate(stats, width));
  if (board.source === 'demo') lines.push('source: demo data (no repo reads)');

  const section = (name: string, count: number, rows: string[]): void => {
    if (count === 0 && name !== 'NEEDS YOUR DECISION') return;
    lines.push('');
    lines.push(`${name} (${count})`);
    if (rows.length === 0) lines.push('  —');
    else lines.push(...rows);
  };

  section('NEEDS YOUR DECISION', board.counts.human, groups.human.map((issue) => humanRow(issue, now, width)));

  const agentRows: string[] = [];
  for (const lane of groups.agents) {
    for (const issue of lane.issues) agentRows.push(agentRow(issue, lane.agent, now, width));
  }
  section('AGENT WORKING', board.counts.agent, agentRows);

  section('BLOCKED', board.counts.blocked, groups.blocked.map((issue) => blockedRow(issue, now, width)));
  section('UNASSIGNED', board.counts.unassigned, groups.unassigned.map((issue) => unassignedRow(issue, now, width)));

  return lines.join('\n');
}

function humanRow(issue: DashboardIssue, now: Date, width: number): string {
  const who = lastHandoffFrom(issue);
  const age = relativeTime(issue.lastActivityAt ?? issue.updatedAt, now);
  const lead = `  #${issue.number}`;
  const title = truncate(issue.title, Math.max(20, width - lead.length - 2));
  const meta = `      ${who ? `${who} → you` : 'waiting on you'}${age ? ` · ${age}` : ''}`;
  const rows = [`${lead}  ${title}`, meta];
  const question = issue.needsHumanDecision ?? issue.blockedReason;
  if (question) rows.push(`      “${truncate(question, Math.max(20, width - 8))}”`);
  return rows.join('\n');
}

function agentRow(issue: DashboardIssue, agent: string, now: Date, width: number): string {
  const age = relativeTime(issue.lastActivityAt ?? issue.updatedAt, now);
  const lead = `  ${agent.padEnd(8)} #${issue.number}`;
  const title = truncate(issue.title, Math.max(16, width - lead.length - age.length - 3));
  return `${lead}  ${title}${age ? `  ${age}` : ''}`;
}

function blockedRow(issue: DashboardIssue, now: Date, width: number): string {
  const age = relativeTime(issue.blockedSince ?? issue.updatedAt, now);
  const reason = issue.blockedReason ?? '';
  const head = `  #${issue.number}  ${truncate(issue.title, Math.max(20, width - 8))}`;
  const detail = `      ${age ? `${age} · ` : ''}${truncate(reason || 'no reason recorded', Math.max(16, width - 8))}`;
  return [head, detail].join('\n');
}

function unassignedRow(issue: DashboardIssue, now: Date, width: number): string {
  const age = relativeTime(issue.updatedAt, now);
  return `  #${issue.number}  ${truncate(issue.title, Math.max(20, width - 8))}${age ? `  ${age}` : ''}`;
}

function lastHandoffFrom(issue: DashboardIssue): string | null {
  const handoff = [...issue.timeline].reverse().find((entry) => entry.type === 'handoff');
  return handoff ? shortOwner(handoff.actor) : null;
}

/** The terminal rendering of a claim/handoff/block/resolve. */
export function formatOutcome(outcome: TurnOutcome): string {
  if (outcome.ok) {
    const lines = [`#${outcome.issue} → ${ownerLabel(outcome.state)}`];
    for (const step of outcome.steps) {
      lines.push(`  ${step.step.padEnd(8)}${step.detail ?? (step.ok ? 'ok' : 'failed')}`);
    }
    if (outcome.commentUrl) lines.push(`  record   ${outcome.commentUrl}`);
    return lines.join('\n');
  }
  const lines = [`rejected (${outcome.code}): ${outcome.message}`];
  if (outcome.holder) lines.push(`  holder   ${outcome.holder}`);
  for (const step of outcome.steps) {
    lines.push(`  ${step.step.padEnd(8)}${step.ok ? 'ok' : 'failed'}${step.detail ? ` · ${step.detail}` : ''}`);
  }
  if (outcome.labelsApplied) lines.push('  note     labels already moved; the issue state is ahead of its comment');
  return lines.join('\n');
}

export function ownerLabel(state: TurnState): string {
  switch (state.phase) {
    case 'human':
      return 'human';
    case 'agent':
      return state.agent;
    case 'blocked':
      return 'blocked';
    case 'unassigned':
      return 'unassigned';
  }
}
