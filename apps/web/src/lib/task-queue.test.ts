import { type BackgroundTask, createBackgroundRunner, createMemoryEntityStore } from '@dramatis/core';
import { describe, expect, it } from 'vitest';
import { createTaskQueueExtras, nextAttemptAt, pickRunnable, RETRY_BASE_MS, RETRY_MAX_MS } from './task-queue';

function task(partial: Partial<BackgroundTask>): BackgroundTask {
  return {
    id: 't',
    kind: 'k',
    roomId: null,
    turnId: null,
    payload: {},
    status: 'pending',
    attempts: 0,
    maxAttempts: 3,
    lastError: null,
    idempotencyKey: 'k',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('后台任务退避（审计 B2）', () => {
  const base = Date.parse('2026-01-01T00:00:00.000Z');

  it('没失败过的立即可跑；失败后指数退避、有封顶', () => {
    expect(nextAttemptAt(task({ attempts: 0 }))).toBe(0);
    expect(nextAttemptAt(task({ attempts: 1 }))).toBe(base + RETRY_BASE_MS);
    expect(nextAttemptAt(task({ attempts: 2 }))).toBe(base + RETRY_BASE_MS * 4);
    expect(nextAttemptAt(task({ attempts: 9 }))).toBe(base + RETRY_MAX_MS);
  });

  it('跳过没到点的与本轮失败过的', () => {
    const fresh = task({ id: 'a' });
    const backingOff = task({ id: 'b', attempts: 1 });
    const later = task({ id: 'c' });
    expect(pickRunnable([backingOff, fresh], { now: base, skip: new Set() })?.id).toBe('a');
    expect(pickRunnable([fresh, later], { now: base, skip: new Set(['a']) })?.id).toBe('c');
    expect(pickRunnable([backingOff], { now: base + RETRY_BASE_MS, skip: new Set() })?.id).toBe('b');
    expect(pickRunnable([fresh], { now: base, skip: new Set(['a']) })).toBeNull();
  });

  it('claim 只认 pending；retryFailed 把失败任务排回去并清零次数', async () => {
    const store = createMemoryEntityStore();
    const runner = createBackgroundRunner(store);
    const extras = createTaskQueueExtras(store);
    const created = await runner.enqueue({ kind: 'k', payload: {}, idempotencyKey: 'x', maxAttempts: 1 });

    const claimed = await extras.claim(created.id);
    expect(claimed?.status).toBe('running');
    expect(await extras.claim(created.id)).toBeNull();

    await runner.fail(created.id, 'boom');
    expect(await extras.failedCount()).toBe(1);
    expect(await extras.retryFailed()).toBe(1);
    const pending = await extras.listPending();
    expect(pending.map((item) => [item.id, item.attempts])).toEqual([[created.id, 0]]);
    expect(await extras.failedCount()).toBe(0);
  });
});
