import { describe, expect, it } from 'vitest';
import { describeRecord, formatRecord, parseRecords, serializeRecord, validateRecord } from '../src/core';
import type { HandoffRecord, TurnRecord } from '../src/core';

const AT = '2026-11-21T10:00:00.000Z';

const handoff: HandoffRecord = {
  type: 'handoff',
  id: 'h-1',
  issue: 12,
  at: AT,
  from: 'devin',
  to: 'human',
  summary: 'Adapter retries fixed.\nThe flag question is yours.',
  artifacts: {
    prs: ['https://github.com/developjik/agent-ball/pull/4'],
    branches: ['fix/handoff-idempotency'],
    checks: [
      { name: 'ci', status: 'success', url: 'https://example.test/ci/1' },
      { name: 'e2e', status: 'pending' },
    ],
    files: ['src/core/engine.ts'],
  },
  needsHumanDecision: 'Ship behind a flag?',
};

const claim: TurnRecord = {
  type: 'claim',
  id: 'c-1',
  issue: 7,
  at: AT,
  agent: 'codex',
  summary: null,
};

const block: TurnRecord = {
  type: 'block',
  id: 'b-1',
  issue: 9,
  at: AT,
  actor: 'blob',
  reason: 'Needs DATABASE_URL in repo secrets.',
};

const resolve: TurnRecord = {
  type: 'resolve',
  id: 'r-1',
  issue: 9,
  at: AT,
  actor: 'human',
  to: 'blob',
  note: 'Secret added.',
};

describe('record round-trip', () => {
  it.each([handoff, claim, block, resolve])('round-trips a $type record', (record) => {
    const body = formatRecord(record);
    const parsed = parseRecords(body);
    expect(parsed.problems).toEqual([]);
    expect(parsed.records).toEqual([record]);
  });

  it('keeps a summary that contains an HTML comment terminator', () => {
    const tricky: TurnRecord = { ...handoff, summary: 'before --> after -- > done' };
    const body = formatRecord(tricky);
    expect(body).not.toContain('before --> after');
    expect(parseRecords(body).records).toEqual([tricky]);
  });

  it('round-trips unicode and newlines', () => {
    const korean: TurnRecord = {
      ...handoff,
      summary: '핸드오프 완료\n— 결정 부탁드립니다. ⚽',
      needsHumanDecision: '플래그 뒤에 배포할까요?',
    };
    expect(parseRecords(formatRecord(korean)).records).toEqual([korean]);
  });

  it('emits readable prose above the machine block', () => {
    const body = formatRecord(handoff);
    expect(body).toContain('### Handoff · devin → human');
    expect(body).toContain('**Artifacts**');
    expect(body).toContain('**Needs your decision:** Ship behind a flag?');
    expect(body).toContain('PR https://github.com/developjik/agent-ball/pull/4');
    expect(body).toContain('Check `e2e` · pending');
  });

  it('can format prose only', () => {
    const body = formatRecord(claim, { machine: false });
    expect(body).not.toContain('<!-- agent-ball:v1');
    expect(parseRecords(body).records).toEqual([]);
  });

  it('parses several records from one comment', () => {
    const body = `${formatRecord(claim)}\nthanks!\n${formatRecord(handoff)}`;
    expect(parseRecords(body).records.map((record) => record.type)).toEqual(['claim', 'handoff']);
  });

  it('ignores comments with no record', () => {
    expect(parseRecords('Looks good to me. <!-- unrelated -->').records).toEqual([]);
  });

  it('keeps a record whose comment also has free text', () => {
    const body = `Free text first.\n\n${serializeRecord(handoff)}\n\nFree text after.`;
    expect(parseRecords(body).records).toEqual([handoff]);
  });

  it('describes records in one line', () => {
    expect(describeRecord(handoff)).toContain('handoff devin → human');
    expect(describeRecord(block)).toContain('blocked by blob');
    expect(describeRecord(claim)).toContain('claim by codex');
    expect(describeRecord(resolve)).toContain('unblocked by human → blob');
  });
});

describe('record validation', () => {
  it('reports invalid JSON instead of throwing', () => {
    const parsed = parseRecords('<!-- agent-ball:v1\n{ not json }\n-->');
    expect(parsed.records).toEqual([]);
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]?.code).toBe('invalid-json');
  });

  it('reports an unknown record type', () => {
    const parsed = parseRecords('<!-- agent-ball:v1\n{"type":"shrug","id":"x","issue":1,"at":"2026-11-21T10:00:00.000Z"}\n-->');
    expect(parsed.problems[0]?.message).toContain('unknown record type');
  });

  it('rejects a handoff without a summary', () => {
    const result = validateRecord({ ...handoff, summary: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('summary');
  });

  it('rejects a handoff to itself', () => {
    const result = validateRecord({ ...handoff, to: 'devin' });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-positive issue number', () => {
    const result = validateRecord({ ...handoff, issue: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('issue');
  });

  it('rejects a bad timestamp', () => {
    const result = validateRecord({ ...handoff, at: 'yesterday' });
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown check status', () => {
    const result = validateRecord({
      ...handoff,
      artifacts: { ...handoff.artifacts, checks: [{ name: 'ci', status: 'great' }] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('check.status');
  });

  it('defaults missing artifacts to empty lists', () => {
    const result = validateRecord({
      type: 'handoff',
      id: 'h',
      issue: 1,
      at: AT,
      from: 'devin',
      to: 'human',
      summary: 'done',
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.record.type === 'handoff') {
      expect(result.record.artifacts).toEqual({ prs: [], branches: [], checks: [], files: [] });
      expect(result.record.needsHumanDecision).toBeNull();
    }
  });

  it('keeps unknown extra fields out of the parsed record', () => {
    const result = validateRecord({ ...handoff, futureField: 'ignored' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record).not.toHaveProperty('futureField');
  });

  it('rejects blank actors and reasons', () => {
    expect(validateRecord({ ...block, reason: ' ' }).ok).toBe(false);
    expect(validateRecord({ ...resolve, actor: '' }).ok).toBe(false);
  });
});
