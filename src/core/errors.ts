/** Error codes shared by the state machine, the engine and the CLI. */
export type AgentBallErrorCode =
  // State-machine codes.
  | 'invalid-agent'
  | 'invalid-actor'
  | 'invalid-target'
  | 'agent-held'
  | 'human-held'
  | 'blocked'
  | 'unassigned'
  | 'not-holder'
  | 'same-owner'
  | 'reason-required'
  | 'not-blocked'
  | 'label-conflict'
  // Engine and adapter codes.
  | 'state-changed'
  | 'lock-held'
  | 'adapter-error'
  | 'partial'
  | 'not-found'
  | 'usage';

export class AgentBallError extends Error {
  readonly code: AgentBallErrorCode;

  constructor(code: AgentBallErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AgentBallError';
    this.code = code;
  }
}

/** A write that landed only partially: labels moved but the comment did not. */
export class PartialWriteError extends AgentBallError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('partial', message, options);
    this.name = 'PartialWriteError';
  }
}
