import { isAgentName, isOwnerName, ownerName, type LabelOwner } from './labels';
import type { AgentBallErrorCode } from './errors';
import type { BallOwner, StoredRecord, TurnEvent, TurnRecord, TurnState } from './types';

export type TransitionOutcome =
  | { readonly ok: true; readonly state: TurnState; readonly changed: boolean }
  | {
      readonly ok: false;
      readonly code: AgentBallErrorCode;
      readonly message: string;
      readonly holder: TurnState | null;
    };

function ok(state: TurnState, changed: boolean): TransitionOutcome {
  return { ok: true, state, changed };
}

function fail(
  code: AgentBallErrorCode,
  message: string,
  holder: TurnState | null = null,
): TransitionOutcome {
  return { ok: false, code, message, holder };
}

function isLive(state: TurnState): state is BallOwner {
  return state.phase !== 'blocked';
}

/** Two states hold the ball in the same place (used to detect a mid-flight change). */
export function sameOwner(a: TurnState, b: TurnState): boolean {
  if (a.phase === 'agent' && b.phase === 'agent') return a.agent === b.agent;
  return a.phase === b.phase;
}

/**
 * Validates one event against the current state and returns the next state.
 * Pure: the same call always yields the same result, so it is the single source
 * of truth for legal turn-taking.
 */
export function applyEvent(state: TurnState, event: TurnEvent): TransitionOutcome {
  switch (event.type) {
    case 'claim':
      return claim(state, event.agent);
    case 'handoff':
      return handoff(state, event.actor, event.to);
    case 'block':
      return block(state, event.actor, event.reason, event.at);
    case 'resolve':
      return resolve(state, event.actor, event.to);
  }
}

function claim(state: TurnState, agent: string): TransitionOutcome {
  if (!isAgentName(agent)) {
    return fail('invalid-agent', `"${agent}" is not a valid agent name`);
  }
  switch (state.phase) {
    case 'unassigned':
      return ok({ phase: 'agent', agent }, true);
    case 'agent':
      return state.agent === agent
        ? ok(state, false)
        : fail('agent-held', `the ball is held by agent "${state.agent}"`, state);
    case 'human':
      return fail('human-held', 'the ball is with a human; wait for a handoff', state);
    case 'blocked':
      return fail('blocked', `the ball is blocked: ${state.reason || 'no reason given'}`, state);
  }
}

function handoff(state: TurnState, actor: string, to: string): TransitionOutcome {
  if (!isOwnerName(to)) {
    return fail('invalid-target', `"${to}" is not a valid handoff target (use "human" or an agent name)`);
  }
  if (state.phase === 'unassigned') {
    return fail('unassigned', 'the ball is unassigned: claim it, then hand it off', state);
  }
  if (!isLive(state)) {
    return fail('blocked', `the ball is blocked (${state.reason || 'no reason given'}); resolve it first`, state);
  }
  const holder = ownerName(state);
  if (actor !== holder) {
    return fail(
      'not-holder',
      `the ball is held by "${holder}", not "${actor}"; refusing a handoff that would collide`,
      state,
    );
  }
  if (to === holder) {
    return fail('same-owner', `"${holder}" already holds the ball`);
  }
  return ok(to === 'human' ? { phase: 'human' } : { phase: 'agent', agent: to }, true);
}

function block(state: TurnState, actor: string, reason: string, at: string): TransitionOutcome {
  if (!isLive(state)) {
    return fail('blocked', 'the ball is already blocked', state);
  }
  if (state.phase === 'unassigned') {
    return fail('unassigned', 'nothing holds the ball; claim it before blocking', state);
  }
  const holder = ownerName(state);
  if (actor !== holder) {
    return fail('not-holder', `the ball is held by "${holder}", not "${actor}"`, state);
  }
  const trimmed = reason.trim();
  if (trimmed.length < 3) {
    return fail('reason-required', 'a block needs a reason so the next owner can act on it');
  }
  return ok({ phase: 'blocked', reason: trimmed, since: at, blockedFrom: state }, true);
}

function resolve(state: TurnState, actor: string, to: string): TransitionOutcome {
  if (state.phase !== 'blocked') {
    return fail('not-blocked', 'this issue is not blocked; nothing to resolve', state);
  }
  if (actor.trim() === '') {
    return fail('invalid-actor', 'a resolve needs an actor so the timeline says who unblocked it');
  }
  if (!isOwnerName(to)) {
    return fail('invalid-target', `"${to}" is not a valid owner (use "human" or an agent name)`);
  }
  return ok(to === 'human' ? { phase: 'human' } : { phase: 'agent', agent: to }, true);
}

export interface DerivedTurn {
  readonly state: TurnState;
  readonly drift: boolean;
  readonly conflict: string[] | null;
}

/**
 * Rebuilds the turn state from labels (the authority) and the record timeline
 * (which supplies the reason a ball is blocked). `drift` marks a timeline whose
 * last move disagrees with the labels.
 */
export function deriveTurnState(owner: LabelOwner, stored: readonly StoredRecord[]): DerivedTurn {
  const records = stored.map((entry) => entry.record);

  if (owner.kind === 'conflict') {
    const since = records.at(-1)?.at ?? '';
    return {
      state: {
        phase: 'blocked',
        reason: `conflicting ball labels: ${owner.labels.join(', ')}`,
        since,
        blockedFrom: { phase: 'unassigned' },
      },
      drift: true,
      conflict: owner.labels,
    };
  }

  const lastOwner = lastRecordOwner(records);
  const expected = lastOwner === null ? null : lastOwner;

  switch (owner.kind) {
    case 'unassigned':
      return {
        state: { phase: 'unassigned' },
        drift: expected !== null,
        conflict: null,
      };
    case 'human':
      return { state: { phase: 'human' }, drift: expected !== null && expected !== 'human', conflict: null };
    case 'agent':
      return {
        state: { phase: 'agent', agent: owner.agent },
        drift: expected !== null && expected !== owner.agent,
        conflict: null,
      };
    case 'blocked': {
      const blockRecord = [...records].reverse().find((record) => record.type === 'block');
      const reason = blockRecord?.type === 'block' ? blockRecord.reason : '';
      const since = blockRecord?.at ?? '';
      const index = blockRecord ? records.lastIndexOf(blockRecord) : -1;
      const before = index > 0 ? records.slice(0, index) : [];
      const blockedFrom = ownerFromRecord(lastRecordInsert(before)) ?? { phase: 'unassigned' };
      return {
        state: { phase: 'blocked', reason, since, blockedFrom },
        drift: false,
        conflict: null,
      };
    }
  }
}

/** The owner a record hands the ball to. */
export function recordTarget(record: TurnRecord): string {
  switch (record.type) {
    case 'handoff':
      return record.to;
    case 'claim':
      return record.agent;
    case 'resolve':
      return record.to;
    case 'block':
      return 'blocked';
  }
}

function lastRecordOwner(records: readonly TurnRecord[]): string | null {
  const last = records.at(-1);
  if (!last) return null;
  if (last.type === 'block') return 'blocked';
  return recordTarget(last);
}

function lastRecordInsert(records: readonly TurnRecord[]): TurnRecord | null {
  const last = records.at(-1);
  if (!last || last.type === 'block') return null;
  return last;
}

function ownerFromRecord(record: TurnRecord | null): BallOwner | null {
  if (!record) return null;
  const target = recordTarget(record);
  if (target === 'human') return { phase: 'human' };
  if (target === 'blocked') return null;
  if (isAgentName(target)) return { phase: 'agent', agent: target };
  return null;
}
