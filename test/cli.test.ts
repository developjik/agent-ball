import { describe, expect, it } from 'vitest';
import { MockAdapter, formatRecord, parseRecords } from '../src/core';
import type { MockIssueSeed, TurnRecord } from '../src/core';
import { runCli, type CliDeps } from '../src/cli/run';

const NOW = new Date('2026-11-21T10:00:00.000Z');

function handoffRecord(issue: number, to = 'human'): TurnRecord {
  return {
    type: 'handoff',
    id: `h-${issue}`,
    issue,
    at: NOW.toISOString(),
    from: 'devin',
    to,
    summary: 'Adapter retries fixed.',
    artifacts: { prs: [], branches: [], checks: [], files: [] },
    needsHumanDecision: 'Ship behind a flag?',
  };
}

function cli(seed: MockIssueSeed[]) {
  const adapter = new MockAdapter({ repo: 'o/r', now: NOW, seed });
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    adapter,
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    now: () => NOW,
    newId: () => 'fixed-id',
    webDir: null,
  };
  return { adapter, deps, out, err, text: () => [...out, ...err].join('\n') };
}

describe('agent-ball status', () => {
  it('prints one section per column', async () => {
    const { deps, out } = cli([
      { number: 12, title: 'A retried handoff posts the record twice', labels: ['ball:human'], comments: [formatRecord(handoffRecord(12))] },
      { number: 7, title: 'gh adapter: verify label writes', labels: ['ball:agent:devin'] },
      { number: 9, title: 'Integration suite cannot run', labels: ['ball:blocked'] },
      { number: 16, title: 'Add Codex to the roster' },
    ]);

    const code = await runCli(['status'], deps);
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('NEEDS YOUR DECISION (1)');
    expect(text).toContain('AGENT WORKING (1)');
    expect(text).toContain('BLOCKED (1)');
    expect(text).toContain('UNASSIGNED (1)');
    expect(text).toContain('devin → you');
    expect(text).toContain('“Ship behind a flag?”');
  });

  it('emits the board as JSON', async () => {
    const { deps, out } = cli([{ number: 1, title: 'one', labels: ['ball:human'] }]);
    const code = await runCli(['status', '--json'], deps);
    expect(code).toBe(0);
    const board = JSON.parse(out.join('\n')) as { counts: { human: number; total: number }; source: string };
    expect(board.counts).toMatchObject({ human: 1, total: 1 });
    expect(board.source).toBe('demo');
  });
});

describe('agent-ball next', () => {
  it('lists held and claimable work', async () => {
    const { deps, out } = cli([
      { number: 7, title: 'held one', labels: ['ball:agent:devin'] },
      { number: 8, title: 'free one' },
      { number: 9, title: 'someone else', labels: ['ball:agent:codex'] },
    ]);
    const code = await runCli(['next', '--agent', 'devin'], deps);
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('HELD BY DEVIN (1)');
    expect(text).toContain('#7  held one');
    expect(text).toContain('READY TO CLAIM (1)');
    expect(text).toContain('#8  free one');
    expect(text).not.toContain('#9');
  });

  it('says so when there is nothing to do', async () => {
    const { deps, out } = cli([{ number: 9, title: 'someone else', labels: ['ball:agent:codex'] }]);
    const code = await runCli(['next', '--agent', 'devin'], deps);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('nothing for devin');
  });

  it('rejects an invalid agent name', async () => {
    const { deps, err } = cli([]);
    expect(await runCli(['next', '--agent', 'Devin!'], deps)).toBe(2);
    expect(err.join('\n')).toContain('not a valid agent name');
  });
});

