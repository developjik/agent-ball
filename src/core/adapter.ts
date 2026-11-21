import { AgentBallError } from './errors';

export interface AdapterIssue {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: 'open' | 'closed';
  readonly labels: string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly author: string;
}

export interface AdapterComment {
  readonly id: string;
  readonly body: string;
  readonly author: string;
  readonly createdAt: string;
  readonly url: string | null;
}

export interface IssueQuery {
  readonly state?: 'open' | 'closed' | 'all';
  readonly labels?: string[];
  readonly limit?: number;
}

/**
 * The narrow surface the engine needs from GitHub. Everything here is
 * implemented twice: once against the real API (`GitHubIssueAdapter`) and once
 * in memory (`MockAdapter`) so the protocol can be tested deterministically.
 */
export interface IssueAdapter {
  readonly name: string;
  readonly repo: string | null;

  listIssues(query?: IssueQuery): Promise<AdapterIssue[]>;
  getIssue(issue: number): Promise<AdapterIssue>;
  listComments(issue: number): Promise<AdapterComment[]>;
  addComment(issue: number, body: string): Promise<AdapterComment>;
  deleteComment(issue: number, commentId: string): Promise<void>;
  /** Adds and removes only the given labels; other labels are untouched. */
  updateLabels(issue: number, change: { add: string[]; remove: string[] }): Promise<void>;
}

export class AdapterError extends AgentBallError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('adapter-error', message, options);
    this.name = 'AdapterError';
  }
}

export class NotFoundError extends AgentBallError {
  constructor(message: string) {
    super('not-found', message);
    this.name = 'NotFoundError';
  }
}

export class LabelWriteMismatchError extends AgentBallError {
  constructor(message: string) {
    super('state-changed', message);
    this.name = 'LabelWriteMismatchError';
  }
}
