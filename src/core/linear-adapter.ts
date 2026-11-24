import { isAgentName } from './labels';
import { AdapterError, LabelWriteMismatchError, NotFoundError, type AdapterComment, type AdapterIssue, type IssueAdapter, type IssueQuery } from './adapter';

export type LinearRequest = (query: string, variables: Record<string, unknown>) => Promise<any>;

/** Fixed endpoint, no shell, no retries on writes, and no server error bodies in logs. */
export function createLinearRequest(token: string, fetcher: typeof fetch = fetch): LinearRequest {
  if (!token.trim() || /[\r\n]/.test(token)) throw new AdapterError('LINEAR_API_KEY is missing or invalid');
  return async (query, variables) => {
    try {
      const response = await fetcher('https://api.linear.app/graphql', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json', Authorization: token },
        body: JSON.stringify({ query, variables }),
      });
      if (!response.ok) throw new Error();
      if (!response.body) throw new Error();
      const reader = response.body.getReader();
      const decoder = new TextDecoder(); let text = ''; let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error(); }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } finally { reader.releaseLock(); }
      const result = JSON.parse(text) as any;
      if (result.errors?.length || !result.data) throw new Error();
      return result.data;
    } catch {
      throw new AdapterError('Linear request failed; check credentials, permissions, rate limit and connectivity. A write may have landed; inspect before retrying.');
    }
  };
}

const FIELDS = 'id number identifier title url createdAt updatedAt team { key } state { type } creator { name } labels(first: 250) { nodes { id name } pageInfo { hasNextPage } }';
const COMMENT = 'id body createdAt url user { name }';
const PAGE = 'pageInfo { hasNextPage endCursor }';

