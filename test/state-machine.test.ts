import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  ballLabelDiff,
  deriveTurnState,
  labelsForState,
  ownerFromLabels,
  sameOwner,
} from '../src/core';
import type { BallOwner, StoredRecord, TurnEvent, TurnRecord, TurnState } from '../src/core';

const AT = '2026-11-21T10:00:00.000Z';
const agent = (name: string): BallOwner => ({ phase: 'agent', agent: name });
const human: BallOwner = { phase: 'human' };
const unassigned: BallOwner = { phase: 'unassigned' };

function event(value: TurnEvent): TurnEvent {
  return value;
}

describe('applyEvent — claim', () => {
  it('gives an unassigned ball to the claiming agent', () => {
    const result = applyEvent(unassigned, event({ type: 'claim', agent: 'devin', at: AT }));
    expect(result).toEqual({ ok: true, state: agent('devin'), changed: true });
  });

  it('is idempotent for the agent that already holds it', () => {
    const result = applyEvent(agent('devin'), event({ type: 'claim', agent: 'devin', at: AT }));
    expect(result).toEqual({ ok: true, state: agent('devin'), changed: false });
  });

  it('rejects a second agent, naming the holder', () => {
    const result = applyEvent(agent('devin'), event({ type: 'claim', agent: 'codex', at: AT }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('agent-held');
    expect(result.holder).toEqual(agent('devin'));
    expect(result.message).toContain('devin');
  });

  it('rejects a claim while a human holds the ball', () => {
    const result = applyEvent(human, event({ type: 'claim', agent: 'devin', at: AT }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('human-held');
  });

  it('rejects a claim on a blocked ball', () => {
    const blocked: TurnState = { phase: 'blocked', reason: 'needs a secret', since: AT, blockedFrom: human };
    const result = applyEvent(blocked, event({ type: 'claim', agent: 'devin', at: AT }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('blocked');
  });

  it.each(['', 'Human', 'blocked', 'de vin', 'devin!', 'a'.repeat(40)])(
    'rejects the invalid agent name %j',
    (name) => {
      const result = applyEvent(unassigned, event({ type: 'claim', agent: name, at: AT }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('invalid-agent');
    },
  );
});

describe('applyEvent — handoff', () => {
  it('moves the ball from an agent to a human', () => {
    const result = applyEvent(agent('devin'), event({ type: 'handoff', actor: 'devin', to: 'human', at: AT }));
    expect(result).toEqual({ ok: true, state: human, changed: true });
  });

  it('moves the ball between agents', () => {
    const result = applyEvent(agent('devin'), event({ type: 'handoff', actor: 'devin', to: 'codex', at: AT }));
    expect(result).toEqual({ ok: true, state: agent('codex'), changed: true });
  });

  it('lets a human hand the ball back to an agent', () => {
    const result = applyEvent(human, event({ type: 'handoff', actor: 'human', to: 'codex', at: AT }));
    expect(result).toEqual({ ok: true, state: agent('codex'), changed: true });
  });

  it('refuses a handoff by an agent that does not hold the ball', () => {
    const result = applyEvent(agent('devin'), event({ type: 'handoff', actor: 'codex', to: 'human', at: AT }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not-holder');
      expect(result.holder).toEqual(agent('devin'));
    }
  });

  it('refuses handing the ball to its current holder', () => {
    const result = applyEvent(agent('devin'), event({ type: 'handoff', actor: 'devin', to: 'devin', at: AT }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('same-owner');
  });

  it('refuses a handoff on an unassigned issue', () => {
    const result = applyEvent(unassigned, event({ type: 'handoff', actor: 'devin', to: 'human', at: AT }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unassigned');
  });

  it('refuses a handoff on a blocked issue until it is resolved', () => {
    const blocked: TurnState = { phase: 'blocked', reason: 'needs a secret', since: AT, blockedFrom: agent('devin') };
    const result = applyEvent(blocked, event({ type: 'handoff', actor: 'devin', to: 'human', at: AT }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('blocked');
  });

  it.each(['robot arm', 'blocked', 'unassigned', 'Human', ''])('refuses the invalid target %j', (to) => {
    const result = applyEvent(agent('devin'), event({ type: 'handoff', actor: 'devin', to, at: AT }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid-target');
  });
});

describe('applyEvent — block and resolve', () => {
  it('parks the ball with a trimmed reason and remembers where it came from', () => {
    const result = applyEvent(agent('devin'), event({ type: 'block', actor: 'devin', reason: '  needs DATABASE_URL  ', at: AT }));
    expect(result).toEqual({
      ok: true,
      state: { phase: 'blocked', reason: 'needs DATABASE_URL', since: AT, blockedFrom: agent('devin') },
      changed: true,
    });
  });

  it('requires a real reason', () => {
    const result = applyEvent(agent('devin'), event({ type: 'block', actor: 'devin', reason: '  ', at: AT }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('reason-required');
  });

  it('refuses a block from someone who does not hold the ball', () => {
    const result = applyEvent(agent('devin'), event({ type: 'block', actor: 'codex', reason: 'stuck', at: AT }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not-holder');
  });

  it('refuses blocking an unassigned issue', () => {
    const result = applyEvent(unassigned, event({ type: 'block', actor: 'devin', reason: 'stuck', at: AT }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unassigned');
  });

  it('refuses blocking twice', () => {
    const blocked: TurnState = { phase: 'blocked', reason: 'stuck', since: AT, blockedFrom: human };
    const result = applyEvent(blocked, event({ type: 'block', actor: 'human', reason: 'again', at: AT }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('blocked');
  });

  it('resolves a blocked ball to an agent or a human', () => {
    const blocked: TurnState = { phase: 'blocked', reason: 'stuck', since: AT, blockedFrom: agent('devin') };
    expect(applyEvent(blocked, event({ type: 'resolve', actor: 'human', to: 'devin', at: AT }))).toEqual({
      ok: true,
      state: agent('devin'),
      changed: true,
    });
    expect(applyEvent(blocked, event({ type: 'resolve', actor: 'devin', to: 'human', at: AT }))).toEqual({
      ok: true,
      state: human,
      changed: true,
    });
  });

  it('refuses to resolve an unblocked issue', () => {
    const result = applyEvent(agent('devin'), event({ type: 'resolve', actor: 'human', to: 'devin', at: AT }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not-blocked');
  });

  it('needs an actor on resolve', () => {
    const blocked: TurnState = { phase: 'blocked', reason: 'stuck', since: AT, blockedFrom: human };
    const result = applyEvent(blocked, event({ type: 'resolve', actor: ' ', to: 'devin', at: AT }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid-actor');
  });
});

describe('labels', () => {
  it.each<TurnState>([unassigned, human, agent('devin'), agent('codex')])(
    'round-trips labels for %j',
    (state) => {
      const labels = labelsForState(state);
      const owner = ownerFromLabels([...labels, 'type:bug']);
      if (state.phase === 'agent') expect(owner).toEqual({ kind: 'agent', agent: state.agent });
      else expect(owner.kind).toBe(state.phase);
    },
  );

  it('reads an empty label set as unassigned', () => {
    expect(ownerFromLabels(['bug', 'p1'])).toEqual({ kind: 'unassigned' });
  });

  it('reports two ball labels as a conflict', () => {
    expect(ownerFromLabels(['ball:human', 'ball:agent:devin'])).toEqual({
      kind: 'conflict',
      labels: ['ball:human', 'ball:agent:devin'],
    });
  });

  it('reports an unknown ball label as a conflict', () => {
    expect(ownerFromLabels(['ball:review'])).toEqual({ kind: 'conflict', labels: ['ball:review'] });
    expect(ownerFromLabels(['ball:agent:Devin'])).toEqual({ kind: 'conflict', labels: ['ball:agent:Devin'] });
  });

  it('changes only ball labels', () => {
    const diff = ballLabelDiff(['bug', 'ball:agent:devin'], ['bug', 'ball:human']);
    expect(diff).toEqual({ add: ['ball:human'], remove: ['ball:agent:devin'] });
  });

  it('computes an empty diff for the same owner', () => {
    expect(ballLabelDiff(['ball:human', 'bug'], ['ball:human'])).toEqual({ add: [], remove: [] });
  });

  it('compares owners', () => {
    expect(sameOwner(agent('devin'), agent('devin'))).toBe(true);
    expect(sameOwner(agent('devin'), agent('codex'))).toBe(false);
    expect(sameOwner(human, human)).toBe(true);
    expect(sameOwner(human, unassigned)).toBe(false);
  });
});

describe('deriveTurnState', () => {
  function stored(...records: TurnRecord[]): StoredRecord[] {
    return records.map((record, index) => ({ record, commentId: String(index + 1), commentUrl: null }));
  }

  const handoff: TurnRecord = {
    type: 'handoff',
    id: 'r1',
    issue: 1,
    at: AT,
    from: 'devin',
    to: 'human',
    summary: 'done',
    artifacts: { prs: [], branches: [], checks: [], files: [] },
    needsHumanDecision: null,
  };

  it('takes the blocked reason from the latest block record', () => {
    const derived = deriveTurnState(
      { kind: 'blocked' },
      stored(
        { type: 'claim', id: 'c', issue: 1, at: AT, agent: 'devin', summary: null },
        { type: 'block', id: 'b', issue: 1, at: AT, actor: 'devin', reason: 'needs a secret' },
      ),
    );
    expect(derived.state).toEqual({
      phase: 'blocked',
      reason: 'needs a secret',
      since: AT,
      blockedFrom: { phase: 'agent', agent: 'devin' },
    });
    expect(derived.drift).toBe(false);
  });

  it('flags labels that disagree with the timeline', () => {
    const derived = deriveTurnState({ kind: 'agent', agent: 'codex' }, stored(handoff));
    expect(derived.drift).toBe(true);
    expect(derived.state).toEqual({ phase: 'agent', agent: 'codex' });
  });

  it('surfaces a conflict as a blocked state', () => {
    const derived = deriveTurnState({ kind: 'conflict', labels: ['ball:human', 'ball:agent:devin'] }, stored(handoff));
    expect(derived.conflict).toEqual(['ball:human', 'ball:agent:devin']);
    expect(derived.state.phase).toBe('blocked');
  });

  it('does not flag an issue with no records', () => {
    expect(deriveTurnState({ kind: 'human' }, []).drift).toBe(false);
  });
});
