import { randomUUID } from 'node:crypto';
import type { AdapterComment, IssueAdapter, IssueQuery } from './adapter';
import { buildBoard, type Board } from './board';
import type { AgentBallErrorCode } from './errors';
import { acquireLock, releaseLock, type LockRecord } from './lock';
import { ballLabelDiff, labelsForState, ownerName } from './labels';
import { formatRecord } from './records';
import { buildSnapshot, type IssueSnapshot } from './snapshot';
import { applyEvent, sameOwner } from './state-machine';
import type { Artifacts, TurnEvent, TurnRecord, TurnState } from './types';

export interface EngineOptions {
  readonly adapter: IssueAdapter;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly lockTtlMs?: number;
  /** Turn off only for adapters that serialize writes themselves (tests). */
  readonly locking?: boolean;
}

export interface StepResult {
  readonly step: 'lock' | 'labels' | 'comment' | 'release';
  readonly ok: boolean;
  readonly detail?: string;
}

export type TurnOutcome =
  | {
      readonly ok: true;
      readonly issue: number;
      readonly state: TurnState;
      readonly record: TurnRecord;
      readonly commentUrl: string | null;
      readonly steps: StepResult[];
    }
  | {
      readonly ok: false;
      readonly code: AgentBallErrorCode;
      readonly message: string;
      readonly steps: StepResult[];
      readonly holder: string | null;
      /** True when the labels moved but the comment did not. */
      readonly labelsApplied: boolean;
      readonly state?: TurnState;
    };

export interface ClaimInput {
  readonly issue: number;
  readonly agent: string;
  readonly summary?: string;
}

export interface HandoffInput {
  readonly issue: number;
  readonly from: string;
  readonly to: string;
  readonly summary: string;
  readonly artifacts?: Partial<Artifacts>;
  readonly needsHumanDecision?: string | null;
}

export interface BlockInput {
  readonly issue: number;
  readonly actor: string;
  readonly reason: string;
}

export interface ResolveInput {
  readonly issue: number;
  readonly actor: string;
  readonly to: string;
  readonly note?: string | null;
}

/**
 * The orchestrator. Every move follows the same shape: read, validate, take the
 * lease, re-read, write labels, post the record, release. Nothing moves on a
 * state that was not read twice, and a losing lease never touches the issue.
 */
export class AgentBallEngine {
  private readonly adapter: IssueAdapter;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly lockTtlMs: number;
  private readonly locking: boolean;

