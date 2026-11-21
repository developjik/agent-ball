import { describe, expect, it } from 'vitest';
import { AgentBallEngine, MockAdapter, formatRecord, groupBoard } from '../src/core';
import type { HandoffRecord, MockIssueSeed, TurnRecord } from '../src/core';

const NOW = new Date('2026-11-21T10:00:00.000Z');

function claimRecord(issue: number, agent: string): TurnRecord {
  return { type: 'claim', id: `c-${issue}`, issue, at: NOW.toISOString(), agent, summary: null };
}

function setup(seed: MockIssueSeed[] = []) {
  const adapter = new MockAdapter({ repo: 'o/r', now: NOW, seed });
  let counter = 0;
  const engine = new AgentBallEngine({
    adapter,
    now: () => NOW,
    newId: () => `id-${++counter}`,
  });
  return { adapter, engine };
}

describe('claim', () => {
  it('picks up an unassigned ball and records it', async () => {
    const { adapter, engine } = setup([{ number: 1, title: 'one' }]);
    const outcome = await engine.claim({ issue: 1, agent: 'devin', summary: 'on it' });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state).toEqual({ phase: 'agent', agent: 'devin' });
    expect(outcome.steps.map((step) => `${step.step}:${step.ok}`)).toEqual([
      'lock:true',
      'labels:true',
      'comment:true',
      'release:true',
    ]);
    expect(adapter.issueLabels(1)).toEqual(['ball:agent:devin']);
    // The lease is gone; the only comment left is the claim record.
    const comments = adapter.allComments(1);
    expect(comments).toHaveLength(1);
    expect(outcome.commentUrl).toBe(comments[0]?.url);

    const snapshot = await engine.read(1);
    expect(snapshot.turn).toEqual({ phase: 'agent', agent: 'devin' });
    expect(snapshot.records[0]?.record).toMatchObject({ type: 'claim', agent: 'devin', summary: 'on it' });
    expect(snapshot.conflict).toBeNull();
  });

  it('rejects a second agent without touching the issue', async () => {
    const { adapter, engine } = setup([
      { number: 1, labels: ['ball:agent:devin'], comments: [formatRecord(claimRecord(1, 'devin'))] },
    ]);
    const outcome = await engine.claim({ issue: 1, agent: 'codex' });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('agent-held');
    expect(outcome.holder).toBe('devin');
    expect(adapter.issueLabels(1)).toEqual(['ball:agent:devin']);
    expect(adapter.allComments(1)).toHaveLength(1);
    expect(adapter.calls.some((call) => call.op === 'updateLabels')).toBe(false);
  });

  it('refuses to re-claim a ball it already holds', async () => {
    const { adapter, engine } = setup([
      { number: 1, labels: ['ball:agent:devin'], comments: [formatRecord(claimRecord(1, 'devin'))] },
    ]);
    const outcome = await engine.claim({ issue: 1, agent: 'devin', summary: 'again' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('same-owner');
    expect(adapter.allComments(1)).toHaveLength(1);
  });

  it('reports a missing issue as not-found', async () => {
    const { engine } = setup([]);
    const outcome = await engine.claim({ issue: 404, agent: 'devin' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('not-found');
  });

  it('stops when another agent holds the lease', async () => {
    const { adapter, engine } = setup([{ number: 1 }]);
    adapter.injectComment(
      1,
      `<!-- agent-ball:lock v1\n${JSON.stringify({
        nonce: 'rival',
        holder: 'blob',
        issue: 1,
        createdAt: new Date(NOW.getTime() - 1000).toISOString(),
        expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      })}\n-->`,
      'blob',
    );
    const outcome = await engine.claim({ issue: 1, agent: 'devin' });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('lock-held');
      expect(outcome.holder).toBe('blob');
    }
    expect(adapter.issueLabels(1)).toEqual([]);
  });

  it('refuses an issue with conflicting ball labels', async () => {
    const { adapter, engine } = setup([{ number: 1, labels: ['ball:human', 'ball:agent:devin'] }]);
    const outcome = await engine.claim({ issue: 1, agent: 'codex' });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('label-conflict');
    expect(adapter.issueLabels(1)).toEqual(['ball:human', 'ball:agent:devin']);
    expect(adapter.calls.some((call) => call.op === 'updateLabels')).toBe(false);
  });

  it('works without the lease when locking is off', async () => {
    const adapter = new MockAdapter({ repo: 'o/r', now: NOW, seed: [{ number: 1 }] });
    const engine = new AgentBallEngine({ adapter, now: () => NOW, locking: false, newId: () => 'id' });
    const outcome = await engine.claim({ issue: 1, agent: 'devin' });
    expect(outcome.ok).toBe(true);
    expect(adapter.allComments(1)).toHaveLength(1);
  });
});

describe('handoff', () => {
  it('moves an agent-held ball to a human with evidence', async () => {
    const { adapter, engine } = setup([
      { number: 2, title: 'two', labels: ['ball:agent:devin'], comments: [formatRecord(claimRecord(2, 'devin'))] },
    ]);

    const outcome = await engine.handoff({
      issue: 2,
      from: 'devin',
      to: 'human',
      summary: 'Adapter retries fixed.',
      artifacts: {
        prs: ['https://github.com/o/r/pull/4'],
        branches: ['fix/retries'],
        checks: [{ name: 'ci', status: 'success' }],
        files: ['src/core/engine.ts'],
      },
      needsHumanDecision: 'Ship behind a flag?',
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state).toEqual({ phase: 'human' });
    expect(adapter.issueLabels(2)).toEqual(['ball:human']);

    const snapshot = await engine.read(2);
    const last = snapshot.records.at(-1)?.record;
    expect(last).toMatchObject({
      type: 'handoff',
      from: 'devin',
      to: 'human',
      summary: 'Adapter retries fixed.',
      needsHumanDecision: 'Ship behind a flag?',
    });
    const record = last as HandoffRecord;
    expect(record.artifacts.checks).toEqual([{ name: 'ci', status: 'success' }]);
    expect(snapshot.turn.phase).toBe('human');
  });

  it('rejects a handoff by an agent that does not hold the ball', async () => {
    const { adapter, engine } = setup([
      { number: 2, labels: ['ball:agent:devin'], comments: [formatRecord(claimRecord(2, 'devin'))] },
    ]);
    const outcome = await engine.handoff({ issue: 2, from: 'codex', to: 'human', summary: 'mine now' });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('not-holder');
    expect(adapter.issueLabels(2)).toEqual(['ball:agent:devin']);
    expect(adapter.allComments(2)).toHaveLength(1);
  });

  it('refuses a handoff that raced with another writer', async () => {
    const { adapter, engine } = setup([{ number: 3, labels: ['ball:agent:devin'] }]);
    adapter.hooks.beforeGetIssue = (issue, call) => {
      // The locked re-read sees the ball already taken by someone else.
      if (call === 2) adapter.forceLabels(issue, ['ball:agent:codex']);
    };

    const outcome = await engine.handoff({ issue: 3, from: 'devin', to: 'human', summary: 'done' });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('state-changed');
    expect(adapter.issueLabels(3)).toEqual(['ball:agent:codex']);
    expect(adapter.calls.some((call) => call.op === 'addComment' && String((call.args as { body: string }).body).includes('Handoff'))).toBe(false);
  });

  it('reports a partial write when the labels moved but the comment did not', async () => {
    const { adapter, engine } = setup([{ number: 4, labels: ['ball:agent:devin'] }]);
    let listings = 0;
    adapter.hooks.beforeListComments = () => {
      listings += 1;
      // Let the lease be written, then fail the record comment.
      if (listings === 2) adapter.failNext = { op: 'addComment' };
    };

    const outcome = await engine.handoff({ issue: 4, from: 'devin', to: 'human', summary: 'done' });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('partial');
    expect(outcome.labelsApplied).toBe(true);
    expect(outcome.state).toEqual({ phase: 'human' });
    expect(outcome.message).toContain('the ball moved to human');
    expect(adapter.issueLabels(4)).toEqual(['ball:human']);
    // Only the lease is gone; no record comment landed.
    expect(adapter.allComments(4)).toHaveLength(0);
  });
});

describe('block and resolve', () => {
  it('parks a ball and puts it back', async () => {
    const { adapter, engine } = setup([
      { number: 5, labels: ['ball:agent:blob'], comments: [formatRecord(claimRecord(5, 'blob'))] },
    ]);

    const blocked = await engine.block({ issue: 5, actor: 'blob', reason: ' needs DATABASE_URL ' });
    expect(blocked.ok).toBe(true);
    expect(adapter.issueLabels(5)).toEqual(['ball:blocked']);

    let snapshot = await engine.read(5);
    expect(snapshot.turn).toMatchObject({ phase: 'blocked', reason: 'needs DATABASE_URL' });

    const resolved = await engine.resolve({ issue: 5, actor: 'human', to: 'blob', note: 'secret added' });
    expect(resolved.ok).toBe(true);
    expect(adapter.issueLabels(5)).toEqual(['ball:agent:blob']);

    snapshot = await engine.read(5);
    expect(snapshot.turn).toEqual({ phase: 'agent', agent: 'blob' });
    expect(snapshot.records.map((entry) => entry.record.type)).toEqual(['claim', 'block', 'resolve']);
  });

  it('rejects resolving an issue that is not blocked', async () => {
    const { engine } = setup([{ number: 6, labels: ['ball:human'] }]);
    const outcome = await engine.resolve({ issue: 6, actor: 'human', to: 'devin' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('not-blocked');
  });
});

describe('list, next and board', () => {
  function seeded() {
    return setup([
      { number: 1, title: 'held by devin', labels: ['ball:agent:devin'] },
      { number: 2, title: 'free work' },
      { number: 3, title: 'held by codex', labels: ['ball:agent:codex'] },
      { number: 4, title: 'needs a human', labels: ['ball:human'] },
      { number: 5, title: 'closed one', state: 'closed' },
      { number: 6, title: 'parked', labels: ['ball:blocked'] },
    ]);
  }

  it('splits held and claimable work for an agent', async () => {
    const { engine } = seeded();
    const result = await engine.nextFor('devin');
    expect(result.held.map((snapshot) => snapshot.number)).toEqual([1]);
    expect(result.claimable.map((snapshot) => snapshot.number)).toEqual([2]);
  });

  it('builds a board with one row per open issue', async () => {
    const { engine } = seeded();
    const board = await engine.board({ source: 'demo' });
    expect(board.counts).toEqual({ human: 1, agent: 2, blocked: 1, unassigned: 1, total: 5 });
    expect(board.source).toBe('demo');
    expect(board.repo).toBe('o/r');
    expect(board.issues[0]?.column).toBe('human');
  });

  it('groups agent lanes by owner', async () => {
    const { engine } = seeded();
    const groups = groupBoard(await engine.board());
    expect(groups.agents.map((lane) => lane.agent).sort()).toEqual(['codex', 'devin']);
    expect(groups.unassigned.map((issue) => issue.number)).toEqual([2]);
  });

  it('carries the last question and artifacts into the dashboard row', async () => {
    const handoff: TurnRecord = {
      type: 'handoff',
      id: 'h',
      issue: 7,
      at: NOW.toISOString(),
      from: 'devin',
      to: 'human',
      summary: 'done',
      artifacts: { prs: ['https://github.com/o/r/pull/9'], branches: [], checks: [{ name: 'ci', status: 'success' }], files: [] },
      needsHumanDecision: 'Go?',
    };
    const adapter = new MockAdapter({
      repo: 'o/r',
      now: NOW,
      seed: [{ number: 7, labels: ['ball:human'], comments: [formatRecord(handoff)] }],
    });
    const engine2 = new AgentBallEngine({ adapter, now: () => NOW });
    const board = await engine2.board();
    const row = board.issues.find((issue) => issue.number === 7);
    expect(row?.needsHumanDecision).toBe('Go?');
    expect(row?.checkSummary).toEqual({ success: 1, failure: 0, pending: 0 });
    expect(row?.timeline.at(-1)?.artifacts?.prs).toEqual(['https://github.com/o/r/pull/9']);
  });

  it('flags an unreadable record without losing the rest of the thread', async () => {
    const { engine } = setup([
      {
        number: 8,
        labels: ['ball:human'],
        comments: ['broken: <!-- agent-ball:v1\n{ nope }\n-->', formatRecord(claimRecord(8, 'devin'))],
      },
    ]);
    const board = await engine.board();
    const row = board.issues.find((issue) => issue.number === 8);
    expect(row?.problems).toHaveLength(1);
    expect(row?.timeline).toHaveLength(1);
  });
});
