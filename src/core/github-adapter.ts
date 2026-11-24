import { execFile } from 'node:child_process';
import {
  AdapterError,
  LabelWriteMismatchError,
  NotFoundError,
  type AdapterComment,
  type AdapterIssue,
  type IssueAdapter,
  type IssueQuery,
} from './adapter';
import { ballLabels, ownerFromLabels } from './labels';

/** Runs one `gh` command and returns stdout. Injected so tests never spawn. */
export type GhRunner = (args: string[], input?: string) => Promise<string>;

export function createGhRunner(environment: NodeJS.ProcessEnv = process.env): GhRunner {
  return (args, input) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(
        'gh',
        args,
        { env: environment, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
        (error, stdout, stderr) => {
          if (error) {
            const detail = (stderr || error.message).trim();
            reject(new AdapterError(`gh ${args.slice(0, 2).join(' ')} failed: ${detail}`, { cause: error }));
            return;
          }
          resolve(stdout);
        },
      );
      if (input !== undefined) child.stdin?.end(input);
    });
}

interface GhIssue {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: string;
  readonly labels: readonly { readonly name: string }[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly author?: { readonly login?: string } | null;
  readonly comments?: readonly GhComment[];
}

interface GhComment {
  readonly id?: string | number;
  readonly body?: string;
  readonly author?: { readonly login?: string } | null;
  readonly createdAt?: string;
  readonly url?: string;
}

export interface GitHubAdapterOptions {
  readonly repo: string;
  readonly run?: GhRunner;
}

/** Reads and writes issues through the `gh` CLI, which carries the sign-in. */
export class GitHubIssueAdapter implements IssueAdapter {
  readonly name = 'github';
  readonly repo: string;
  private readonly run: GhRunner;

  constructor(options: GitHubAdapterOptions) {
    this.repo = options.repo;
    this.run = options.run ?? createGhRunner();
  }

  async listIssues(query: IssueQuery = {}): Promise<AdapterIssue[]> {
    const args = [
      'issue',
      'list',
      '--repo',
      this.repo,
      '--state',
      query.state ?? 'open',
      '--limit',
      String(query.limit ?? 200),
      '--json',
      'number,title,url,state,labels,createdAt,updatedAt,author',
    ];
    for (const label of query.labels ?? []) args.push('--label', label);
    const rows = await this.jsonArray(args);
    return rows.map((row) => toIssue(row));
  }

  async getIssue(issue: number): Promise<AdapterIssue> {
    const output = await this.run([
      'issue',
      'view',
      String(issue),
      '--repo',
      this.repo,
      '--json',
      'number,title,url,state,labels,createdAt,updatedAt,author',
    ]);
    return toIssue(parseJson(output, `issue #${issue}`));
  }

  async listComments(issue: number): Promise<AdapterComment[]> {
    const output = await this.run(['issue', 'view', String(issue), '--repo', this.repo, '--json', 'comments']);
    const parsed = parseJson(output, `comments of #${issue}`) as { comments?: unknown };
    const rows = parsed.comments;
    if (!Array.isArray(rows)) return [];
    return rows.map((row, index) => toComment(row, issue, index));
  }

  async addComment(issue: number, body: string): Promise<AdapterComment> {
    const output = await this.run(
      ['issue', 'comment', String(issue), '--repo', this.repo, '--body-file', '-'],
      body,
    );
    const url = output.trim().split('\n').at(-1) ?? '';
    const match = /#issuecomment-(\d+)/.exec(url);
    if (match?.[1]) {
      return { id: match[1], body, author: '', createdAt: new Date().toISOString(), url };
    }
    // Older gh versions print nothing useful; find the comment we just wrote.
    const comments = await this.listComments(issue);
    const found = [...comments].reverse().find((comment) => comment.body === body);
    if (!found) throw new AdapterError(`comment was posted to #${issue} but its id could not be read back`);
    return { ...found, body };
  }

  async deleteComment(issue: number, commentId: string): Promise<void> {
    await this.run(['api', '--method', 'DELETE', `repos/${this.repo}/issues/comments/${commentId}`]);
  }

