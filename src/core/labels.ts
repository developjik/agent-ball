import type { BallOwner, TurnState } from './types';

export const BALL_PREFIX = 'ball:';
export const HUMAN_LABEL = 'ball:human';
export const BLOCKED_LABEL = 'ball:blocked';
export const AGENT_LABEL_PREFIX = 'ball:agent:';

/** Names that cannot be agent names because they would read as a state. */
export const RESERVED_OWNER_NAMES: ReadonlySet<string> = new Set([
  'human',
  'blocked',
  'unassigned',
  'none',
  'ball',
]);

const AGENT_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,37}$/;

/** Agent names become part of a label, so they stay short and lowercase. */
export function isAgentName(name: string): boolean {
  return AGENT_NAME_RE.test(name) && !RESERVED_OWNER_NAMES.has(name);
}

export function assertAgentName(name: string): string {
  if (!isAgentName(name)) {
    throw new Error(
      `invalid agent name "${name}": use 1-38 lowercase letters, digits, '.', '_' or '-', and avoid reserved names (${[...RESERVED_OWNER_NAMES].join(', ')})`,
    );
  }
  return name;
}

/** Whether a string can address a ball owner ("human" or a valid agent name). */
export function isOwnerName(name: string): boolean {
  return name === 'human' || isAgentName(name);
}

export function agentLabel(agent: string): string {
  return `${AGENT_LABEL_PREFIX}${assertAgentName(agent)}`;
}

export function isBallLabel(label: string): boolean {
  return label.startsWith(BALL_PREFIX);
}

/** The label set that represents a turn state. */
export function labelsForState(state: TurnState): string[] {
  switch (state.phase) {
    case 'unassigned':
      return [];
    case 'agent':
      return [agentLabel(state.agent)];
    case 'human':
      return [HUMAN_LABEL];
    case 'blocked':
      return [BLOCKED_LABEL];
  }
}

/** The ball labels carried by an issue, in label order. */
export function ballLabels(labels: readonly string[]): string[] {
  return labels.filter(isBallLabel);
}

export type LabelOwner =
  | { readonly kind: 'unassigned' }
  | { readonly kind: 'human' }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'agent'; readonly agent: string }
  | { readonly kind: 'conflict'; readonly labels: string[] };

/**
 * Reads the owner from labels. More than one ball label, or a ball label we do
 * not recognise, is a conflict: the engine refuses to move a ball it cannot
 * read rather than guessing.
 */
export function ownerFromLabels(labels: readonly string[]): LabelOwner {
  const ball = ballLabels(labels);
  const recognised: string[] = [];
  let agent: string | null = null;

  for (const label of ball) {
    if (label === HUMAN_LABEL || label === BLOCKED_LABEL) {
      recognised.push(label);
      continue;
    }
    if (label.startsWith(AGENT_LABEL_PREFIX)) {
      const name = label.slice(AGENT_LABEL_PREFIX.length);
      if (isAgentName(name)) {
        recognised.push(label);
        agent = name;
        continue;
      }
    }
    // A ball: label we cannot interpret is itself a conflict.
    recognised.push(label);
  }

  if (recognised.length === 0) return { kind: 'unassigned' };
  if (recognised.length > 1) return { kind: 'conflict', labels: ball };
  const only = recognised[0] as string;
  if (only === HUMAN_LABEL) return { kind: 'human' };
  if (only === BLOCKED_LABEL) return { kind: 'blocked' };
  if (agent !== null && only === `${AGENT_LABEL_PREFIX}${agent}`) return { kind: 'agent', agent };
  return { kind: 'conflict', labels: ball };
}

/** The owner name an actor uses in events ("human", the agent's name, or a state). */
export function ownerName(state: TurnState): string {
  switch (state.phase) {
    case 'unassigned':
      return 'unassigned';
    case 'agent':
      return state.agent;
    case 'human':
      return 'human';
    case 'blocked':
      return 'blocked';
  }
}

export interface LabelDiff {
  readonly add: string[];
  readonly remove: string[];
}

/**
 * Ball-label changes that move an issue from `current` to `next`. Labels outside
 * the ball namespace are never touched.
 */
export function ballLabelDiff(current: readonly string[], next: readonly string[]): LabelDiff {
  const have = new Set(ballLabels(current));
  const want = new Set(ballLabels(next));
  const add = [...want].filter((label) => !have.has(label));
  const remove = [...have].filter((label) => !want.has(label));
  return { add, remove };
}
