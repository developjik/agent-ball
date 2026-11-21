import type { AdapterComment, AdapterIssue } from './adapter';
import { ownerFromLabels } from './labels';
import { parseRecords, type ParseProblem } from './records';
import { deriveTurnState } from './state-machine';
import type { StoredRecord, TurnState } from './types';

export interface IssueSnapshot {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: 'open' | 'closed';
  readonly labels: string[];
  readonly author: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly turn: TurnState;
  readonly records: StoredRecord[];
  readonly problems: ParseProblem[];
  readonly conflict: string[] | null;
  readonly drift: boolean;
}

const LOCK_MARKER = 'agent-ball:lock';

/** Builds the turn view of one issue from its labels and comment timeline. */
export function buildSnapshot(issue: AdapterIssue, comments: readonly AdapterComment[]): IssueSnapshot {
  const problems: ParseProblem[] = [];
  const stored: StoredRecord[] = [];

  const ordered = [...comments].sort(compareComments);
  for (const comment of ordered) {
    if (comment.body.includes(LOCK_MARKER)) continue;
    const parsed = parseRecords(comment.body);
    problems.push(...parsed.problems);
    for (const record of parsed.records) {
      stored.push({ record, commentId: comment.id, commentUrl: comment.url });
    }
  }

  const derived = deriveTurnState(ownerFromLabels(issue.labels), stored);
  return {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    state: issue.state,
    labels: [...issue.labels],
    author: issue.author,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    turn: derived.state,
    records: stored,
    problems,
    conflict: derived.conflict,
    drift: derived.drift,
  };
}

function compareComments(a: AdapterComment, b: AdapterComment): number {
  const byTime = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (byTime !== 0) return byTime;
  const ida = Number.parseInt(a.id, 10);
  const idb = Number.parseInt(b.id, 10);
  if (Number.isNaN(ida) || Number.isNaN(idb)) return a.id.localeCompare(b.id);
  return ida - idb;
}

export function lastRecordAt(snapshot: IssueSnapshot): string | null {
  return snapshot.records.at(-1)?.record.at ?? null;
}
