import { describe, expect, it } from 'vitest';
import {
  MockAdapter,
  acquireLock,
  formatLockComment,
  parseLockComment,
  releaseLock,
  withLock,
} from '../src/core';

const NOW = new Date('2026-11-21T10:00:00.000Z');

function makeAdapter(): MockAdapter {
  return new MockAdapter({ repo: 'o/r', now: NOW, seed: [{ number: 1, title: 'one' }] });
}

function lockComments(adapter: MockAdapter) {
  return adapter.allComments(1).map((comment) => parseLockComment(comment)).filter((lock) => lock !== null);
}

describe('lock lease', () => {
  it('acquires a free issue and leaves one lease behind', async () => {
    const adapter = makeAdapter();
    const result = await acquireLock(adapter, { issue: 1, holder: 'devin', now: NOW, nonce: 'a' });
    expect(result.ok).toBe(true);
    expect(lockComments(adapter)).toHaveLength(1);
    expect(lockComments(adapter)[0]?.holder).toBe('devin');
  });

  it('rejects the second agent and withdraws its lease', async () => {
    const adapter = makeAdapter();
    const first = await acquireLock(adapter, { issue: 1, holder: 'devin', now: NOW, nonce: 'a' });
    const second = await acquireLock(adapter, {
      issue: 1,
      holder: 'codex',
      now: new Date(NOW.getTime() + 1000),
      nonce: 'b',
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.heldBy).toBe('devin');
      expect(second.expiresAt).toBe(first.ok ? first.lease.expiresAt : '');
    }
    expect(lockComments(adapter)).toHaveLength(1);
    expect(adapter.calls.filter((call) => call.op === 'deleteComment')).toHaveLength(1);
  });

  it('lets the next agent in after the holder releases', async () => {
    const adapter = makeAdapter();
    const first = await acquireLock(adapter, { issue: 1, holder: 'devin', now: NOW, nonce: 'a' });
    if (!first.ok) throw new Error('first acquire failed');
    await releaseLock(adapter, first.lease);
    expect(lockComments(adapter)).toHaveLength(0);

    const second = await acquireLock(adapter, { issue: 1, holder: 'codex', now: NOW, nonce: 'b' });
    expect(second.ok).toBe(true);
  });

  it('ignores and cleans up an expired lease', async () => {
    const adapter = makeAdapter();
    adapter.injectComment(
      1,
      formatLockComment({
        nonce: 'stale',
        holder: 'blob',
        issue: 1,
        createdAt: new Date(NOW.getTime() - 600_000).toISOString(),
        expiresAt: new Date(NOW.getTime() - 300_000).toISOString(),
      }),
      'blob',
    );
    const result = await acquireLock(adapter, { issue: 1, holder: 'devin', now: NOW, nonce: 'a' });
    expect(result.ok).toBe(true);
    const holders = lockComments(adapter).map((lock) => lock?.holder);
    expect(holders).toEqual(['devin']);
  });

  it('converges when two agents acquire at the same instant', async () => {
    const adapter = makeAdapter();
    let firstListing = true;
    const box: { second: Awaited<ReturnType<typeof acquireLock>> | null } = { second: null };

    adapter.hooks.beforeListComments = async () => {
      if (!firstListing) return;
      firstListing = false;
      box.second = await acquireLock(adapter, { issue: 1, holder: 'codex', now: NOW, nonce: 'b' });
    };

    const first = await acquireLock(adapter, { issue: 1, holder: 'devin', now: NOW, nonce: 'a' });

    expect(first.ok).toBe(true);
    expect(box.second).not.toBeNull();
    expect(box.second?.ok).toBe(false);
    if (box.second && !box.second.ok) expect(box.second.heldBy).toBe('devin');

    const holders = lockComments(adapter).map((lock) => lock?.holder);
    expect(holders).toEqual(['devin']);
  });

  it('releases the lease when the body throws', async () => {
    const adapter = makeAdapter();
    await expect(
      withLock(adapter, { issue: 1, holder: 'devin', now: NOW, nonce: 'a' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(lockComments(adapter)).toHaveLength(0);
  });

  it('parses only well-formed leases', () => {
    const body = formatLockComment({
      nonce: 'n',
      holder: 'devin',
      issue: 1,
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 1000).toISOString(),
    });
    const comment = { id: '9', body, author: 'devin', createdAt: NOW.toISOString(), url: null };
    expect(parseLockComment(comment)?.holder).toBe('devin');
    expect(parseLockComment({ ...comment, body: 'plain comment' })).toBeNull();
    expect(parseLockComment({ ...comment, body: '<!-- agent-ball:lock v1\n{ nope }\n-->' })).toBeNull();
    expect(
      parseLockComment({
        ...comment,
        body: '<!-- agent-ball:lock v1\n{"nonce":"n","holder":"d"}\n-->',
      }),
    ).toBeNull();
  });
});
