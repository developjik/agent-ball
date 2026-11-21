import { AdapterError, NotFoundError, type AdapterComment, type AdapterIssue, type IssueAdapter, type IssueQuery } from './adapter';

export interface MockIssueSeed {
  readonly number: number;
  readonly title?: string;
  readonly url?: string;
  readonly state?: 'open' | 'closed';
  readonly labels?: string[];
  readonly author?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  /** Comment bodies, oldest first. */
  readonly comments?: string[];
}

export type MockOp = 'getIssue' | 'listIssues' | 'listComments' | 'addComment' | 'deleteComment' | 'updateLabels';

export interface MockCall {
  readonly op: MockOp;
  readonly issue?: number;
  readonly args?: unknown;
}

export interface MockHooks {
  /** Runs just before a comment listing is answered; lets a test interleave a rival. */
  beforeListComments?: (issue: number) => Promise<void> | void;
  /** Runs just before labels are written; lets a test simulate a concurrent edit. */
  beforeUpdateLabels?: (issue: number) => void;
  /** Runs before an issue read; lets a test change labels between two reads. */
  beforeGetIssue?: (issue: number, call: number) => void;
}

interface MockIssue extends AdapterIssue {
  readonly body: string;
}

const DEFAULT_TIME = '2026-11-20T09:00:00.000Z';

/**
 * An in-memory GitHub. It keeps the same contract as the real adapter and
 * records every call, so collisions, races and partial writes are testable
 * without a network or a shared clock.
 */
export class MockAdapter implements IssueAdapter {
  readonly name = 'mock';
  readonly repo: string | null;

  private readonly issues = new Map<number, MockIssue>();
  private readonly comments = new Map<number, AdapterComment[]>();
  private nextCommentId: number;
  private clock: Date;

  readonly calls: MockCall[] = [];
  hooks: MockHooks = {};
  private readonly reads = new Map<number, number>();
  /** Makes the next matching call fail once. */
  failNext: { op: MockOp; error?: Error } | null = null;

  constructor(options: { repo?: string | null; seed?: MockIssueSeed[]; now?: Date; firstCommentId?: number } = {}) {
    this.repo = options.repo ?? 'mock/agent-ball';
    this.clock = options.now ?? new Date(DEFAULT_TIME);
    this.nextCommentId = options.firstCommentId ?? 1;
    for (const seed of options.seed ?? []) this.seed(seed);
  }

  setNow(date: Date): void {
    this.clock = date;
  }

  seed(seed: MockIssueSeed): void {
    this.issues.set(seed.number, {
      number: seed.number,
      title: seed.title ?? `Issue ${seed.number}`,
      url: seed.url ?? this.issueUrl(seed.number),
      state: seed.state ?? 'open',
      labels: [...(seed.labels ?? [])],
      createdAt: seed.createdAt ?? DEFAULT_TIME,
      updatedAt: seed.updatedAt ?? DEFAULT_TIME,
      author: seed.author ?? 'jungingwon4',
      body: '',
    });
    const list: AdapterComment[] = [];
    for (const body of seed.comments ?? []) {
      list.push(this.makeComment(seed.number, body));
    }
    this.comments.set(seed.number, list);
  }

  /** Posts a comment without going through the call log (a rival agent's move). */
  injectComment(issue: number, body: string, author = 'rival', createdAt?: string): AdapterComment {
    const comment = this.makeComment(issue, body, author, createdAt);
    const list = this.comments.get(issue) ?? [];
    list.push(comment);
    this.comments.set(issue, list);
    return comment;
  }

  allIssues(): AdapterIssue[] {
    return [...this.issues.values()].map(toAdapterIssue);
  }

  issueLabels(issue: number): string[] {
    return [...(this.requireIssue(issue).labels ?? [])];
  }

  allComments(issue: number): readonly AdapterComment[] {
    return this.comments.get(issue) ?? [];
  }

