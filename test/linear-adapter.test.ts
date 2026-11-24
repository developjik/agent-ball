import { describe, it, expect } from 'vitest';
import { LinearIssueAdapter, createLinearRequest, type LinearRequest } from '../src/core/linear-adapter';
import { runCli } from '../src/cli/run';

const time = '2026-11-20T12:00:00.000Z';
function fixture() {
  const labels = [{ id: 'human', name: 'ball:human', parent: null, isGroup: false }, { id: 'codex', name: 'ball:agent:codex', parent: null, isGroup: false }, { id: 'other', name: 'product', parent: null, isGroup: false }];
  const issue: any = { id: 'uuid', number: 12, identifier: 'DEV-12', team: { key: 'DEV' }, title: 'Fixture issue', url: 'https://linear.app/test/issue/DEV-12', createdAt: time, updatedAt: time, creator: { name: 'test' }, state: { type: 'started' }, labels: { nodes: [labels[0], labels[2]], pageInfo: { hasNextPage: false } } };
  let comments: any[] = []; let seq = 0;
  const calls: { query: string; variables: any }[] = [];
  const request: LinearRequest = async (query, variables) => {
    const v = variables as any;
    calls.push({ query, variables: v });
    if (query.includes('query BallIssue(')) return { issue };
    if (query.includes('query BallIssues(')) return { issues: { nodes: [issue], pageInfo: { hasNextPage: false } } };
    if (query.includes('query BallComments(')) return { issue: { comments: { nodes: [...comments], pageInfo: { hasNextPage: false } } } };
    if (query.includes('mutation BallComment(')) {
      const c = { id: `comment-${++seq}`, body: v.input.body, createdAt: time, user: { name: 'test' }, url: null };
      comments.push(c); return { commentCreate: { success: true, comment: c } };
    }
    if (query.includes('mutation BallDelete(')) { comments = comments.filter(c => c.id !== v.id); return { commentDelete: { success: true } }; }
    if (query.includes('query BallLabels(')) return { issueLabels: { nodes: labels, pageInfo: { hasNextPage: false } } };
    if (query.includes('mutation BallLabelsUpdate(')) {
      issue.labels.nodes = issue.labels.nodes.filter((l: any) => !v.input.removedLabelIds.includes(l.id));
      for (const id of v.input.addedLabelIds) if (!issue.labels.nodes.some((l: any) => l.id === id)) issue.labels.nodes.push(labels.find(l => l.id === id));
      return { issueUpdate: { success: true } };
    }
    throw new Error('unexpected operation');
  };
  return { issue, labels, calls, request, adapter: new LinearIssueAdapter({ team: 'DEV', request }), comments: () => comments };
}

describe('Linear adapter', () => {
  it('maps team-local number, labels and open/closed state', async () => {
    const f = fixture(); expect((await f.adapter.getIssue(12))).toMatchObject({ number: 12, state: 'open', labels: ['ball:human', 'product'] });
    expect(f.calls[0]?.variables.id).toBe('DEV-12');
    for (const type of ['completed', 'canceled']) { f.issue.state.type = type; expect((await f.adapter.getIssue(12)).state).toBe('closed'); }
  });
  it('filters team/state/each label on server', async () => {
    const f = fixture(); await f.adapter.listIssues({ labels: ['one', 'two'], state: 'closed', limit: 12 });
    expect(f.calls[0]?.variables).toMatchObject({ first: 12, filter: { team: { key: { eq: 'DEV' } }, state: { type: { in: ['completed', 'canceled'] } }, and: [{ labels: { some: { name: { eq: 'one' } } } }, { labels: { some: { name: { eq: 'two' } } } }] } });
  });
  it('paginates issues and rejects non-advancing cursors', async () => {
    const f = fixture(); let n = 0;
    const adapter = new LinearIssueAdapter({ team: 'DEV', request: async (_, v) => { n++; return { issues: { nodes: [f.issue], pageInfo: { hasNextPage: true, endCursor: 'same' } } }; } });
    await expect(adapter.listIssues({ limit: 3 })).rejects.toThrow('did not advance'); expect(n).toBe(2);
  });
  it('does not truncate comment lock view on bad pagination', async () => {
    const f = fixture(); const adapter = new LinearIssueAdapter({ team: 'DEV', request: async (q, v) => q.includes('BallIssue(') ? { issue: f.issue } : { issue: { comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'x' } } } } });
    await expect(adapter.listComments(12)).rejects.toThrow('did not advance');
  });
  it('preserves unrelated labels using additive/removal fields and readback', async () => {
    const f = fixture(); await f.adapter.updateLabels(12, { add: ['ball:agent:codex'], remove: ['ball:human'] });
    expect((await f.adapter.getIssue(12)).labels).toEqual(['product', 'ball:agent:codex']);
    const write = f.calls.find(c => c.query.includes('mutation BallLabelsUpdate'));
    expect(write?.variables.input).toEqual({ addedLabelIds: ['codex'], removedLabelIds: ['human'] });
  });
  it('refuses other-team results, invalid numbers, and incomplete label views', async () => {
    const f = fixture(); await expect(f.adapter.getIssue(0)).rejects.toThrow('positive');
    f.issue.team.key = 'OTHER'; await expect(f.adapter.getIssue(12)).rejects.toThrow('out-of-team');
    f.issue.team.key = 'DEV'; f.issue.labels.pageInfo.hasNextPage = true; await expect(f.adapter.getIssue(12)).rejects.toThrow('incomplete');
    expect(() => new LinearIssueAdapter({ team: 'DEV;echo', request: f.request })).toThrow('team key');
  });
  it('rejects ambiguous, missing, grouped, and non-ball label writes', async () => {
    const f = fixture();
    await expect(f.adapter.updateLabels(12, { add: ['product'], remove: [] })).rejects.toThrow('only writes ball');
    await expect(f.adapter.updateLabels(12, { add: ['ball:agent:missing'], remove: [] })).rejects.toThrow('unambiguous');
    f.labels.push({ ...f.labels[1]!, id: 'duplicate' });
    await expect(f.adapter.updateLabels(12, { add: ['ball:agent:codex'], remove: [] })).rejects.toThrow('unambiguous');
    f.labels.pop(); (f.labels[1] as any).parent = { id: 'group' };
    await expect(f.adapter.updateLabels(12, { add: ['ball:agent:codex'], remove: [] })).rejects.toThrow('ungrouped');
  });
  it('creates comments with server metadata and confines delete to issue', async () => {
    const f = fixture(); const c = await f.adapter.addComment(12, 'local fixture'); expect(c.createdAt).toBe(time);
    await expect(f.adapter.deleteComment(12, 'elsewhere')).rejects.toThrow('not on');
    await f.adapter.deleteComment(12, c.id); expect(f.comments()).toEqual([]);
  });
  it('fails closed on missing mutation success or lost label readback', async () => {
    const f = fixture(); let success = false;
    const adapter = new LinearIssueAdapter({ team: 'DEV', request: async (q,v) => q.includes('mutation BallLabelsUpdate') ? { issueUpdate: { success } } : f.request(q,v) });
    await expect(adapter.updateLabels(12, { add: ['ball:agent:codex'], remove: [] })).rejects.toThrow('not confirmed');
    success = true; await expect(adapter.updateLabels(12, { add: ['ball:agent:codex'], remove: [] })).rejects.toThrow('readback');
  });
});

