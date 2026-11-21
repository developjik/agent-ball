import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Board, DashboardIssue } from '../core/board';
import { groupBoard } from '../core/board';
import { Column, DetailPanel, Empty, IssueCard, Mark } from './components';
import { loadBoard, type LoadedBoard } from './data';
import { age } from './time';

export function App(): React.ReactElement {
  const [loaded, setLoaded] = useState<LoadedBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    const next = await loadBoard();
    setLoaded(next);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setSelected(null);
        return;
      }
      const target = event.target as HTMLElement | null;
      const typing = target !== null && (target.tagName === 'INPUT' || target.isContentEditable);
      if (event.key === '/' && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const board = loaded?.board ?? null;
  const filtered = useMemo(() => (board ? applyFilters(board, query, agentFilter) : null), [board, query, agentFilter]);
  const groups = useMemo(() => (filtered ? groupBoard(filtered) : null), [filtered]);
  const selectedIssue = useMemo(
    () => filtered?.issues.find((issue) => issue.number === selected) ?? null,
    [filtered, selected],
  );

  const agents = useMemo(() => {
    const names = new Set<string>();
    for (const issue of board?.issues ?? []) if (issue.agent) names.add(issue.agent);
    return [...names].sort();
  }, [board]);

  return (
    <div className="app">
      <header className="masthead">
        <div className="brand">
          <Mark />
          <div>
            <h1>agent-ball</h1>
            <p className="tagline">who holds the ball, right now</p>
          </div>
        </div>
        <div className="masthead-side">
          <span className="repo">{board?.repo ?? '—'}</span>
          <span className="source" data-live={board?.source === 'github' ? 'true' : 'false'}>
            {board?.source === 'github' ? 'live' : 'demo board'}
          </span>
          <button type="button" className="btn" onClick={() => void refresh()} disabled={loading}>
            {loading ? 'reading…' : 'refresh'}
          </button>
        </div>
      </header>

      {board && board.source === 'demo' ? (
        <p className="banner">
          Showing sample issues. Run <code>pnpm serve</code> or <code>agent-ball serve --repo owner/name</code> to read a
          real repository.
        </p>
      ) : null}

      <section className="stats" aria-label="Board summary">
        <Stat label="needs you" value={board?.counts.human ?? 0} accent="human" />
        <Stat label="with agents" value={board?.counts.agent ?? 0} accent="agent" />
        <Stat label="blocked" value={board?.counts.blocked ?? 0} accent="blocked" />
        <Stat label="unassigned" value={board?.counts.unassigned ?? 0} accent="unassigned" />
        <div className="stat stamp">
          <span className="stamp-line">updated</span>
          <span className="stamp-value">
            {board ? age(board.generatedAt) : '—'}
            {board && board.source === 'demo' ? ' · demo' : ''}
          </span>
        </div>
      </section>

      <div className="controls">
        <label className="search">
          <span className="sr-only">Filter issues</span>
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder="Filter by title or #number"
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd>/</kbd>
        </label>
        <div className="chips" role="group" aria-label="Filter by agent">
          <button
            type="button"
            className="chip-btn"
            data-active={agentFilter === null ? 'true' : undefined}
            onClick={() => setAgentFilter(null)}
          >
            all
          </button>
          {agents.map((agent) => (
            <button
              key={agent}
              type="button"
              className="chip-btn"
              data-active={agentFilter === agent ? 'true' : undefined}
              onClick={() => setAgentFilter(agentFilter === agent ? null : agent)}
            >
              {agent}
            </button>
          ))}
        </div>
      </div>

      {!board && loading ? (
        <p className="loading">reading the board…</p>
      ) : !groups ? (
        <p className="loading">no board</p>
      ) : (
        <main className="board">
          <Column
            title="Needs your decision"
            accent="human"
            count={groups.human.length}
            hint="A handoff asked for a human call."
          >
            {groups.human.length === 0 ? (
              <Empty>Nothing waiting on you.</Empty>
            ) : (
              groups.human.map((issue) => (
                <IssueCard
                  key={issue.number}
                  issue={issue}
                  selected={selected === issue.number}
                  onSelect={setSelected}
                />
              ))
            )}
          </Column>

          <Column
            title="With agents"
            accent="agent"
            count={groups.agents.reduce((total, lane) => total + lane.issues.length, 0)}
            hint="Each agent works only inside its own lane."
          >
            {groups.agents.length === 0 ? (
              <Empty>No agent holds a ball.</Empty>
            ) : (
              groups.agents.map((lane) => (
                <div className="lane" key={lane.agent}>
                  <div className="lane-head">
                    <span>{lane.agent}</span>
                    <span className="lane-count">{lane.issues.length}</span>
                  </div>
                  {lane.issues.map((issue) => (
                    <IssueCard
                      key={issue.number}
                      issue={issue}
                      selected={selected === issue.number}
                      onSelect={setSelected}
                    />
                  ))}
                </div>
              ))
            )}
          </Column>

          <Column title="Blocked" accent="blocked" count={groups.blocked.length} hint="Parked until a blocker clears.">
            {groups.blocked.length === 0 ? (
              <Empty>Nothing blocked.</Empty>
            ) : (
              groups.blocked.map((issue) => (
                <IssueCard
                  key={issue.number}
                  issue={issue}
                  selected={selected === issue.number}
                  onSelect={setSelected}
                />
              ))
            )}
          </Column>

          <Column title="Unassigned" accent="unassigned" count={groups.unassigned.length} hint="Free for the next claim.">
            {groups.unassigned.length === 0 ? (
              <Empty>Every issue has an owner.</Empty>
            ) : (
              groups.unassigned.map((issue) => (
                <IssueCard
                  key={issue.number}
                  issue={issue}
                  selected={selected === issue.number}
                  onSelect={setSelected}
                />
              ))
            )}
          </Column>
        </main>
      )}

      <footer className="foot">
        <p>
          Protocol: <code>ball:human</code> · <code>ball:agent:&lt;name&gt;</code> · <code>ball:blocked</code>. One
          ball label at a time; the engine refuses to move a ball it cannot read.
        </p>
        <p className="foot-dim">
          <code>agent-ball status</code> for the terminal view · <code>agent-ball next --agent &lt;name&gt;</code> for
          the queue.
        </p>
      </footer>

      {selectedIssue ? <DetailPanel issue={selectedIssue} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent: string }): React.ReactElement {
  return (
    <div className="stat" data-accent={accent}>
      <span className="n">{value}</span>
      <span className="l">{label}</span>
    </div>
  );
}

function applyFilters(board: Board, query: string, agent: string | null): Board {
  const needle = query.trim().toLowerCase();
  const issues: DashboardIssue[] = board.issues.filter((issue) => {
    if (agent !== null && issue.agent !== agent) return false;
    if (needle === '') return true;
    return issue.title.toLowerCase().includes(needle) || `#${issue.number}`.includes(needle);
  });
  return {
    ...board,
    issues,
    counts: {
      human: issues.filter((issue) => issue.column === 'human').length,
      agent: issues.filter((issue) => issue.column === 'agent').length,
      blocked: issues.filter((issue) => issue.column === 'blocked').length,
      unassigned: issues.filter((issue) => issue.column === 'unassigned').length,
      total: issues.length,
    },
  };
}