  async updateLabels(issue: number, change: { add: string[]; remove: string[] }): Promise<void> {
    const args = ['issue', 'edit', String(issue), '--repo', this.repo];
    if (change.add.length > 0) args.push('--add-label', change.add.join(','));
    if (change.remove.length > 0) args.push('--remove-label', change.remove.join(','));
    if (change.add.length === 0 && change.remove.length === 0) return;
    await this.run(args);

    // Read back: a label write that silently lost a race must not be reported as done.
    const after = await this.getIssue(issue);
    const labels = new Set(after.labels);
    const missing = change.add.filter((label) => !labels.has(label));
    const lingering = change.remove.filter((label) => labels.has(label));
    if (missing.length > 0 || lingering.length > 0) {
      throw new LabelWriteMismatchError(
        `label write on #${issue} did not stick (missing: ${missing.join(', ') || 'none'}; lingering: ${lingering.join(', ') || 'none'})`,
      );
    }
  }

  /** Creates the ball labels (idempotent: `gh label create --force`). */
  async ensureBallLabels(agents: readonly string[]): Promise<void> {
    const defs: { name: string; color: string; description: string }[] = [
      { name: 'ball:human', color: 'b45309', description: 'Ball is with a human — needs a decision' },
      { name: 'ball:blocked', color: 'b91c1c', description: 'Ball is parked until a blocker is resolved' },
    ];
    for (const agent of agents) {
      defs.push({
        name: `ball:agent:${agent}`,
        color: '0f766e',
        description: `Ball is with agent ${agent}`,
      });
    }
    for (const def of defs) {
      await this.run([
        'label',
        'create',
        def.name,
        '--repo',
        this.repo,
        '--color',
        def.color,
        '--description',
        def.description,
        '--force',
      ]);
    }
  }

  private async jsonArray(args: string[]): Promise<unknown[]> {
    const output = await this.run(args);
    const parsed = parseJson(output, 'issue list');
    if (!Array.isArray(parsed)) throw new AdapterError(`expected a JSON array from gh ${args[0] ?? ''}`);
    return parsed;
  }
}

function parseJson(output: string, what: string): unknown {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new AdapterError(`could not read ${what} as JSON: ${(error as Error).message}`, { cause: error });
  }
}

function toIssue(value: unknown): AdapterIssue {
  if (typeof value !== 'object' || value === null) throw new AdapterError('gh returned a non-object issue');
  const raw = value as Partial<GhIssue> & { readonly labels?: unknown };
  if (typeof raw.number !== 'number') throw new AdapterError('issue is missing a number');
  const labels = Array.isArray(raw.labels)
    ? raw.labels.map((label) => {
        if (typeof label === 'string') return label;
        if (typeof label === 'object' && label !== null && typeof (label as { name?: unknown }).name === 'string') {
          return (label as { name: string }).name;
        }
        return '';
      }).filter((label) => label !== '')
    : [];
  const state = typeof raw.state === 'string' && raw.state.toLowerCase() === 'closed' ? 'closed' : 'open';
  return {
    number: raw.number,
    title: typeof raw.title === 'string' ? raw.title : '',
    url: typeof raw.url === 'string' ? raw.url : '',
    state,
    labels,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    author: raw.author?.login ?? '',
  };
}

function toComment(value: unknown, issue: number, index: number): AdapterComment {
  if (typeof value !== 'object' || value === null) throw new AdapterError('gh returned a non-object comment');
  const raw = value as GhComment;
  const id = raw.url?.match(/#issuecomment-(\d+)$/)?.[1] ?? (raw.id === undefined ? `unknown-${index}` : String(raw.id));
  return {
    id,
    body: typeof raw.body === 'string' ? raw.body : '',
    author: raw.author?.login ?? '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    url: typeof raw.url === 'string' ? raw.url : `https://github.com/issues/${issue}#issuecomment-${id}`,
  };
}

/** Ball labels on an issue, for callers that only need the owner. */
export function ballOwnerOf(issue: AdapterIssue) {
  return ownerFromLabels(ballLabels(issue.labels));
}

export function describeNotFound(error: unknown): string | null {
  return error instanceof NotFoundError ? error.message : null;
}