/** One configured team is the namespace: --issue 12 means TEAM-12, never another team's #12. */
export class LinearIssueAdapter implements IssueAdapter {
  readonly name = 'linear';
  readonly repo: string;
  private readonly request: LinearRequest;
  constructor(options: { team: string; request?: LinearRequest; token?: string }) {
    if (!/^[A-Z][A-Z0-9]{0,31}$/.test(options.team)) throw new AdapterError('Linear team must be an uppercase team key');
    this.repo = options.team;
    this.request = options.request ?? createLinearRequest(options.token ?? '');
  }
  private identifier(issue: number): string {
    if (!Number.isSafeInteger(issue) || issue <= 0) throw new AdapterError('Linear issue must be a positive integer');
    return `${this.repo}-${issue}`;
  }
  private convert(raw: any): AdapterIssue {
    if (!raw || typeof raw.title !== 'string' || typeof raw.url !== 'string' || !Number.isFinite(Date.parse(raw.createdAt)) || !Number.isFinite(Date.parse(raw.updatedAt)) || raw.labels?.nodes?.some((l: any) => typeof l.id !== 'string' || typeof l.name !== 'string') || raw.team?.key !== this.repo || raw.identifier !== this.identifier(raw.number) || !raw.id || !raw.state?.type || !Array.isArray(raw.labels?.nodes) || raw.labels.pageInfo?.hasNextPage) {
      throw new AdapterError('Linear returned an incomplete or out-of-team issue');
    }
    return { number: raw.number, title: raw.title, url: raw.url, state: ['completed', 'canceled'].includes(raw.state.type) ? 'closed' : 'open', labels: raw.labels.nodes.map((l: any) => l.name), createdAt: raw.createdAt, updatedAt: raw.updatedAt, author: raw.creator?.name ?? '' };
  }
  private async rawIssue(issue: number): Promise<any> {
    const id = this.identifier(issue);
    const data = await this.request(`query BallIssue($id: String!) { issue(id: $id) { ${FIELDS} } }`, { id });
    if (!data.issue) throw new NotFoundError(`Linear ${id} was not found`);
    this.convert(data.issue);
    return data.issue;
  }
  async getIssue(issue: number): Promise<AdapterIssue> { return this.convert(await this.rawIssue(issue)); }
  async listIssues(query: IssueQuery = {}): Promise<AdapterIssue[]> {
    const limit = query.limit ?? 200;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 2000) throw new AdapterError('Linear limit must be 0..2000');
    const filter: any = { team: { key: { eq: this.repo } } };
    if (query.state !== 'all') filter.state = { type: query.state === 'closed' ? { in: ['completed', 'canceled'] } : { nin: ['completed', 'canceled'] } };
    if (query.labels?.length) filter.and = query.labels.map(name => ({ labels: { some: { name: { eq: name } } } }));
    const rows: AdapterIssue[] = []; let after: string | null = null;
    while (rows.length < limit) {
      const data = await this.request(`query BallIssues($filter: IssueFilter!, $first: Int!, $after: String) { issues(filter: $filter, first: $first, after: $after) { nodes { ${FIELDS} } ${PAGE} } }`, { filter, first: Math.min(100, limit - rows.length), after });
      const connection = data.issues;
      if (!Array.isArray(connection?.nodes) || !connection.pageInfo) throw new AdapterError('Linear issue page is incomplete');
      rows.push(...connection.nodes.map((r: any) => this.convert(r)));
      if (!connection.pageInfo.hasNextPage) break;
      const cursor = connection.pageInfo.endCursor;
      if (!cursor || cursor === after || connection.nodes.length === 0) throw new AdapterError('Linear issue pagination did not advance');
      after = cursor;
    }
    return rows.slice(0, limit);
  }
  private comment(raw: any): AdapterComment {
    if (!raw || typeof raw.id !== 'string' || typeof raw.body !== 'string' || !Number.isFinite(Date.parse(raw.createdAt))) throw new AdapterError('Linear comment metadata is incomplete');
    return { id: raw.id, body: raw.body, createdAt: raw.createdAt, author: raw.user?.name ?? '', url: raw.url ?? null };
  }
  async listComments(issue: number): Promise<AdapterComment[]> {
    const raw = await this.rawIssue(issue);
    const rows: AdapterComment[] = []; let after: string | null = null;
    for (let page = 0; page < 20; page++) {
      const data = await this.request(`query BallComments($id: String!, $after: String) { issue(id: $id) { comments(first: 100, after: $after) { nodes { ${COMMENT} } ${PAGE} } } }`, { id: raw.id, after });
      const c = data.issue?.comments;
      if (!Array.isArray(c?.nodes) || !c.pageInfo) throw new AdapterError('Linear comments page is incomplete');
      rows.push(...c.nodes.map((r: any) => this.comment(r)));
      if (!c.pageInfo.hasNextPage) return rows;
      const cursor = c.pageInfo.endCursor;
      if (!cursor || cursor === after || c.nodes.length === 0) throw new AdapterError('Linear comment pagination did not advance');
      after = cursor;
    }
    throw new AdapterError('Linear comments exceed the safe pagination bound; no partial lock view returned');
  }
  async addComment(issue: number, body: string): Promise<AdapterComment> {
    const raw = await this.rawIssue(issue);
    const data = await this.request(`mutation BallComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { ${COMMENT} } } }`, { input: { issueId: raw.id, body } });
    if (!data.commentCreate?.success) throw new AdapterError('Linear comment creation was not confirmed');
    return this.comment(data.commentCreate.comment);
  }
  async deleteComment(issue: number, commentId: string): Promise<void> {
    // Only delete a comment observed on this issue, never a cross-team arbitrary UUID.
    if (!(await this.listComments(issue)).some(c => c.id === commentId)) throw new AdapterError('Linear comment is not on the configured issue');
    const data = await this.request('mutation BallDelete($id: String!) { commentDelete(id: $id) { success } }', { id: commentId });
    if (!data.commentDelete?.success) throw new AdapterError('Linear comment deletion was not confirmed');
  }
  async updateLabels(issue: number, change: { add: string[]; remove: string[] }): Promise<void> {
    if (!change.add.length && !change.remove.length) return;
    if (change.add.some(n => change.remove.includes(n))) throw new AdapterError('A label cannot be both added and removed');
    if ([...change.add, ...change.remove].some(n => !(n === 'ball:human' || n === 'ball:blocked' || (n.startsWith('ball:agent:') && isAgentName(n.slice(11)))))) throw new AdapterError('Linear adapter only writes ball labels');
    const raw = await this.rawIssue(issue);
    const byName = new Map<string, string>();
    for (const label of raw.labels.nodes) byName.set(label.name, label.id);
    // Resolve workspace/global and team labels. Ambiguous duplicate names fail closed.
    const data = await this.request(`query BallLabels($filter: IssueLabelFilter!) { issueLabels(first: 250, filter: $filter) { nodes { id name isGroup parent { id } } ${PAGE} } }`, { filter: { or: [{ team: { key: { eq: this.repo } } }, { team: { null: true } }] } });
    const labels = data.issueLabels;
    if (!Array.isArray(labels?.nodes) || labels.pageInfo?.hasNextPage) throw new AdapterError('Linear label catalog is incomplete');
    const lookup = (name: string): string => {
      const matches = labels.nodes.filter((l: any) => l.name === name);
      if (matches.length !== 1) throw new AdapterError(`Create one unambiguous Linear label named ${name} before writing`);
      if (matches[0].isGroup || matches[0].parent) throw new AdapterError('Linear ball labels must be ungrouped standalone labels');
      return matches[0].id;
    };
    const addedLabelIds = [...new Set(change.add)].map(lookup);
    const removedLabelIds = [...new Set(change.remove)].filter(n => byName.has(n)).map(n => byName.get(n)!);
    const result = await this.request('mutation BallLabelsUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', { id: raw.id, input: { addedLabelIds, removedLabelIds } });
    if (!result.issueUpdate?.success) throw new AdapterError('Linear label update was not confirmed');
    const after = await this.getIssue(issue);
    if (change.add.some(n => !after.labels.includes(n)) || change.remove.some(n => after.labels.includes(n))) throw new LabelWriteMismatchError('Linear label readback did not match; inspect before retrying');
  }
}