  constructor(options: EngineOptions) {
    this.adapter = options.adapter;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomUUID());
    this.lockTtlMs = options.lockTtlMs ?? 120_000;
    this.locking = options.locking ?? true;
  }

  get repo(): string | null {
    return this.adapter.repo;
  }

  get adapterName(): string {
    return this.adapter.name;
  }

  async read(issue: number): Promise<IssueSnapshot> {
    const [meta, comments] = await Promise.all([this.adapter.getIssue(issue), this.adapter.listComments(issue)]);
    return buildSnapshot(meta, comments);
  }

  async list(query: IssueQuery = {}): Promise<IssueSnapshot[]> {
    const issues = await this.adapter.listIssues({ state: query.state ?? 'open', limit: query.limit ?? 100 });
    return mapLimit(issues, 6, async (issue) => {
      const comments = await this.adapter.listComments(issue.number);
      return buildSnapshot(issue, comments);
    });
  }

  async board(options: { source?: 'github' | 'demo'; limit?: number } = {}): Promise<Board> {
    const snapshots = await this.list({ limit: options.limit ?? 100 });
    return buildBoard(snapshots, {
      source: options.source ?? 'github',
      repo: this.adapter.repo,
      now: this.now(),
    });
  }

  /** Issues this agent holds, plus unassigned work it may pick up. */
  async nextFor(
    agent: string,
    options: { limit?: number } = {},
  ): Promise<{ held: IssueSnapshot[]; claimable: IssueSnapshot[] }> {
    const snapshots = await this.list({ limit: options.limit ?? 100 });
    const held = snapshots
      .filter((snapshot) => snapshot.turn.phase === 'agent' && snapshot.turn.agent === agent)
      .sort(byUpdatedAsc);
    const claimable = snapshots
      .filter((snapshot) => snapshot.turn.phase === 'unassigned' && snapshot.conflict === null)
      .sort(byUpdatedAsc);
    return { held, claimable };
  }

  claim(input: ClaimInput): Promise<TurnOutcome> {
    return this.move({
      issue: input.issue,
      actor: input.agent,
      event: (at): TurnEvent => ({ type: 'claim', agent: input.agent, at }),
      record: (at, id): TurnRecord => ({
        type: 'claim',
        id,
        issue: input.issue,
        at,
        agent: input.agent,
        summary: input.summary?.trim() || null,
      }),
    });
  }

  handoff(input: HandoffInput): Promise<TurnOutcome> {
    const artifacts: Artifacts = {
      prs: input.artifacts?.prs ?? [],
      branches: input.artifacts?.branches ?? [],
      checks: input.artifacts?.checks ?? [],
      files: input.artifacts?.files ?? [],
    };
    return this.move({
      issue: input.issue,
      actor: input.from,
      event: (at): TurnEvent => ({ type: 'handoff', actor: input.from, to: input.to, at }),
      record: (at, id): TurnRecord => ({
        type: 'handoff',
        id,
        issue: input.issue,
        at,
        from: input.from,
        to: input.to,
        summary: input.summary,
        artifacts,
        needsHumanDecision: input.needsHumanDecision?.trim() || null,
      }),
    });
  }

  block(input: BlockInput): Promise<TurnOutcome> {
    const reason = input.reason.trim();
    return this.move({
      issue: input.issue,
      actor: input.actor,
      event: (at): TurnEvent => ({ type: 'block', actor: input.actor, reason, at }),
      record: (at, id): TurnRecord => ({
        type: 'block',
        id,
        issue: input.issue,
        at,
        actor: input.actor,
        reason,
      }),
    });
  }

  resolve(input: ResolveInput): Promise<TurnOutcome> {
    return this.move({
      issue: input.issue,
      actor: input.actor,
      event: (at): TurnEvent => ({ type: 'resolve', actor: input.actor, to: input.to, at }),
      record: (at, id): TurnRecord => ({
        type: 'resolve',
        id,
        issue: input.issue,
        at,
        actor: input.actor,
        to: input.to,
        note: input.note?.trim() || null,
      }),
    });
  }

  private async move(params: {
    issue: number;
    actor: string;
    event: (at: string) => TurnEvent;
    record: (at: string, id: string) => TurnRecord;
  }): Promise<TurnOutcome> {
    const steps: StepResult[] = [];
    const at = this.now().toISOString();

    let before: IssueSnapshot;
    try {
      before = await this.read(params.issue);
    } catch (error) {
      return failure(messageCodeOf(error), messageOf(error), steps);
    }

    if (before.conflict) {
      return failure(
        'label-conflict',
        `#${params.issue} carries conflicting ball labels (${before.conflict.join(', ')}); a human must fix the labels first`,
        steps,
      );
    }

    const pre = applyEvent(before.turn, params.event(at));
    if (!pre.ok) {
      return failure(pre.code, pre.message, steps, pre.holder ? ownerName(pre.holder) : null, before.turn);
    }
    if (!pre.changed) {
      return failure(
        'same-owner',
        `${params.actor} already holds the ball on #${params.issue}; nothing to do`,
        steps,
        params.actor,
        before.turn,
      );
    }

    let lease: LockRecord | null = null;
    if (this.locking) {
      let acquired;
      try {
        acquired = await acquireLock(this.adapter, {
          issue: params.issue,
          holder: params.actor,
          ttlMs: this.lockTtlMs,
          now: this.now(),
          nonce: this.newId(),
        });
      } catch (error) {
        return failure('adapter-error', messageOf(error), steps);
      }
      if (!acquired.ok) {
        steps.push({ step: 'lock', ok: false, detail: `held by ${acquired.heldBy}` });
        return failure(
          'lock-held',
          `#${params.issue} is leased by ${acquired.heldBy} until ${acquired.expiresAt}; retry after that`,
          steps,
          acquired.heldBy,
        );
      }
      lease = acquired.lease;
      steps.push({ step: 'lock', ok: true, detail: lease.commentId });
    }

    try {
      const current = await this.read(params.issue);
      if (!sameOwner(current.turn, before.turn) || !sameLabels(current.labels, before.labels)) {
        return failure(
          'state-changed',
          `#${params.issue} changed while the lease was being taken; re-read and retry`,
          steps,
          null,
          current.turn,
        );
      }

      const applied = applyEvent(current.turn, params.event(at));
      if (!applied.ok) {
        return failure(applied.code, applied.message, steps, applied.holder ? ownerName(applied.holder) : null, current.turn);
      }

      const diff = ballLabelDiff(current.labels, labelsForState(applied.state));
      try {
        await this.adapter.updateLabels(params.issue, diff);
        steps.push({
          step: 'labels',
          ok: true,
          detail: `add [${diff.add.join(', ')}] remove [${diff.remove.join(', ')}]`,
        });
      } catch (error) {
        return failure(messageCodeOf(error), messageOf(error), steps, null, current.turn);
      }

      const record = params.record(at, this.newId());
      let comment: AdapterComment;
      try {
        comment = await this.adapter.addComment(params.issue, formatRecord(record));
        steps.push({ step: 'comment', ok: true, ...(comment.url ? { detail: comment.url } : {}) });
      } catch (error) {
        return {
          ok: false,
          code: 'partial',
          message:
            `the ball moved to ${describeOwner(applied.state)} on #${params.issue}, but its comment could not be posted ` +
            `(${messageOf(error)}). Re-post the record or hand the ball back.`,
          steps,
          holder: null,
          labelsApplied: true,
          state: applied.state,
        };
      }

      return {
        ok: true,
        issue: params.issue,
        state: applied.state,
        record,
        commentUrl: comment.url,
        steps,
      };
    } catch (error) {
      return failure(messageCodeOf(error), messageOf(error), steps, null, null);
    } finally {
      if (lease) {
        await releaseLock(this.adapter, lease);
        steps.push({ step: 'release', ok: true });
      }
    }
  }
}

function failure(
  code: AgentBallErrorCode,
  message: string,
  steps: StepResult[],
  holder: string | null = null,
  state?: TurnState | null,
): TurnOutcome {
  return { ok: false, code, message, steps, holder, labelsApplied: false, ...(state ? { state } : {}) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function messageCodeOf(error: unknown): AgentBallErrorCode {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code !== 'partial') return code as AgentBallErrorCode;
  return 'adapter-error';
}

function describeOwner(state: TurnState): string {
  if (state.phase === 'blocked') return 'blocked';
  return ownerName(state);
}

function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((label, index) => label === right[index]);
}

function byUpdatedAsc(a: IssueSnapshot, b: IssueSnapshot): number {
  return Date.parse(a.updatedAt || '0') - Date.parse(b.updatedAt || '0');
}

async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await run(item);
    }
  });
  await Promise.all(workers);
  return results;
}
