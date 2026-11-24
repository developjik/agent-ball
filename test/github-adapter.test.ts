import { describe, expect, it } from 'vitest';
import { GitHubIssueAdapter, type GhRunner } from '../src/core/github-adapter';
import { AdapterError, LabelWriteMismatchError } from '../src/core';

class FakeGh {
  readonly calls: { args: string[]; input?: string }[] = [];
  handler: (args: string[], input?: string) => string = () => '';

  readonly run: GhRunner = async (args, input) => {
    this.calls.push(input === undefined ? { args } : { args, input });
    return this.handler(args, input);
  };

  adapter(): GitHubIssueAdapter {
    return new GitHubIssueAdapter({ repo: 'developjik/agent-ball', run: this.run });
  }
}

const issueJson = JSON.stringify({
  number: 12,
  title: 'A retried handoff posts twice',
  url: 'https://github.com/developjik/agent-ball/issues/12',
  state: 'OPEN',
  labels: [{ name: 'ball:human' }, { name: 'bug' }],
  createdAt: '2026-11-20T09:00:00Z',
  updatedAt: '2026-11-21T09:00:00Z',
  author: { login: 'jungingwon4' },
});

const commentsJson = JSON.stringify({
  comments: [
    {
      id: 'IC_1',
      body: '<!-- agent-ball:v1\n{}\n-->',
      author: { login: 'devin' },
      createdAt: '2026-11-21T08:00:00Z',
      url: 'https://github.com/developjik/agent-ball/issues/12#issuecomment-1',
    },
  ],
});

describe('GitHubIssueAdapter — reads', () => {
  it('lists issues with label filters and parses them', async () => {
    const gh = new FakeGh();
    gh.handler = (args) => (args[1] === 'list' ? `[${issueJson}]` : '');
    const issues = await gh.adapter().listIssues({ state: 'open', labels: ['ball:human', 'ball:agent:devin'], limit: 50 });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      number: 12,
      title: 'A retried handoff posts twice',
      url: 'https://github.com/developjik/agent-ball/issues/12',
      state: 'open',
      labels: ['ball:human', 'bug'],
      createdAt: '2026-11-20T09:00:00Z',
      updatedAt: '2026-11-21T09:00:00Z',
      author: 'jungingwon4',
    });

    const args = gh.calls[0]?.args ?? [];
    expect(args.slice(0, 6)).toEqual(['issue', 'list', '--repo', 'developjik/agent-ball', '--state', 'open']);
    expect(args).toContain('--limit');
    expect(args).toContain('50');
    const labelIndexes = args.map((arg, index) => (arg === '--label' ? index : -1)).filter((index) => index >= 0);
    expect(labelIndexes.map((index) => args[index + 1])).toEqual(['ball:human', 'ball:agent:devin']);
  });

  it('reads one issue and keeps closed state', async () => {
    const gh = new FakeGh();
    gh.handler = () => issueJson.replace('"OPEN"', '"CLOSED"');
    const issue = await gh.adapter().getIssue(12);
    expect(issue.state).toBe('closed');
    expect(gh.calls[0]?.args).toContain('--json');
  });

  it('reads comments with authors and urls', async () => {
    const gh = new FakeGh();
    gh.handler = () => commentsJson;
    const comments = await gh.adapter().listComments(12);
    expect(comments).toEqual([
      {
        id: '1',
        body: '<!-- agent-ball:v1\n{}\n-->',
        author: 'devin',
        createdAt: '2026-11-21T08:00:00Z',
        url: 'https://github.com/developjik/agent-ball/issues/12#issuecomment-1',
      },
    ]);
  });

  it('returns an empty list when the issue has no comments', async () => {
    const gh = new FakeGh();
    gh.handler = () => '{"comments":null}';
    expect(await gh.adapter().listComments(3)).toEqual([]);
  });

  it('raises a typed error on unreadable output', async () => {
    const gh = new FakeGh();
    gh.handler = () => 'not json';
    await expect(gh.adapter().getIssue(1)).rejects.toBeInstanceOf(AdapterError);
  });

  it('surfaces a gh failure with its detail', async () => {
    const gh = new FakeGh();
    gh.handler = () => {
      throw new AdapterError('gh issue view failed: HTTP 404');
    };
    await expect(gh.adapter().getIssue(1)).rejects.toThrow(/404/);
  });
});

