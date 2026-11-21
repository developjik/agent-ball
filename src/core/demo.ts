import { MockAdapter, type MockIssueSeed } from './mock-adapter';
import { buildBoard, type Board } from './board';
import { formatRecord } from './records';
import { buildSnapshot, type IssueSnapshot } from './snapshot';
import type { TurnRecord } from './types';

export const DEMO_REPO = 'developjik/agent-ball';

/**
 * A worked example of the protocol, used by `agent-ball serve --demo` and as the
 * dashboard's fallback so the UI is useful before it is pointed at a real repo.
 * The comments are the same text the CLI writes, so the demo also exercises the
 * parser end to end.
 */
export function createDemoAdapter(now: Date = new Date()): MockAdapter {
  return new MockAdapter({ repo: DEMO_REPO, now, seed: buildSeeds(now) });
}

export function createDemoSnapshots(now: Date = new Date()): IssueSnapshot[] {
  const adapter = createDemoAdapter(now);
  const issues = adapter.allIssues();
  return issues.map((issue) => buildSnapshot(issue, adapter.allComments(issue.number)));
}

export async function demoBoard(now: Date = new Date()): Promise<Board> {
  const snapshots = createDemoSnapshots(now);
  return buildBoard(snapshots, { source: 'demo', repo: DEMO_REPO, now });
}

function minutesAgo(now: Date, minutes: number): string {
  return new Date(now.getTime() - minutes * 60_000).toISOString();
}

let sequence = 0;

function record(now: Date, minutes: number, build: (at: string, id: string) => TurnRecord): string {
  sequence += 1;
  const at = minutesAgo(now, minutes);
  return formatRecord(build(at, `demo-${sequence}`));
}

function buildSeeds(now: Date): MockIssueSeed[] {
  sequence = 0;

  return [
    {
      number: 12,
      title: 'A retried handoff posts the record twice',
      labels: ['ball:human'],
      createdAt: minutesAgo(now, 60 * 26),
      updatedAt: minutesAgo(now, 95),
      comments: [
        record(now, 290, (at, id) => ({
          type: 'claim',
          id,
          issue: 12,
          at,
          agent: 'devin',
          summary: 'Reproducing with a 502 injected between the label write and the comment.',
        })),
        record(now, 95, (at, id) => ({
          type: 'handoff',
          id,
          issue: 12,
          at,
          from: 'devin',
          to: 'human',
          summary:
            'The retry re-posts the handoff record instead of folding it into the existing one, so #12 shows the same move twice. A read-back on the comment id fixes it, but the contract needs a decision first.',
          artifacts: {
            prs: ['https://github.com/developjik/agent-ball/pull/4'],
            branches: ['fix/handoff-idempotency'],
            checks: [
              {
                name: 'ci',
                status: 'success',
                url: 'https://github.com/developjik/agent-ball/actions/runs/1201',
              },
              { name: 'e2e', status: 'neutral' },
            ],
            files: ['src/core/engine.ts', 'test/handoff-block.test.ts'],
          },
          needsHumanDecision:
            'Should a repeated handoff be idempotent by record id (fold into the first comment) or fail loudly with a conflict?',
        })),
      ],
    },
    {
      number: 14,
      title: 'Queue card should say why the ball came back',
      labels: ['ball:human'],
      createdAt: minutesAgo(now, 60 * 9),
      updatedAt: minutesAgo(now, 180),
      comments: [
        record(now, 240, (at, id) => ({
          type: 'handoff',
          id,
          issue: 14,
          at,
          from: 'codex',
          to: 'human',
          summary:
            'Cards currently show the last summary only. Before I add a return reason I want the wording agreed, because it is the first thing you read in the morning.',
          artifacts: { prs: [], branches: [], checks: [], files: ['src/ui/App.tsx'] },
          needsHumanDecision: 'Return reason wording: “blocked on you” or the literal last question?',
        })),
      ],
    },
    {
      number: 7,
      title: 'gh adapter: verify label writes with a read-back',
      labels: ['ball:agent:devin'],
      createdAt: minutesAgo(now, 60 * 31),
      updatedAt: minutesAgo(now, 40),
      comments: [
        record(now, 260, (at, id) => ({
          type: 'handoff',
          id,
          issue: 7,
          at,
          from: 'human',
          to: 'devin',
          summary: 'Take this one; the label race only shows up when two runners start together.',
          artifacts: { prs: [], branches: [], checks: [], files: [] },
          needsHumanDecision: null,
        })),
        record(now, 40, (at, id) => ({
          type: 'claim',
          id,
          issue: 7,
          at,
          agent: 'devin',
          summary: 'Reading labels back after every write; mismatch now throws instead of logging.',
        })),
      ],
    },
    {
      number: 9,
      title: 'Integration suite cannot run without DATABASE_URL',
      labels: ['ball:blocked'],
      createdAt: minutesAgo(now, 60 * 52),
      updatedAt: minutesAgo(now, 420),
      comments: [
        record(now, 620, (at, id) => ({
          type: 'claim',
          id,
          issue: 9,
          at,
          agent: 'blob',
          summary: 'Setting up the Postgres fixture.',
        })),
        record(now, 420, (at, id) => ({
          type: 'block',
          id,
          issue: 9,
          at,
          actor: 'blob',
          reason:
            'The suite needs DATABASE_URL in repo secrets, and only a repo owner can add it. Everything else is ready in the branch.',
        })),
      ],
    },
    {
      number: 3,
      title: 'docs: one handoff block example per record type',
      labels: ['ball:agent:codex'],
      createdAt: minutesAgo(now, 60 * 70),
      updatedAt: minutesAgo(now, 25),
      comments: [
        record(now, 25, (at, id) => ({
          type: 'claim',
          id,
          issue: 3,
          at,
          agent: 'codex',
          summary: 'Writing the four examples straight from the parser fixtures.',
        })),
      ],
    },
    {
      number: 16,
      title: 'Add Codex to the roster and label colours',
      labels: [],
      createdAt: minutesAgo(now, 60 * 5),
      updatedAt: minutesAgo(now, 60 * 5),
      comments: [],
    },
    {
      number: 20,
      title: 'Decide whether a blocked ball should expire',
      labels: ['ball:human'],
      createdAt: minutesAgo(now, 60 * 3),
      updatedAt: minutesAgo(now, 60 * 3),
      comments: [],
    },
    {
      number: 18,
      title: 'Two agents claimed #18 within the same second',
      labels: ['ball:human', 'ball:agent:devin'],
      createdAt: minutesAgo(now, 60 * 12),
      updatedAt: minutesAgo(now, 70),
      comments: [
        record(now, 70, (at, id) => ({
          type: 'claim',
          id,
          issue: 18,
          at,
          agent: 'devin',
          summary: 'Taking this one.',
        })),
        record(now, 70, (at, id) => ({
          type: 'claim',
          id,
          issue: 18,
          at,
          agent: 'codex',
          summary: 'Also taking this one.',
        })),
      ],
    },
  ];
}
