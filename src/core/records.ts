import { isOwnerName } from './labels';
import type { AgentBallErrorCode } from './errors';
import type {
  Artifacts,
  CheckRef,
  CheckStatus,
  HandoffRecord,
  TurnRecord,
} from './types';
import { EMPTY_ARTIFACTS } from './types';

/**
 * The machine-readable part of a comment. It is an HTML comment so GitHub does
 * not render it, and it stays inside the comment even when a human edits the
 * prose above it.
 *
 *     <!-- agent-ball:v1
 *     { "type": "handoff", ... }
 *     -->
 */
export const RECORD_MARKER = 'agent-ball:v1';

const RECORD_RE = /<!--\s*agent-ball:v1\s*\r?\n?([\s\S]*?)-->/g;

const CHECK_STATUSES: ReadonlySet<string> = new Set<CheckStatus>([
  'success',
  'failure',
  'pending',
  'neutral',
  'skipped',
]);

export interface ParseProblem {
  readonly at: number;
  readonly code: AgentBallErrorCode | 'invalid-json' | 'invalid-record';
  readonly message: string;
  readonly raw: string;
}

export interface ParsedBody {
  readonly records: TurnRecord[];
  readonly problems: ParseProblem[];
}

/** JSON that cannot close the HTML comment early. */
function toCommentJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/-->/g, '--\\u003e');
}

export function serializeRecord(record: TurnRecord): string {
  return `<!-- ${RECORD_MARKER}\n${toCommentJson(record)}\n-->`;
}

export interface FormatOptions {
  /** Include the machine block. Off for previews and tests of the prose only. */
  readonly machine?: boolean;
}

/** Renders a record as a GitHub comment: readable prose plus the machine block. */
export function formatRecord(record: TurnRecord, options: FormatOptions = {}): string {
  const machine = options.machine === false ? '' : `\n\n${serializeRecord(record)}`;
  return `${escapeProse(prose(record))}${machine}\n`;
}

/**
 * A summary is arbitrary text. If it carried a comment marker, the prose above
 * the machine block could forge a record, so the two sequences that open and
 * close an HTML comment are written as entities; GitHub renders them normally.
 */
function escapeProse(text: string): string {
  return text.replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;');
}

function prose(record: TurnRecord): string {
  switch (record.type) {
    case 'handoff':
      return handoffProse(record);
    case 'claim':
      return [heading(`Picked up · ${record.agent}`), '', record.summary?.trim() || 'Taking the ball.'].join('\n');
    case 'block':
      return [
        heading(`Blocked · ${record.actor}`),
        '',
        record.reason.trim(),
        '',
        '_Resolve this to put the ball back in play._',
      ].join('\n');
    case 'resolve':
      return [
        heading(`Unblocked · ${record.actor}`),
        '',
        record.note?.trim() || `Ball is back with ${record.to === 'human' ? 'a human' : `agent ${record.to}`}.`,
      ].join('\n');
  }
}

function heading(text: string): string {
  return `### ${text}`;
}

function handoffProse(record: HandoffRecord): string {
  const lines: string[] = [heading(`Handoff · ${record.from} → ${record.to}`), '', record.summary.trim()];

  const artifacts = artifactLines(record.artifacts);
  if (artifacts.length > 0) {
    lines.push('', '**Artifacts**', ...artifacts);
  }
  if (record.needsHumanDecision) {
    lines.push('', `**Needs your decision:** ${record.needsHumanDecision}`);
  }
  return lines.join('\n');
}

function artifactLines(artifacts: Artifacts): string[] {
  const lines: string[] = [];
  for (const pr of artifacts.prs) lines.push(`- PR ${pr}`);
  for (const branch of artifacts.branches) lines.push(`- Branch \`${branch}\``);
  for (const check of artifacts.checks) {
    lines.push(`- Check \`${check.name}\` · ${check.status}${check.url ? ` — ${check.url}` : ''}`);
  }
  for (const file of artifacts.files) lines.push(`- File \`${file}\``);
  return lines;
}