describe('GitHubIssueAdapter — writes', () => {
  it('posts a comment via stdin and reads the id back from the url', async () => {
    const gh = new FakeGh();
    gh.handler = () => 'https://github.com/developjik/agent-ball/issues/12#issuecomment-98765\n';
    const comment = await gh.adapter().addComment(12, 'body text');

    expect(comment.id).toBe('98765');
    expect(gh.calls[0]?.input).toBe('body text');
    expect(gh.calls[0]?.args).toEqual([
      'issue',
      'comment',
      '12',
      '--repo',
      'developjik/agent-ball',
      '--body-file',
      '-',
    ]);
  });

  it('finds the posted comment when gh prints no url', async () => {
    const gh = new FakeGh();
    gh.handler = (args) => {
      if (args[0] === 'issue' && args[1] === 'comment') return '';
      return JSON.stringify({
        comments: [
          { id: 1, body: 'old', author: { login: 'x' }, createdAt: '2026-11-21T07:00:00Z' },
          { id: 2, body: 'new body', author: { login: 'x' }, createdAt: '2026-11-21T08:00:00Z' },
        ],
      });
    };
    const comment = await gh.adapter().addComment(12, 'new body');
    expect(comment.id).toBe('2');
  });

  it('deletes a comment through the api', async () => {
    const gh = new FakeGh();
    gh.handler = () => '';
    await gh.adapter().deleteComment(12, '98765');
    expect(gh.calls[0]?.args).toEqual([
      'api',
      '--method',
      'DELETE',
      'repos/developjik/agent-ball/issues/comments/98765',
    ]);
  });

  it('adds and removes labels, then verifies with a read-back', async () => {
    const gh = new FakeGh();
    gh.handler = (args) => {
      if (args[1] === 'view') {
        return JSON.stringify({ ...JSON.parse(issueJson), labels: [{ name: 'ball:agent:devin' }, { name: 'ball:human' }] });
      }
      return '';
    };
    await gh.adapter().updateLabels(12, { add: ['ball:agent:devin'], remove: ['bug'] });

    expect(gh.calls[0]?.args).toEqual([
      'issue',
      'edit',
      '12',
      '--repo',
      'developjik/agent-ball',
      '--add-label',
      'ball:agent:devin',
      '--remove-label',
      'bug',
    ]);
    expect(gh.calls[1]?.args[1]).toBe('view');
  });

  it('fails loudly when the label write did not stick', async () => {
    const gh = new FakeGh();
    gh.handler = (args) => {
      if (args[1] === 'view') return issueJson.replace('"ball:human"', '"ball:agent:codex"');
      return '';
    };
    await expect(gh.adapter().updateLabels(12, { add: ['ball:agent:devin'], remove: [] })).rejects.toBeInstanceOf(
      LabelWriteMismatchError,
    );
  });

  it('does not call gh for an empty label change', async () => {
    const gh = new FakeGh();
    await gh.adapter().updateLabels(12, { add: [], remove: [] });
    expect(gh.calls).toHaveLength(0);
  });

  it('creates the ball labels idempotently', async () => {
    const gh = new FakeGh();
    await gh.adapter().ensureBallLabels(['devin']);
    const names = gh.calls.map((call) => call.args[2]);
    expect(names).toEqual(['ball:human', 'ball:blocked', 'ball:agent:devin']);
    expect(gh.calls.every((call) => call.args.includes('--force'))).toBe(true);
  });
});
