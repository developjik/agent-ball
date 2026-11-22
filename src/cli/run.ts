import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { IssueAdapter } from '../core/adapter';
import { createDemoAdapter, DEMO_REPO } from '../core/demo';
import { AgentBallEngine, type TurnOutcome } from '../core/engine';
import { GitHubIssueAdapter, createGhRunner, type GhRunner } from '../core/github-adapter';
import { isAgentName, isOwnerName } from '../core/labels';
import { startServer } from '../server';
import { formatBoard, formatOutcome, ownerLabel, relativeTime, truncate } from './format';

export interface CliIO {
  out(line: string): void;
  err(line: string): void;
}

export interface CliDeps {
  readonly io?: CliIO;
  readonly adapter?: IssueAdapter;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly env?: NodeJS.ProcessEnv;
  readonly runGh?: GhRunner;
  /** Built dashboard directory; tests pass an empty temp dir or null. */
  readonly webDir?: string | null;
  /** Serve without blocking (tests). */
  readonly onServed?: (server: { readonly url: string; close(): Promise<void> }) => void;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

interface ParsedArgs {
  readonly command: string;
  readonly positionals: string[];
  readonly values: Map<string, string[]>;
  readonly bools: Set<string>;
}

const KNOWN_FLAGS: Record<string, { value: string[]; bool: string[] }> = {
  status: { value: ['repo', 'limit'], bool: ['json', 'demo', 'help'] },
  next: { value: ['agent', 'repo', 'limit'], bool: ['json', 'demo', 'help'] },
  claim: { value: ['issue', 'agent', 'summary', 'repo'], bool: ['json', 'demo', 'help'] },
  handoff: {
    value: ['issue', 'from', 'to', 'summary', 'pr', 'branch', 'check', 'file', 'needs-human', 'repo'],
    bool: ['json', 'demo', 'help'],
  },
  block: { value: ['issue', 'actor', 'reason', 'repo'], bool: ['json', 'demo', 'help'] },
  resolve: { value: ['issue', 'actor', 'to', 'note', 'repo'], bool: ['json', 'demo', 'help'] },
  labels: { value: ['agents', 'repo'], bool: ['help'] },
  serve: { value: ['port', 'host', 'repo', 'limit'], bool: ['demo', 'open', 'help'] },
  help: { value: [], bool: [] },
  version: { value: [], bool: [] },
};

export const USAGE = `agent-ball — turn-taking for agents and humans on GitHub Issues

Usage
  agent-ball <command> [options]

Commands
  status                     Who holds which ball, grouped by column
  next --agent <name>        What this agent should pick up next
  claim <issue> --agent <name> [--summary <text>]
                             Pick up an unassigned ball
  handoff --issue <n> --to <owner> --summary <text>
          [--from <owner>]   Hand the ball over ("human" or an agent name)
          [--pr <url>] [--branch <name>] [--check <name=status>] [--file <path>]
          [--needs-human <question>]   Question for the human; must be non-empty
  block --issue <n> --reason <text> [--actor <owner>]
                             Park a ball until a blocker is resolved
  resolve --issue <n> --to <owner> [--actor <owner>] [--note <text>]
                             Put a parked ball back in play
  labels --agents devin,codex
                             Create the ball:* labels in the repository
  serve [--demo] [--port 4747]
                             Human-in-the-loop dashboard

Options
  --repo <owner/name>        Repository (default: $AGENT_BALL_REPO or the current checkout)
  --json                     Machine-readable output
  --demo                     Use the built-in demo board, no repo reads
  -h, --help

Examples
  agent-ball status
  agent-ball handoff --issue 12 --to human --summary "Adapter retries are fixed; decide on the flag" \\
    --pr https://github.com/developjik/agent-ball/pull/4 --check ci=success --needs-human "Ship behind a flag?"
  agent-ball next --agent devin
`;

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const io = deps.io ?? defaultIo();
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`agent-ball: ${error.message}`);
      io.err('run `agent-ball help` for usage');
      return 2;
    }
    throw error;
  }

  const command = args.command === '' ? 'help' : args.command;

  try {
    const known = KNOWN_FLAGS[command];
    if (!known) {
      io.err(`agent-ball: unknown command "${command}"`);
      io.err('run `agent-ball help` for usage');
      return 2;
    }
    if (args.bools.has('help') || command === 'help') {
      io.out(USAGE);
      return 0;
    }
    if (command === 'version') {
      io.out(version());
      return 0;
    }
    assertKnownFlags(args, known);

    switch (command) {
      case 'status':
        return await commandStatus(args, deps, io);
      case 'next':
        return await commandNext(args, deps, io);
      case 'claim':
        return await commandClaim(args, deps, io);
      case 'handoff':
        return await commandHandoff(args, deps, io);
      case 'block':
        return await commandBlock(args, deps, io);
      case 'resolve':
        return await commandResolve(args, deps, io);
      case 'labels':
        return await commandLabels(args, deps, io);
      case 'serve':
        return await commandServe(args, deps, io);
      default:
        io.err(`agent-ball: unknown command "${command}"`);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`agent-ball: ${error.message}`);
      return 2;
    }
    io.err(`agent-ball: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function defaultIo(): CliIO {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}

function version(): string {
  return 'agent-ball 0.1.1';
}

function parseArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string[]>();
  const bools = new Set<string>();
  const positionals: string[] = [];
  let command = '';

  const argvCopy = [...argv];
  for (let index = 0; index < argvCopy.length; index += 1) {
    const token = argvCopy[index];
    if (token === undefined) continue;
    if (token === '--') {
      positionals.push(...argvCopy.slice(index + 1));
      break;
    }
    if (token.startsWith('--')) {
      const equals = token.indexOf('=');
      const key = equals === -1 ? token.slice(2) : token.slice(2, equals);
      if (key === '') throw new UsageError('empty option name');
      if (equals !== -1) {
        push(values, key, token.slice(equals + 1));
        continue;
      }
      const next = argvCopy[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        push(values, key, next);
        index += 1;
      } else {
        bools.add(key);
      }
      continue;
    }
    if (token === '-h') {
      bools.add('help');
      continue;
    }
    if (token.startsWith('-') && token !== '-') {
      throw new UsageError(`unknown option "${token}"`);
    }
    if (command === '') command = token;
    else positionals.push(token);
  }

  return { command, positionals, values, bools };
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

function assertKnownFlags(args: ParsedArgs, allowed: { value: string[]; bool: string[] }): void {
  const valueFlags = new Set(allowed.value);
  const boolFlags = new Set(allowed.bool);
  for (const key of args.values.keys()) {
    if (!valueFlags.has(key) && !boolFlags.has(key)) {
      throw new UsageError(`unknown option "--${key}" for "${args.command}"`);
    }
    if (boolFlags.has(key) && !valueFlags.has(key)) {
      throw new UsageError(`--${key} takes no value`);
    }
  }
  for (const key of args.bools) {
    if (!boolFlags.has(key) && !valueFlags.has(key)) {
      throw new UsageError(`unknown option "--${key}" for "${args.command}"`);
    }
  }
}

function one(args: ParsedArgs, key: string): string | undefined {
  return args.values.get(key)?.at(-1);
}

function many(args: ParsedArgs, key: string): string[] {
  return args.values.get(key) ?? [];
}

function has(args: ParsedArgs, key: string): boolean {
  return args.bools.has(key) || args.values.has(key);
}

function required(args: ParsedArgs, key: string): string {
  const value = one(args, key);
  if (value === undefined || value.trim() === '') throw new UsageError(`--${key} is required`);
  return value;
}

/** An optional flag that, once passed, must carry a non-empty value. */
function optionalNonEmpty(args: ParsedArgs, key: string): string | undefined {
  const value = one(args, key);
  if (value === undefined && args.bools.has(key)) throw new UsageError(`--${key} needs a value`);
  if (value !== undefined && value.trim() === '') throw new UsageError(`--${key} needs a non-empty value`);
  return value;
}

function integer(args: ParsedArgs, key: string, fallback: number): number {
  const raw = one(args, key);
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) throw new UsageError(`--${key} must be a non-negative integer`);
  return value;
}

function issueArg(args: ParsedArgs): number {
  const raw = args.positionals[0] ?? one(args, 'issue');
  if (raw === undefined) throw new UsageError('an issue number is required');
  const issue = Number.parseInt(raw.replace(/^#/, ''), 10);
  if (!Number.isInteger(issue) || issue <= 0) throw new UsageError(`"${raw}" is not an issue number`);
  return issue;
}

function requireOwner(name: string, what: string): string {
  if (!isOwnerName(name)) {
    throw new UsageError(`${what} must be "human" or an agent name, not "${name}"`);
  }
  return name;
}

interface Context {
  readonly engine: AgentBallEngine;
  readonly source: 'github' | 'demo';
  readonly adapter: IssueAdapter;
}

async function context(args: ParsedArgs, deps: CliDeps): Promise<Context> {
  const now = deps.now ?? (() => new Date());
  if (deps.adapter) {
    const engine = new AgentBallEngine({ adapter: deps.adapter, now, ...(deps.newId ? { newId: deps.newId } : {}) });
    return { engine, source: deps.adapter.name === 'github' ? 'github' : 'demo', adapter: deps.adapter };
  }
  if (has(args, 'demo')) {
    const adapter = createDemoAdapter(now());
    const engine = new AgentBallEngine({ adapter, now, ...(deps.newId ? { newId: deps.newId } : {}) });
    return { engine, source: 'demo', adapter };
  }
  const repo = await resolveRepo(args, deps);
  const runner = deps.runGh ?? createGhRunner(deps.env ?? process.env);
  const adapter = new GitHubIssueAdapter({ repo, run: runner });
  const engine = new AgentBallEngine({ adapter, now, ...(deps.newId ? { newId: deps.newId } : {}) });
  return { engine, source: 'github', adapter };
}

async function resolveRepo(args: ParsedArgs, deps: CliDeps): Promise<string> {
  const explicit = one(args, 'repo') ?? (deps.env ?? process.env).AGENT_BALL_REPO;
  if (explicit) return explicit;
  const runner = deps.runGh ?? createGhRunner(deps.env ?? process.env);
  try {
    const output = await runner(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
    const name = output.trim();
    if (name !== '') return name;
  } catch {
    // fall through to the usage error
  }
  throw new UsageError('no repository: pass --repo owner/name, set AGENT_BALL_REPO, or run inside a checkout');
}

async function commandStatus(args: ParsedArgs, deps: CliDeps, io: CliIO): Promise<number> {
  const contextValue = await context(args, deps);
  const limit = integer(args, 'limit', 100);
  const board = await contextValue.engine.board({ source: contextValue.source, limit });
  if (has(args, 'json')) {
    io.out(JSON.stringify(board, null, 2));
    return 0;
  }
  io.out(formatBoard(board, { width: terminalWidth(), now: deps.now?.() ?? new Date() }));
  return 0;
}

async function commandNext(args: ParsedArgs, deps: CliDeps, io: CliIO): Promise<number> {
  const agent = required(args, 'agent');
  if (!isAgentName(agent)) throw new UsageError(`"${agent}" is not a valid agent name`);
  const contextValue = await context(args, deps);
  const result = await contextValue.engine.nextFor(agent, { limit: integer(args, 'limit', 100) });
  const now = deps.now?.() ?? new Date();

  if (has(args, 'json')) {
    io.out(JSON.stringify({ agent, held: result.held, claimable: result.claimable }, null, 2));
    return 0;
  }
  if (result.held.length === 0 && result.claimable.length === 0) {
    io.out(`nothing for ${agent}: no held balls, no unassigned work`);
    return 0;
  }
  const lines: string[] = [];
  if (result.held.length > 0) {
    lines.push(`HELD BY ${agent.toUpperCase()} (${result.held.length})`);
    for (const snapshot of result.held) {
      const age = relativeTime(snapshot.records.at(-1)?.record.at ?? snapshot.updatedAt, now);
      lines.push(`  #${snapshot.number}  ${truncate(snapshot.title, 60)}${age ? `  ${age}` : ''}`);
    }
  }
  if (result.claimable.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`READY TO CLAIM (${result.claimable.length})`);
    for (const snapshot of result.claimable) {
      lines.push(`  #${snapshot.number}  ${truncate(snapshot.title, 60)}`);
    }
  }
  io.out(lines.join('\n'));
  return 0;
}