describe('agent-ball handoff', () => {
  it('infers the holder and moves the ball to a human', async () => {
    const { adapter, deps, out } = cli([{ number: 12, title: 'twelve', labels: ['ball:agent:devin'] }]);
    const code = await runCli(
      [
        'handoff',
        '--issue',
        '12',
        '--to',
        'human',
        '--summary',
        'Retries are fixed.',
        '--pr',
        'https://github.com/o/r/pull/4',
        '--check',
        'ci=success',
        '--needs-human',
        'Ship behind a flag?',
      ],
      deps,
    );

    expect(code).toBe(0);
    expect(out.join('\n')).toContain('#12 → human');
    expect(adapter.issueLabels(12)).toEqual(['ball:human']);

    const body = adapter.allComments(12).at(-1)?.body ?? '';
    const record = parseRecords(body).records[0];
    expect(record).toMatchObject({
      type: 'handoff',
      from: 'devin',
      to: 'human',
      needsHumanDecision: 'Ship behind a flag?',
    });
    if (record?.type === 'handoff') {
      expect(record.artifacts.prs).toEqual(['https://github.com/o/r/pull/4']);
      expect(record.artifacts.checks).toEqual([{ name: 'ci', status: 'success' }]);
    }
  });

  it('requires a summary', async () => {
    const { deps, err } = cli([{ number: 12, labels: ['ball:agent:devin'] }]);
    expect(await runCli(['handoff', '--issue', '12', '--to', 'human'], deps)).toBe(2);
    expect(err.join('\n')).toContain('--summary is required');
  });

  it('rejects an invalid target', async () => {
    const { deps, err } = cli([{ number: 12, labels: ['ball:agent:devin'] }]);
    expect(await runCli(['handoff', '--issue', '12', '--to', 'robot arm', '--summary', 'x'], deps)).toBe(2);
    expect(err.join('\n')).toContain('--to must be');
  });

  it('rejects a check without a valid status', async () => {
    const { deps, err } = cli([{ number: 12, labels: ['ball:agent:devin'] }]);
    expect(
      await runCli(['handoff', '--issue', '12', '--to', 'human', '--summary', 'x', '--check', 'ci=great'], deps),
    ).toBe(2);
    expect(err.join('\n')).toContain('--check status must be');
  });

  it('rejects an empty --needs-human instead of silently dropping it', async () => {
    const { deps, err } = cli([{ number: 12, labels: ['ball:agent:devin'] }]);
    expect(
      await runCli(['handoff', '--issue', '12', '--to', 'human', '--summary', 'x', '--needs-human', ''], deps),
    ).toBe(2);
    expect(err.join('\n')).toContain('--needs-human needs a non-empty value');

    const spaced = cli([{ number: 12, labels: ['ball:agent:devin'] }]);
    expect(
      await runCli(
        ['handoff', '--issue', '12', '--to', 'human', '--summary', 'x', '--needs-human', '   '],
        spaced.deps,
      ),
    ).toBe(2);
    expect(spaced.err.join('\n')).toContain('--needs-human needs a non-empty value');
  });

  it('rejects a bare --needs-human with no value', async () => {
    const { deps, err } = cli([{ number: 12, labels: ['ball:agent:devin'] }]);
    expect(
      await runCli(['handoff', '--issue', '12', '--to', 'human', '--summary', 'x', '--needs-human'], deps),
    ).toBe(2);
    expect(err.join('\n')).toContain('--needs-human needs a value');
  });

  it('reports a collision and leaves the issue alone', async () => {
    const { adapter, deps, err } = cli([{ number: 12, labels: ['ball:agent:codex'] }]);
    const code = await runCli(['handoff', '--issue', '12', '--from', 'devin', '--to', 'human', '--summary', 'mine'], deps);
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('not-holder');
    expect(adapter.issueLabels(12)).toEqual(['ball:agent:codex']);
  });

  it('cannot hand off an unassigned issue', async () => {
    const { deps, err } = cli([{ number: 3 }]);
    expect(await runCli(['handoff', '--issue', '3', '--to', 'human', '--summary', 'x'], deps)).toBe(2);
    expect(err.join('\n')).toContain('no holder yet');
  });
});

describe('agent-ball claim, block, resolve', () => {
  it('claims an unassigned issue', async () => {
    const { adapter, deps, out } = cli([{ number: 3, title: 'three' }]);
    expect(await runCli(['claim', '3', '--agent', 'devin', '--summary', 'On it.'], deps)).toBe(0);
    expect(out.join('\n')).toContain('#3 → devin');
    expect(adapter.issueLabels(3)).toEqual(['ball:agent:devin']);
  });

  it('reports a taken ball', async () => {
    const { deps, err } = cli([{ number: 3, labels: ['ball:agent:codex'] }]);
    expect(await runCli(['claim', '3', '--agent', 'devin'], deps)).toBe(1);
    expect(err.join('\n')).toContain('agent-held');
  });

  it('blocks with the inferred actor', async () => {
    const { adapter, deps, out } = cli([{ number: 4, labels: ['ball:agent:blob'] }]);
    expect(await runCli(['block', '--issue', '4', '--reason', 'needs a secret'], deps)).toBe(0);
    expect(out.join('\n')).toContain('#4 → blocked');
    expect(adapter.issueLabels(4)).toEqual(['ball:blocked']);
  });

  it('resolves a blocked issue back to an agent', async () => {
    const { adapter, deps } = cli([{ number: 4, labels: ['ball:blocked'] }]);
    expect(await runCli(['resolve', '--issue', '4', '--to', 'blob', '--note', 'secret added'], deps)).toBe(0);
    expect(adapter.issueLabels(4)).toEqual(['ball:agent:blob']);
  });

  it('refuses to resolve an issue that is not blocked', async () => {
    const { deps, err } = cli([{ number: 4, labels: ['ball:human'] }]);
    expect(await runCli(['resolve', '--issue', '4', '--to', 'blob'], deps)).toBe(1);
    expect(err.join('\n')).toContain('not-blocked');
  });

  it('prints an outcome as JSON', async () => {
    const { deps, out } = cli([{ number: 3 }]);
    expect(await runCli(['claim', '3', '--agent', 'devin', '--json'], deps)).toBe(0);
    const outcome = JSON.parse(out.join('\n')) as { ok: boolean; state: { phase: string } };
    expect(outcome.ok).toBe(true);
    expect(outcome.state.phase).toBe('agent');
  });
});

describe('agent-ball command surface', () => {
  it('prints usage', async () => {
    const { deps, out } = cli([]);
    expect(await runCli(['help'], deps)).toBe(0);
    expect(out.join('\n')).toContain('agent-ball — turn-taking');
    expect(await runCli([], deps)).toBe(0);
  });

  it('rejects an unknown command', async () => {
    const { deps, err } = cli([]);
    expect(await runCli(['juggle'], deps)).toBe(2);
    expect(err.join('\n')).toContain('unknown command');
  });

  it('rejects an unknown flag', async () => {
    const { deps, err } = cli([]);
    expect(await runCli(['status', '--colour'], deps)).toBe(2);
    expect(err.join('\n')).toContain('unknown option');
  });

  it('prints a version', async () => {
    const { deps, out } = cli([]);
    expect(await runCli(['version'], deps)).toBe(0);
    expect(out.join('\n')).toContain('agent-ball 0.1.1');
  });

  it('needs a repository when none is given', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(['status'], {
      io: { out: (line) => out.push(line), err: (line) => err.push(line) },
      env: {},
      runGh: async () => {
        throw new Error('no repo here');
      },
    });
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('no repository');
  });
});
