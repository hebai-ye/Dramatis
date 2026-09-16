import { describe, expect, it } from 'vitest';
import { createBackgroundRunner } from './background-runner.js';
import { createMemoryEntityStore } from './memory-store.js';

function runner() {
  return createBackgroundRunner(createMemoryEntityStore());
}

describe('BackgroundRunner', () => {
  it('入队后可取出并完成', async () => {
    const queue = runner();
    await queue.enqueue({ kind: 'memory.extract', payload: { a: 1 }, idempotencyKey: 'k1' });

    const [task] = await queue.take(1);
    expect(task?.kind).toBe('memory.extract');
    expect(task?.status).toBe('running');

    if (!task) throw new Error('未取到任务');
    await queue.complete(task.id);
    expect(await queue.pendingCount()).toBe(0);
  });

  it('相同幂等键不会重复入队', async () => {
    const queue = runner();
    const first = await queue.enqueue({ kind: 'x', payload: {}, idempotencyKey: 'same' });
    const second = await queue.enqueue({ kind: 'x', payload: {}, idempotencyKey: 'same' });

    expect(second.id).toBe(first.id);
    expect(await queue.pendingCount()).toBe(1);
  });

  it('按入队顺序取出', async () => {
    const queue = runner();
    await queue.enqueue({ kind: 'a', payload: {}, idempotencyKey: 'a' });
    await queue.enqueue({ kind: 'b', payload: {}, idempotencyKey: 'b' });
    await queue.enqueue({ kind: 'c', payload: {}, idempotencyKey: 'c' });

    const taken = await queue.take(2);
    expect(taken.map((task) => task.kind)).toEqual(['a', 'b']);
  });

  it('失败会重试，超过上限后进入终态', async () => {
    const queue = runner();
    const task = await queue.enqueue({ kind: 'x', payload: {}, idempotencyKey: 'k', maxAttempts: 2 });
    await queue.take(1);

    await queue.fail(task.id, '第一次失败');
    expect(await queue.pendingCount()).toBe(1);

    const [retried] = await queue.take(1);
    if (!retried) throw new Error('未重新排队');
    await queue.fail(retried.id, '第二次失败');

    expect(await queue.pendingCount()).toBe(0);
    const all = await queue.list();
    expect(all[0]?.status).toBe('failed');
    expect(all[0]?.attempts).toBe(2);
  });

  it('按回合撤销任务，用于重抽', async () => {
    const queue = runner();
    await queue.enqueue({ kind: 'a', payload: {}, idempotencyKey: 'a', turnId: 'turn-1' });
    await queue.enqueue({ kind: 'b', payload: {}, idempotencyKey: 'b', turnId: 'turn-1' });
    await queue.enqueue({ kind: 'c', payload: {}, idempotencyKey: 'c', turnId: 'turn-2' });

    const cancelled = await queue.cancelByTurn('turn-1');

    expect(cancelled).toBe(2);
    expect(await queue.pendingCount()).toBe(1);
  });

  it('撤销会连带清掉已进入 running 的任务', async () => {
    const queue = runner();
    await queue.enqueue({ kind: 'a', payload: {}, idempotencyKey: 'a', turnId: 'turn-1' });
    await queue.take(1);

    expect(await queue.cancelByTurn('turn-1')).toBe(1);
    expect(await queue.pendingCount()).toBe(0);
  });

  it('启动时把被中断的任务捡回来', async () => {
    const queue = runner();
    await queue.enqueue({ kind: 'a', payload: {}, idempotencyKey: 'a' });
    await queue.enqueue({ kind: 'b', payload: {}, idempotencyKey: 'b' });
    await queue.take(2);

    // 模拟页面被浏览器丢弃：任务停在 running
    expect(await queue.pendingCount()).toBe(0);
    const recovered = await queue.recoverInterrupted();

    expect(recovered).toBe(2);
    expect(await queue.pendingCount()).toBe(2);
  });

  it('恢复后的任务保留原有负载与幂等键', async () => {
    const queue = runner();
    await queue.enqueue({ kind: 'a', payload: { keep: 'me' }, idempotencyKey: 'a' });
    await queue.take(1);
    await queue.recoverInterrupted();

    const [task] = await queue.take(1);
    expect(task?.payload).toEqual({ keep: 'me' });
    expect(task?.idempotencyKey).toBe('a');
  });

  it('完成的终态任务不会被恢复', async () => {
    const queue = runner();
    const task = await queue.enqueue({ kind: 'a', payload: {}, idempotencyKey: 'a' });
    await queue.take(1);
    await queue.complete(task.id);

    expect(await queue.recoverInterrupted()).toBe(0);
  });
});