async function commandClaim(args: ParsedArgs, deps: CliDeps, io: CliIO): Promise<number> {
  const issue = issueArg(args);
  const agent = required(args, 'agent');
  const contextValue = await context(args, deps);
  const outcome = await contextValue.engine.claim({
    issue,
    agent,
    ...(one(args, 'summary') ? { summary: one(args, 'summary') as string } : {}),
  });
  return report(outcome, args, io);
}

async function commandHandoff(args: ParsedArgs, deps: CliDeps, io: CliIO): Promise<number> {
  const issue = issueArg(args);
  const to = requireOwner(required(args, 'to'), '--to');
  const summary = required(args, 'summary');
  const contextValue = await context(args, deps);
  const from = one(args, 'from')
    ? requireOwner(one(args, 'from') as string, '--from')
    : await inferActor(contextValue.engine, issue);

  const checks = many(args, 'check').map(parseCheck);
  const outcome = await contextValue.engine.handoff({
    issue,
    from,
    to,
    summary,
    artifacts: {
      prs: many(args, 'pr'),
      branches: many(args, 'branch'),
      checks,
      files: many(args, 'file'),
    },
    ...(optionalNonEmpty(args, 'needs-human') ? { needsHumanDecision: optionalNonEmpty(args, 'needs-human') as string } : {}),
  });
  return report(outcome, args, io);
}

