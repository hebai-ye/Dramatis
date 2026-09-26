import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSerialQueue, withCrossTabLock, withCrossTabLockIfAvailable } from './sync-queue';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createSerialQueue（审计 B1）', () => {
  it('任务一个接一个跑，不重叠', async () => {
    const queue = createSerialQueue();
    let running = 0;
    let maxRunning = 0;
    const order: number[] = [];
    const task = (n: number) => async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await tick();
      order.push(n);
      running -= 1;
      return n;
    };
    const results = await Promise.all([queue.run(task(1)), queue.run(task(2)), queue.run(task(3))]);
    expect(results).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
    expect(maxRunning).toBe(1);
  });

  it('前一个失败不卡住后面的', async () => {
    const queue = createSerialQueue();
    const failed = queue.run(async () => {
      throw new Error('boom');
    });
    const next = queue.run(async () => 'ok');
    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });
});

describe('Web Locks 包装', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('没有 navigator.locks 时直接执行', async () => {
    vi.stubGlobal('navigator', {});
    await expect(withCrossTabLock('x', async () => 7)).resolves.toBe(7);
    await expect(withCrossTabLockIfAvailable('x', async () => 7)).resolves.toEqual({ ran: true, value: 7 });
  });

  it('有 navigator.locks 时经过锁；ifAvailable 拿不到就跳过', async () => {
    const held = new Set<string>();
    const request = vi.fn(async (name: string, a: unknown, b?: unknown) => {
      const options = typeof a === 'function' ? {} : (a as { ifAvailable?: boolean });
      const callback = (typeof a === 'function' ? a : b) as (lock: unknown) => Promise<unknown>;
      if (options.ifAvailable === true && held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
      }
    });
    vi.stubGlobal('navigator', { locks: { request } });

    await expect(withCrossTabLock('sync', async () => 'a')).resolves.toBe('a');
    expect(request).toHaveBeenCalledTimes(1);

    let inner: unknown;
    const outer = await withCrossTabLockIfAvailable('drain', async () => {
      inner = await withCrossTabLockIfAvailable('drain', async () => 'nested');
      return 'outer';
    });
    expect(outer).toEqual({ ran: true, value: 'outer' });
    expect(inner).toEqual({ ran: false });
  });
});
