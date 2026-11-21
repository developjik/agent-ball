import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type { DashboardIssue, TimelineEntry } from '../core/board';
import { age, clockTime } from './time';

export function Mark(): ReactElement {
  return (
    <svg
      className="mark"
      width="26"
      height="26"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="10.2" fill="none" stroke="currentColor" strokeWidth="1.35" />
      <path
        d="M12 6.1 16.15 9.1 14.57 14h-5.14L7.85 9.1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <path
        d="M12 1.8v4.3M2.6 8.4l5.25.7M21.4 8.4l-5.25.7M6.15 20.9l3.28-4.1M17.85 20.9l-3.28-4.1"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Arrow(): ReactElement {
  return <span className="arrow" aria-hidden="true" />;
}

export function who(name: string | null | undefined): string {
  if (!name) return 'nobody';
  return name === 'human' ? 'you' : name;
}

export interface Trail {
  readonly from: string;
  readonly to: string | null;
}

/** The last move, split so the arrow can be drawn rather than typed. */
export function trailOf(issue: DashboardIssue): Trail {
  const last = issue.timeline.at(-1);
  if (!last) return { from: issue.column === 'unassigned' ? 'no owner yet' : 'no record yet', to: null };
  switch (last.type) {
    case 'handoff':
      return { from: who(last.actor), to: who(last.to) };
    case 'claim':
      return { from: `${last.actor} picked it up`, to: null };
    case 'block':
      return { from: `${last.actor} parked it`, to: null };
    case 'resolve':
      return { from: last.actor, to: who(last.to) };
  }
}

export function StateChip({ issue }: { issue: DashboardIssue }): ReactElement {
  const label =
    issue.column === 'human'
      ? 'needs you'
      : issue.column === 'agent'
        ? (issue.agent ?? 'agent')
        : issue.column === 'blocked'
          ? 'blocked'
          : 'unassigned';
  return (
    <span className="chip" data-accent={issue.column}>
      {label}
    </span>
  );
}

export interface ColumnProps {
  readonly title: string;
  readonly accent: 'human' | 'agent' | 'blocked' | 'unassigned';
  readonly count: number;
  readonly hint?: string;
  readonly children: ReactNode;
}

export function Column({ title, accent, count, hint, children }: ColumnProps): ReactElement {
  return (
    <section className="column" data-accent={accent} aria-label={title}>
      <header className="column-head">
        <h2>{title}</h2>
        <span className="count">{count}</span>
      </header>
      {hint ? <p className="column-hint">{hint}</p> : null}
      <div className="column-body">{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }): ReactElement {
  return <p className="empty">{children}</p>;
}

export interface IssueCardProps {
  readonly issue: DashboardIssue;
  readonly selected: boolean;
  readonly onSelect: (issueNumber: number) => void;
}

export function IssueCard({ issue, selected, onSelect }: IssueCardProps): ReactElement {
  const checks = issue.checkSummary;
  const prs = issue.timeline.flatMap((entry) => entry.artifacts?.prs ?? []);
  const moved = age(issue.lastActivityAt ?? issue.updatedAt);
  const live = issue.column === 'human' ? issue.needsHumanDecision : null;
  const trail = trailOf(issue);
  const question = issue.column === 'human' ? (issue.needsHumanDecision ?? 'Handed to you without a question — decide what happens next.') : null;

  return (
    <button
      type="button"
      className="card"
      data-accent={issue.column}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect(issue.number)}
    >
      <div className="card-top">
        <span className="num">#{issue.number}</span>
        <span className="card-age">{moved}</span>
      </div>
      <span className="card-title">{issue.title}</span>
      <div className="card-meta">
        <span className="trail">
          {trail.from}
          {trail.to !== null ? (
            <>
              <Arrow />
              {trail.to}
            </>
          ) : null}
        </span>
        {checks.failure > 0 ? (
          <span className="check bad">
            <i className="dot" aria-hidden="true" />
            {checks.failure} failing
          </span>
        ) : null}
        {checks.success > 0 ? (
          <span className="check good">
            <i className="dot" aria-hidden="true" />
            {checks.success} passing
          </span>
        ) : null}
        {prs.length > 0 ? <span className="check">{prs.length} PR</span> : null}
      </div>
      {question ? <p className="card-ask">{question}</p> : null}
      {!question && issue.column === 'blocked' && issue.blockedReason && !issue.conflict ? (
        <p className="card-ask">{issue.blockedReason}</p>
      ) : null}
      {issue.conflict ? <p className="flag">conflicting ball labels</p> : null}
      {issue.drift && !issue.conflict ? <p className="flag">labels disagree with the timeline</p> : null}
      {issue.problems.length > 0 ? <p className="flag">{issue.problems.length} unreadable record(s)</p> : null}
    </button>
  );
}

export function CommandBox({ command }: { command: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      // Clipboard access can be denied; the command stays visible for manual copy.
    }
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="cmd">
      <code>{command}</code>
      <button type="button" className="cmd-copy" onClick={() => void copy()}>
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  );
}

function Artifacts({ entry }: { entry: TimelineEntry }): ReactElement | null {
  const artifacts = entry.artifacts;
  if (!artifacts) return null;
  const rows: ReactElement[] = [];
  for (const pr of artifacts.prs) {
    rows.push(
      <li key={`pr-${pr}`}>
        <span className="art-kind">PR</span>
        <a href={pr} target="_blank" rel="noreferrer">
          {pr.replace(/^https?:\/\/github\.com\//, '')} ↗
        </a>
      </li>,
    );
  }
  for (const branch of artifacts.branches) {
    rows.push(
      <li key={`branch-${branch}`}>
        <span className="art-kind">branch</span>
        <code>{branch}</code>
      </li>,
    );
  }
  for (const check of artifacts.checks) {
    rows.push(
      <li key={`check-${check.name}`}>
        <span className="art-kind">check</span>
        <span className="check" data-status={check.status}>
          {check.status}
        </span>
        <span>{check.name}</span>
      </li>,
    );
  }
  for (const file of artifacts.files) {
    rows.push(
      <li key={`file-${file}`}>
        <span className="art-kind">file</span>
        <code>{file}</code>
      </li>,
    );
  }
  if (rows.length === 0) return null;
  return <ul className="artifacts">{rows}</ul>;
}

function TimelineItem({ entry }: { entry: TimelineEntry }): ReactElement {
  const move =
    entry.type === 'handoff'
      ? `${who(entry.actor)} → ${who(entry.to)}`
      : entry.type === 'claim'
        ? `by ${entry.actor}`
        : entry.type === 'block'
          ? `by ${entry.actor}`
          : `by ${entry.actor}`;
  return (
    <li className="tl" data-type={entry.type}>
      <div className="tl-head">
        <span className="tl-type">{entry.type}</span>
        <span className="tl-move">{move}</span>
        <time dateTime={entry.at} title={clockTime(entry.at)}>
          {age(entry.at)}
        </time>
      </div>
      {entry.summary ? <p className="tl-text">{entry.summary}</p> : null}
      {entry.reason ? <p className="tl-text">{entry.reason}</p> : null}
      {entry.note ? <p className="tl-text">{entry.note}</p> : null}
      {entry.needsHumanDecision ? (
        <p className="tl-ask">Needs your decision: {entry.needsHumanDecision}</p>
      ) : null}
      <Artifacts entry={entry} />
      {entry.url ? (
        <a className="tl-src" href={entry.url} target="_blank" rel="noreferrer">
          comment
        </a>
      ) : null}
    </li>
  );
}

export function suggestedCommand(issue: DashboardIssue): string {
  const lastAgent =
    [...issue.timeline]
      .reverse()
      .map((entry) => (entry.type === 'handoff' ? entry.actor : entry.type === 'claim' ? entry.actor : null))
      .find((name): name is string => name !== null && name !== 'human') ?? 'devin';

  switch (issue.column) {
    case 'human':
      return `agent-ball handoff --issue ${issue.number} --from human --to ${lastAgent} --summary "..."`;
    case 'agent':
      return `agent-ball next --agent ${issue.agent ?? 'devin'}`;
    case 'blocked':
      return `agent-ball resolve --issue ${issue.number} --to ${lastAgent} --note "..."`;
    case 'unassigned':
      return `agent-ball claim ${issue.number} --agent ${lastAgent}`;
  }
}

export interface DetailPanelProps {
  readonly issue: DashboardIssue;
  readonly onClose: () => void;
}

export function DetailPanel({ issue, onClose }: DetailPanelProps): ReactElement {
  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside className="panel" role="dialog" aria-modal="true" aria-labelledby="panel-title">
        <header className="panel-head">
          <div className="panel-kicker">
            <span className="num">#{issue.number}</span>
            <StateChip issue={issue} />
          </div>
          <h2 id="panel-title">{issue.title}</h2>
          <div className="panel-actions">
            <a className="link" href={issue.url} target="_blank" rel="noreferrer">
              Open on GitHub
            </a>
            <button type="button" className="btn" onClick={onClose}>
              Close · esc
            </button>
          </div>
        </header>

        {issue.conflict ? (
          <p className="notice bad">
            Ball labels conflict ({issue.conflict.join(', ')}). A human must leave exactly one ball label
            before the engine will move this issue.
          </p>
        ) : null}
        {issue.drift && !issue.conflict ? (
          <p className="notice">
            The latest record and the labels disagree. Labels win; fix the issue or re-post the record.
          </p>
        ) : null}
        {issue.problems.length > 0 ? (
          <div className="notice bad">
            <p>{issue.problems.length} record(s) in this thread cannot be read:</p>
            <ul>
              {issue.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <section className="panel-section">
          <h3>Next move</h3>
          <CommandBox command={suggestedCommand(issue)} />
        </section>

        <section className="panel-section">
          <h3>
            Timeline <span className="section-count">{issue.timeline.length}</span>
          </h3>
          {issue.timeline.length === 0 ? (
            <p className="empty">No records yet. The labels are the only signal.</p>
          ) : (
            <ol className="timeline">
              {issue.timeline.map((entry) => (
                <TimelineItem key={entry.id} entry={entry} />
              ))}
            </ol>
          )}
        </section>

        <section className="panel-section">
          <h3>Labels</h3>
          <div className="labels">
            {issue.labels.length === 0 ? (
              <span className="empty">none</span>
            ) : (
              issue.labels.map((label) => (
                <span key={label} className="label" data-ball={label.startsWith('ball:') ? 'true' : undefined}>
                  {label}
                </span>
              ))
            )}
          </div>
        </section>

        <footer className="panel-foot">
          last updated <time dateTime={issue.updatedAt}>{issue.updatedAt ? clockTime(issue.updatedAt) : 'unknown'}</time>
        </footer>
      </aside>
    </>
  );
}