  async listIssues(query: IssueQuery = {}): Promise<AdapterIssue[]> {
    this.record({ op: 'listIssues', args: query });
    this.maybeFail('listIssues');
    const state = query.state ?? 'open';
    const wanted = query.labels ?? [];
    const rows = [...this.issues.values()]
      .filter((issue) => state === 'all' || issue.state === state)
      .filter((issue) => wanted.every((label) => issue.labels.includes(label)))
      .sort((a, b) => b.number - a.number)
      .slice(0, query.limit ?? 100)
      .map(toAdapterIssue);
    return rows;
  }

  async getIssue(issue: number): Promise<AdapterIssue> {
    this.record({ op: 'getIssue', issue });
    const call = (this.reads.get(issue) ?? 0) + 1;
    this.reads.set(issue, call);
    this.hooks.beforeGetIssue?.(issue, call);
    this.maybeFail('getIssue');
    return toAdapterIssue(this.requireIssue(issue));
  }

  /** Changes labels without a call record or a hook: another writer's edit. */
  forceLabels(issue: number, labels: string[]): void {
    const target = this.requireIssue(issue);
    this.issues.set(issue, { ...target, labels: [...labels] });
  }

  async listComments(issue: number): Promise<AdapterComment[]> {
    this.record({ op: 'listComments', issue });
    await this.hooks.beforeListComments?.(issue);
    this.maybeFail('listComments');
    return [...(this.comments.get(issue) ?? [])];
  }

  async addComment(issue: number, body: string): Promise<AdapterComment> {
    this.record({ op: 'addComment', issue, args: { body } });
    this.maybeFail('addComment');
    this.requireIssue(issue);
    const comment = this.makeComment(issue, body);
    const list = this.comments.get(issue) ?? [];
    list.push(comment);
    this.comments.set(issue, list);
    this.touch(issue);
    return comment;
  }

  async deleteComment(issue: number, commentId: string): Promise<void> {
    this.record({ op: 'deleteComment', issue, args: { commentId } });
    this.maybeFail('deleteComment');
    const list = this.comments.get(issue) ?? [];
    const index = list.findIndex((comment) => comment.id === commentId);
    if (index === -1) throw new NotFoundError(`comment ${commentId} not found on #${issue}`);
    list.splice(index, 1);
    this.comments.set(issue, list);
  }

  async updateLabels(issue: number, change: { add: string[]; remove: string[] }): Promise<void> {
    this.record({ op: 'updateLabels', issue, args: change });
    this.hooks.beforeUpdateLabels?.(issue);
    this.maybeFail('updateLabels');
    const target = this.requireIssue(issue);
    const remove = new Set(change.remove);
    const labels = target.labels.filter((label) => !remove.has(label));
    for (const label of change.add) if (!labels.includes(label)) labels.push(label);
    this.issues.set(issue, { ...target, labels, updatedAt: this.clock.toISOString() });
  }

  advance(ms: number): void {
    this.clock = new Date(this.clock.getTime() + ms);
  }

  private requireIssue(issue: number): MockIssue {
    const found = this.issues.get(issue);
    if (!found) throw new NotFoundError(`issue #${issue} not found`);
    return found;
  }

  private makeComment(issue: number, body: string, author = 'jungingwon4', createdAt?: string): AdapterComment {
    const id = String(this.nextCommentId++);
    return {
      id,
      body,
      author,
      createdAt: createdAt ?? this.clock.toISOString(),
      url: `https://github.com/${this.repo ?? 'mock/repo'}/issues/${issue}#issuecomment-${id}`,
    };
  }

  private touch(issue: number): void {
    const target = this.requireIssue(issue);
    this.issues.set(issue, { ...target, updatedAt: this.clock.toISOString() });
  }

  private record(call: MockCall): void {
    this.calls.push(call);
  }

  private maybeFail(op: MockOp): void {
    if (this.failNext?.op !== op) return;
    const error = this.failNext.error ?? new AdapterError(`injected failure on ${op}`);
    this.failNext = null;
    throw error;
  }

  private issueUrl(issue: number): string {
    return `https://github.com/${this.repo ?? 'mock/repo'}/issues/${issue}`;
  }
}

function toAdapterIssue(issue: MockIssue): AdapterIssue {
  const { body: _body, ...rest } = issue;
  return { ...rest, labels: [...rest.labels] };
}