async function commandBlock(args: ParsedArgs, deps: CliDeps, io: CliIO): Promise<number> {
  const issue = issueArg(args);
  const reason = required(args, 'reason');
  const contextValue = await context(args, deps);
  const actor = one(args, 'actor')
    ? requireOwner(one(args, 'actor') as string, '--actor')
    : await inferActor(contextValue.engine, issue);
  const outcome = await contextValue.engine.block({ issue, actor, reason });
  return report(outcome, args, io);
}

async function commandResolve(args: ParsedArgs, deps: CliDeps, io: CliIO): Promise<number> {
  const issue = issueArg(args);
  const to = requireOwner(required(args, 'to'), '--to');
  const actor = one(args, 'actor') ?? 'human';
  const contextValue = await context(args, deps);
  const outcome = await contextValue.engine.resolve({
    issue,
    actor,
    to,
    ...(one(args, 'note') ? { note: one(args, 'note') as string } : {}),
  });
  return report(outcome, args, io);
}

async function commandLabels(args: ParsedArgs, deps: CliDeps, io: CliIO): Promise<number> {
  const agents = (one(args, 'agents') ?? 'devin,codex,claude,damon')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  const invalid = agents.filter((name) => !isAgentName(name));
  if (invalid.length > 0) throw new UsageError(`invalid agent names: ${invalid.join(', ')}`);

  if (deps.adapter) throw new UsageError('labels can only be created against GitHub');
  const repo = await resolveRepo(args, deps);
  const runner = deps.runGh ?? createGhRunner(deps.env ?? process.env);
  const adapter = new GitHubIssueAdapter({ repo, run: runner });
  await adapter.ensureBallLabels(agents);
  io.out(`created ball labels on ${repo}: human, blocked, ${agents.map((name) => `agent:${name}`).join(', ')}`);
  return 0;
}

