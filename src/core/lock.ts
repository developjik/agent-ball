import { randomUUID } from 'node:crypto';
import type { AdapterComment, IssueAdapter } from './adapter';

/**
 * A short lease on one issue, published as a comment so every agent reads the
 * same board. The winner is decided deterministically: of the leases still
 * alive, the one posted first (then the lowest comment id) holds the ball, and
 * every other claimant withdraws its comment.
 *
 * This is a compare-and-set over an append-only log rather than a server-side
 * mutex, which is what GitHub offers. It converges even when two agents post at
 * the same moment: both read both leases, both pick the same winner, and only
 * the winner keeps its claim.
 */
export interface LockRecord {
  readonly nonce: string;
  readonly holder: string;
  readonly issue: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly commentId: string;
}

export const LOCK_TTL_MS = 120_000;

const LOCK_RE = /<!--\s*agent-ball:lock v1\s*\r?\n?([\s\S]*?)-->/;

export function formatLockComment(lock: Omit<LockRecord, 'commentId'>): string {
  const payload = {
    nonce: lock.nonce,
    holder: lock.holder,
    issue: lock.issue,
    createdAt: lock.createdAt,
    expiresAt: lock.expiresAt,
  };
  return [
    `<!-- agent-ball:lock v1`,
    JSON.stringify(payload, null, 2).replace(/-->/g, '--\\u003e'),
    `-->`,
    '',
    `_agent-ball lock lease held by ${lock.holder} until ${lock.expiresAt}._`,
  ].join('\n');
}

export function parseLockComment(comment: AdapterComment): LockRecord | null {
  const match = LOCK_RE.exec(comment.body);
  if (!match) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(match[1] ?? '');
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null) return null;
  const raw = decoded as Record<string, unknown>;
  if (
    typeof raw.nonce !== 'string' ||
    typeof raw.holder !== 'string' ||
    typeof raw.issue !== 'number' ||
    typeof raw.createdAt !== 'string' ||
    typeof raw.expiresAt !== 'string'
  ) {
    return null;
  }
  if (Number.isNaN(Date.parse(raw.expiresAt)) || Number.isNaN(Date.parse(raw.createdAt))) return null;
  return {
    nonce: raw.nonce,
    holder: raw.holder,
    issue: raw.issue,
    createdAt: raw.createdAt,
    expiresAt: raw.expiresAt,
    commentId: comment.id,
  };
}

function compareLocks(a: LockRecord, b: LockRecord): number {
  const byTime = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (byTime !== 0) return byTime;
  const ida = Number.parseInt(a.commentId, 10);
  const idb = Number.parseInt(b.commentId, 10);
  if (Number.isNaN(ida) || Number.isNaN(idb)) return a.commentId.localeCompare(b.commentId);
  return ida - idb;
}

export type AcquireResult =
  | { readonly ok: true; readonly lease: LockRecord }
  | { readonly ok: false; readonly heldBy: string; readonly expiresAt: string };

export interface AcquireOptions {
  readonly issue: number;
  readonly holder: string;
  readonly ttlMs?: number;
  readonly now?: Date;
  readonly nonce?: string;
}

/** Posts a lease and keeps it only if no live lease got there first. */
export async function acquireLock(adapter: IssueAdapter, options: AcquireOptions): Promise<AcquireResult> {
  const now = options.now ?? new Date();
  const ttl = options.ttlMs ?? LOCK_TTL_MS;
  const nonce = options.nonce ?? randomUUID();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttl).toISOString();

  const comment = await adapter.addComment(
    adapter.repo === null ? options.issue : options.issue,
    formatLockComment({ nonce, holder: options.holder, issue: options.issue, createdAt, expiresAt }),
  );
  const mine: LockRecord = {
    nonce,
    holder: options.holder,
    issue: options.issue,
    createdAt,
    expiresAt,
    commentId: comment.id,
  };

  const comments = await adapter.listComments(options.issue);
  const nowMs = now.getTime();
  const live: LockRecord[] = [];
  const stale: LockRecord[] = [];
  for (const entry of comments) {
    const lock = parseLockComment(entry);
    if (lock === null || lock.issue !== options.issue) continue;
    if (lock.commentId === mine.commentId) continue;
    if (Date.parse(lock.expiresAt) > nowMs) live.push(lock);
    else stale.push(lock);
  }

  // Housekeeping: expired leases never block, but they clutter the thread.
  for (const lock of stale) {
    await adapter.deleteComment(options.issue, lock.commentId).catch(() => undefined);
  }

  live.sort(compareLocks);
  const winner = live[0];
  if (winner && compareLocks(winner, mine) < 0) {
    await adapter.deleteComment(options.issue, mine.commentId).catch(() => undefined);
    return { ok: false, heldBy: winner.holder, expiresAt: winner.expiresAt };
  }

  return { ok: true, lease: mine };
}

export async function releaseLock(adapter: IssueAdapter, lease: LockRecord): Promise<void> {
  await adapter.deleteComment(lease.issue, lease.commentId).catch(() => undefined);
}

export type LockedRun<T> =
  | { readonly ok: true; readonly value: T; readonly lease: LockRecord }
  | { readonly ok: false; readonly heldBy: string; readonly expiresAt: string };

/** Runs `body` while holding the issue lease, releasing it on every path. */
export async function withLock<T>(
  adapter: IssueAdapter,
  options: AcquireOptions,
  body: (lease: LockRecord) => Promise<T>,
): Promise<LockedRun<T>> {
  const acquired = await acquireLock(adapter, options);
  if (!acquired.ok) return acquired;
  try {
    const value = await body(acquired.lease);
    return { ok: true, value, lease: acquired.lease };
  } finally {
    await releaseLock(adapter, acquired.lease);
  }
}