/** One-line description used by the CLI. */
export function describeRecord(record: TurnRecord): string {
  switch (record.type) {
    case 'handoff':
      return `handoff ${record.from} → ${record.to}: ${firstLine(record.summary)}`;
    case 'claim':
      return `claim by ${record.agent}${record.summary ? `: ${firstLine(record.summary)}` : ''}`;
    case 'block':
      return `blocked by ${record.actor}: ${firstLine(record.reason)}`;
    case 'resolve':
      return `unblocked by ${record.actor} → ${record.to}`;
  }
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 100 ? `${line.slice(0, 97)}...` : line;
}

/** Extracts every agent-ball record from a comment body. */
export function parseRecords(body: string): ParsedBody {
  const records: TurnRecord[] = [];
  const problems: ParseProblem[] = [];

  RECORD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RECORD_RE.exec(body)) !== null) {
    const raw = match[1] ?? '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      problems.push({
        at: match.index,
        code: 'invalid-json',
        message: `agent-ball record is not valid JSON: ${(error as Error).message}`,
        raw,
      });
      continue;
    }
    const result = validateRecord(parsed);
    if (result.ok) {
      records.push(result.record);
    } else {
      problems.push({ at: match.index, code: result.code, message: result.message, raw });
    }
  }

  return { records, problems };
}

export type ValidationResult =
  | { readonly ok: true; readonly record: TurnRecord }
  | { readonly ok: false; readonly code: AgentBallErrorCode | 'invalid-record'; readonly message: string };

function invalid(message: string): ValidationResult {
  return { ok: false, code: 'invalid-record', message };
}

/**
 * Validates a decoded record. Unknown extra fields are ignored so a newer writer
 * does not break an older reader; a wrong or missing field is an error.
 */
export function validateRecord(value: unknown): ValidationResult {
  if (typeof value !== 'object' || value === null) return invalid('record must be an object');
  const raw = value as Record<string, unknown>;
  const type = raw.type;
  if (typeof type !== 'string') return invalid('record.type must be a string');

  const base = validateBase(raw);
  if (base) return invalid(base);

  switch (type) {
    case 'handoff':
      return validateHandoff(raw);
    case 'claim': {
      const agent = raw.agent;
      if (typeof agent !== 'string' || !isOwnerName(agent) || agent === 'human') {
        return invalid('claim.agent must be an agent name');
      }
      const summary = raw.summary;
      if (summary !== null && summary !== undefined && typeof summary !== 'string') {
        return invalid('claim.summary must be a string or null');
      }
      return {
        ok: true,
        record: {
          type: 'claim',
          id: raw.id as string,
          issue: raw.issue as number,
          at: raw.at as string,
          agent,
          summary: typeof summary === 'string' ? summary : null,
        },
      };
    }
    case 'block': {
      const actor = raw.actor;
      const reason = raw.reason;
      if (typeof actor !== 'string' || actor.trim() === '') return invalid('block.actor is required');
      if (!isOwnerName(actor)) return invalid('block.actor must be "human" or an agent name');
      if (typeof reason !== 'string' || reason.trim() === '') return invalid('block.reason is required');
      return {
        ok: true,
        record: {
          type: 'block',
          id: raw.id as string,
          issue: raw.issue as number,
          at: raw.at as string,
          actor,
          reason,
        },
      };
    }
    case 'resolve': {
      const actor = raw.actor;
      const to = raw.to;
      const note = raw.note;
      if (typeof actor !== 'string' || actor.trim() === '') return invalid('resolve.actor is required');
      if (typeof to !== 'string' || !isOwnerName(to)) return invalid('resolve.to must be "human" or an agent name');
      if (note !== null && note !== undefined && typeof note !== 'string') {
        return invalid('resolve.note must be a string or null');
      }
      return {
        ok: true,
        record: {
          type: 'resolve',
          id: raw.id as string,
          issue: raw.issue as number,
          at: raw.at as string,
          actor,
          to,
          note: typeof note === 'string' ? note : null,
        },
      };
    }
    default:
      return invalid(`unknown record type "${type}"`);
  }
}