async function commandServe(args: ParsedArgs, deps: CliDeps, io: CliIO): Promise<number> {
  const contextValue = await context(args, deps);
  const port = integer(args, 'port', 4747);
  const host = one(args, 'host') ?? '127.0.0.1';
  const limit = integer(args, 'limit', 100);
  const staticDir = deps.webDir !== undefined ? deps.webDir : defaultWebDir();

  const server = await startServer({
    port,
    host,
    staticDir,
    loadBoard: () => contextValue.engine.board({ source: contextValue.source, limit }),
  });
  io.out(`agent-ball dashboard: ${server.url}`);
  io.out(`  board  ${server.url}/api/board`);
  io.out(`  repo   ${contextValue.adapter.repo ?? DEMO_REPO} (${contextValue.source})`);
  if (!staticDir) io.out('  ui     not built — run `pnpm build:web`');

  if (deps.onServed) {
    deps.onServed(server);
    return 0;
  }

  const stop = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return 0;
}

function parseCheck(raw: string): { name: string; status: 'success' | 'failure' | 'pending' | 'neutral' | 'skipped' } {
  const separator = raw.lastIndexOf('=');
  if (separator <= 0) throw new UsageError(`--check expects name=status, got "${raw}"`);
  const name = raw.slice(0, separator).trim();
  const status = raw.slice(separator + 1).trim();
  if (name === '') throw new UsageError('--check needs a name');
  if (status !== 'success' && status !== 'failure' && status !== 'pending' && status !== 'neutral' && status !== 'skipped') {
    throw new UsageError(`--check status must be success, failure, pending, neutral or skipped, got "${status}"`);
  }
  return { name, status };
}

async function inferActor(engine: AgentBallEngine, issue: number): Promise<string> {
  const snapshot = await engine.read(issue);
  if (snapshot.turn.phase === 'agent') return snapshot.turn.agent;
  if (snapshot.turn.phase === 'human') return 'human';
  throw new UsageError(`#${issue} has no holder yet; pass --from or claim it first`);
}

function report(outcome: TurnOutcome, args: ParsedArgs, io: CliIO): number {
  if (has(args, 'json')) {
    io.out(JSON.stringify(outcome, null, 2));
    return outcome.ok ? 0 : 1;
  }
  if (outcome.ok) {
    io.out(formatOutcome(outcome));
    return 0;
  }
  io.err(`agent-ball: ${formatOutcome(outcome)}`);
  return 1;
}

function terminalWidth(): number {
  const columns = process.stdout.columns;
  return Number.isFinite(columns) && columns !== undefined ? Math.min(120, Math.max(60, columns)) : 84;
}

/** `dist/web` next to the bundle, or the project's build output during development. */
function defaultWebDir(): string | null {
  const candidates = [new URL('./web/', import.meta.url), new URL('../dist/web/', import.meta.url)];
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate);
    if (existsSync(resolve(path, 'index.html'))) return path;
  }
  return null;
}