describe('Linear HTTP transport', () => {
  it('uses fixed HTTPS endpoint, variables, deadline and no redirects', async () => {
    let seen: any; const request = createLinearRequest('test-secret', async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ data: { viewer: { id: 'x' } } })); });
    expect(await request('query Fixture { viewer { id } }', {})).toEqual({ viewer: { id: 'x' } });
    expect(seen.url).toBe('https://api.linear.app/graphql'); expect(seen.init.redirect).toBe('error'); expect(seen.init.signal).toBeInstanceOf(AbortSignal);
  });
  it('does not expose token, GraphQL error, transport error or partially successful data', async () => {
    for (const response of [new Response('secret', { status: 401 }), new Response(JSON.stringify({ data: { x: 1 }, errors: [{ message: 'test-secret' }] }))]) {
      await expect(createLinearRequest('test-secret', async () => response)('', {})).rejects.toThrow('Linear request failed');
    }
    try { await createLinearRequest('test-secret', async () => { throw new Error('test-secret'); })('', {}); } catch (e) { expect(String(e)).not.toContain('test-secret'); }
    expect(() => createLinearRequest('')).toThrow('missing');
  });
});

describe('CLI Linear integration (local simulated GraphQL service)', () => {
  it('status and next use same board shape, handoff persists a record and moves only ball labels', async () => {
    const f = fixture(); let out: string[] = [], err: string[] = [];
    const deps = { env: {}, linearRequest: f.request, now: () => new Date(time), newId: () => 'fixture-id', io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
    const flags = ['--tracker', 'linear', '--team', 'DEV'];
    expect(await runCli(['status', ...flags, '--json'], deps)).toBe(0);
    expect(JSON.parse(out.join(''))).toMatchObject({ source: 'linear', repo: 'DEV', counts: { human: 1, total: 1 } });
    out = []; expect(await runCli(['next', ...flags, '--agent', 'codex'], deps)).toBe(0);
    out = []; expect(await runCli(['handoff', ...flags, '--issue', '12', '--from', 'human', '--to', 'codex', '--summary', 'Local acceptance only'], deps), err.join('')).toBe(0);
    expect(f.comments().some(c => c.body.includes('Local acceptance only'))).toBe(true);
    expect(f.comments().some(c => c.body.includes('agent-ball:lock'))).toBe(false);
    expect((await f.adapter.getIssue(12)).labels).toEqual(['product', 'ball:agent:codex']);
    out = []; expect(await runCli(['next', ...flags, '--agent', 'codex', '--json'], deps)).toBe(0);
    expect(JSON.parse(out.join('')).held[0].number).toBe(12);
  });
  it('rejects ambiguous configuration before network or GitHub fallback', async () => {
    const err: string[] = []; const deps = { env: {}, io: { out() {}, err: (s: string) => err.push(s) }, linearRequest: async () => { throw new Error('must not fetch'); }, runGh: async () => { throw new Error('must not run gh'); } };
    for (const args of [['status', '--tracker', 'linear'], ['status', '--tracker', 'unknown'], ['status', '--tracker', 'linear', '--team', 'DEV', '--repo', 'o/r'], ['status', '--tracker', 'linear', '--team', 'DEV', '--demo'], ['labels', '--tracker', 'linear', '--team', 'DEV'], ['serve', '--tracker', 'linear', '--team', 'DEV'], ['handoff', '--tracker', 'linear', '--team', 'DEV', '--issue', '12bad', '--to', 'codex', '--summary', 'x']]) expect(await runCli(args, deps)).toBe(2);
    expect(err.join('')).not.toContain('must not');
  });
});