function validateBase(raw: Record<string, unknown>): string | null {
  if (typeof raw.id !== 'string' || raw.id.trim() === '') return 'record.id is required';
  if (typeof raw.issue !== 'number' || !Number.isInteger(raw.issue) || raw.issue <= 0) {
    return 'record.issue must be a positive integer';
  }
  if (typeof raw.at !== 'string' || Number.isNaN(Date.parse(raw.at))) {
    return 'record.at must be an ISO timestamp';
  }
  return null;
}

function validateHandoff(raw: Record<string, unknown>): ValidationResult {
  const from = raw.from;
  const to = raw.to;
  const summary = raw.summary;
  if (typeof from !== 'string' || !isOwnerName(from)) return invalid('handoff.from must be "human" or an agent name');
  if (typeof to !== 'string' || !isOwnerName(to)) return invalid('handoff.to must be "human" or an agent name');
  if (typeof summary !== 'string' || summary.trim() === '') return invalid('handoff.summary is required');
  if (from === to) return invalid('handoff.from and handoff.to must differ');

  const needs = raw.needsHumanDecision;
  if (needs !== null && needs !== undefined && typeof needs !== 'string') {
    return invalid('handoff.needsHumanDecision must be a string or null');
  }

  const artifacts = validateArtifacts(raw.artifacts);
  if (!artifacts.ok) return invalid(artifacts.message);

  return {
    ok: true,
    record: {
      type: 'handoff',
      id: raw.id as string,
      issue: raw.issue as number,
      at: raw.at as string,
      from,
      to,
      summary,
      artifacts: artifacts.artifacts,
      needsHumanDecision: typeof needs === 'string' && needs.trim() !== '' ? needs : null,
    },
  };
}

type ArtifactsResult =
  | { readonly ok: true; readonly artifacts: Artifacts }
  | { readonly ok: false; readonly message: string };

function validateArtifacts(value: unknown): ArtifactsResult {
  if (value === undefined || value === null) return { ok: true, artifacts: EMPTY_ARTIFACTS };
  if (typeof value !== 'object') return { ok: false, message: 'handoff.artifacts must be an object' };
  const raw = value as Record<string, unknown>;

  const strings = (field: string): string[] | string => {
    const input = raw[field];
    if (input === undefined || input === null) return [];
    if (!Array.isArray(input) || input.some((item) => typeof item !== 'string')) {
      return `handoff.artifacts.${field} must be an array of strings`;
    }
    return input as string[];
  };

  const prs = strings('prs');
  if (typeof prs === 'string') return { ok: false, message: prs };
  const branches = strings('branches');
  if (typeof branches === 'string') return { ok: false, message: branches };
  const files = strings('files');
  if (typeof files === 'string') return { ok: false, message: files };

  const checksInput = raw.checks;
  const checks: CheckRef[] = [];
  if (checksInput !== undefined && checksInput !== null) {
    if (!Array.isArray(checksInput)) return { ok: false, message: 'handoff.artifacts.checks must be an array' };
    for (const item of checksInput) {
      if (typeof item !== 'object' || item === null) {
        return { ok: false, message: 'each check must be an object' };
      }
      const check = item as Record<string, unknown>;
      if (typeof check.name !== 'string' || check.name.trim() === '') {
        return { ok: false, message: 'check.name is required' };
      }
      if (typeof check.status !== 'string' || !CHECK_STATUSES.has(check.status)) {
        return { ok: false, message: `check.status must be one of ${[...CHECK_STATUSES].join(', ')}` };
      }
      const url = typeof check.url === 'string' ? check.url : undefined;
      checks.push(url === undefined
        ? { name: check.name, status: check.status as CheckStatus }
        : { name: check.name, status: check.status as CheckStatus, url });
    }
  }

  return { ok: true, artifacts: { prs, branches, checks, files } };
}
