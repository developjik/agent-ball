/**
 * Domain types for the agent-ball turn-taking protocol.
 *
 * The ball is the single right to work on an issue. Exactly one owner holds it
 * at any time: an agent, a human, or nobody (unassigned). A blocked state is a
 * parked ball: it still belongs to the issue, but nobody may work until it is
 * resolved.
 */

/** Whose turn it is, ignoring the parked (blocked) case. */
export type BallOwner =
  | { readonly phase: 'unassigned' }
  | { readonly phase: 'agent'; readonly agent: string }
  | { readonly phase: 'human' };

/** A blocked ball, parked with the reason and the owner it was taken from. */
export interface BlockedState {
  readonly phase: 'blocked';
  readonly reason: string;
  readonly since: string;
  readonly blockedFrom: BallOwner;
}

/** The full turn state of one issue. */
export type TurnState = BallOwner | BlockedState;

export type CheckStatus = 'success' | 'failure' | 'pending' | 'neutral' | 'skipped';

export interface CheckRef {
  readonly name: string;
  readonly status: CheckStatus;
  readonly url?: string;
}

/** Evidence an agent hands over so the next owner does not have to go looking. */
export interface Artifacts {
  readonly prs: string[];
  readonly branches: string[];
  readonly checks: CheckRef[];
  readonly files: string[];
}

export const EMPTY_ARTIFACTS: Artifacts = { prs: [], branches: [], checks: [], files: [] };

/** A handoff of the ball from one owner to another. */
export interface HandoffRecord {
  readonly type: 'handoff';
  readonly id: string;
  readonly issue: number;
  readonly at: string;
  readonly from: string;
  readonly to: string;
  readonly summary: string;
  readonly artifacts: Artifacts;
  readonly needsHumanDecision: string | null;
}

/** An agent picking up a ball nobody held. */
export interface ClaimRecord {
  readonly type: 'claim';
  readonly id: string;
  readonly issue: number;
  readonly at: string;
  readonly agent: string;
  readonly summary: string | null;
}

/** A ball parked because progress needs something that is missing. */
export interface BlockRecord {
  readonly type: 'block';
  readonly id: string;
  readonly issue: number;
  readonly at: string;
  readonly actor: string;
  readonly reason: string;
}

/** A parked ball put back in play. */
export interface ResolveRecord {
  readonly type: 'resolve';
  readonly id: string;
  readonly issue: number;
  readonly at: string;
  readonly actor: string;
  readonly to: string;
  readonly note: string | null;
}

export type TurnRecord = HandoffRecord | ClaimRecord | BlockRecord | ResolveRecord;

/** A parsed record plus the comment it came from, for linking back to GitHub. */
export interface StoredRecord {
  readonly record: TurnRecord;
  readonly commentId: string;
  readonly commentUrl: string | null;
}

/** The events the state machine validates. `actor` names the current holder. */
export type TurnEvent =
  | { readonly type: 'claim'; readonly agent: string; readonly at: string }
  | { readonly type: 'handoff'; readonly actor: string; readonly to: string; readonly at: string }
  | { readonly type: 'block'; readonly actor: string; readonly reason: string; readonly at: string }
  | { readonly type: 'resolve'; readonly actor: string; readonly to: string; readonly at: string };
