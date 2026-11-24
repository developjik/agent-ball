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
  it.each([-1000, 0, 1000, -300000, 300000])('respects the earlier server claim with client skew %i ms', async (skew) => {
    const adapter = makeAdapter();
    const first = await acquireLock(adapter, { issue: 1, holder: 'first', now: NOW, nonce: 'a' });
    const second = await acquireLock(adapter, { issue: 1, holder: 'second', now: new Date(NOW.getTime()+skew), nonce: 'b' });
    expect(first.ok).toBe(true); expect(second.ok).toBe(false);
    if (!second.ok) expect(second.heldBy).toBe('first');
    expect(lockComments(adapter)).toHaveLength(1);
  });

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

  it.each([-1000,0,1000])('chooses one owner when both see both claims with skew %i',async skew=>{
    const adapter=makeAdapter();let entered=false;let second:Awaited<ReturnType<typeof acquireLock>>|undefined;
    adapter.hooks.beforeListComments=async()=>{if(entered)return;entered=true;second=await acquireLock(adapter,{issue:1,holder:'second',now:new Date(NOW.getTime()+skew),nonce:'b'});};
    const first=await acquireLock(adapter,{issue:1,holder:'first',now:NOW,nonce:'a'});
    expect(first.ok).toBe(true);expect(second?.ok).toBe(false);expect(lockComments(adapter)).toHaveLength(1);
  });
  it('expires by elapsed server time even when the next client clock is behind', async () => {
    const adapter = makeAdapter();
    const first = await acquireLock(adapter, {issue:1,holder:'first',now:NOW,nonce:'a'});
    expect(first.ok).toBe(true); adapter.advance(120_001);
    const second = await acquireLock(adapter, {issue:1,holder:'second',now:new Date(NOW.getTime()-300000),nonce:'b'});
    expect(second.ok).toBe(true); expect(lockComments(adapter)).toHaveLength(1);
  });
  it('fails closed and withdraws when its own comment is absent from the read', async () => {
    const adapter=makeAdapter(); adapter.listComments=async()=>[];
    await expect(acquireLock(adapter,{issue:1,holder:'first',now:NOW})).rejects.toThrow('server metadata');
    expect(adapter.allComments(1)).toHaveLength(0);
  });
  it('uses server numeric ids from URLs to break same-second GraphQL id ties', async () => {
    const body=formatLockComment({nonce:'x',holder:'first',issue:1,createdAt:NOW.toISOString(),expiresAt:new Date(NOW.getTime()+120000).toISOString()});
    const parsed=parseLockComment({id:'IC_z',body,author:'first',createdAt:NOW.toISOString(),url:'https://github.com/o/r/issues/1#issuecomment-9007199254740993'});
    expect(parsed?.commentId).toBe('9007199254740993');
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
      new Date(NOW.getTime() - 600_000).toISOString(),
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

  it('compares server comment ids without unsafe integer rounding or lexical ordering', async () => {
    const adapter=makeAdapter();
    const firstId='9007199254740992', secondId='9007199254740993';
    const body=formatLockComment({nonce:'a',holder:'first',issue:1,createdAt:NOW.toISOString(),expiresAt:new Date(NOW.getTime()+120000).toISOString()});
    const prior={id:'IC_z',body,author:'first',createdAt:NOW.toISOString(),url:`https://github.com/o/r/issues/1#issuecomment-${firstId}`};
    adapter.addComment=async (_issue,body)=>({id:secondId,body,author:'second',createdAt:'invalid',url:null});
    adapter.listComments=async()=>[prior,{id:'IC_a',body:formatLockComment({nonce:'b',holder:'second',issue:1,createdAt:NOW.toISOString(),expiresAt:new Date(NOW.getTime()+120000).toISOString()}),author:'second',createdAt:NOW.toISOString(),url:`https://github.com/o/r/issues/1#issuecomment-${secondId}`}];
    const result=await acquireLock(adapter,{issue:1,holder:'second',now:NOW,nonce:'b'});
    expect(result.ok).toBe(false); if(!result.ok)expect(result.heldBy).toBe('first');
  });
  it.each([0,-1,Infinity,NaN])('rejects invalid TTL %s before posting',async ttlMs=>{
    const adapter=makeAdapter(); await expect(acquireLock(adapter,{issue:1,holder:'first',now:NOW,ttlMs})).rejects.toThrow('TTL');
    expect(adapter.allComments(1)).toHaveLength(0);
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
