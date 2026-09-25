/**
 * 同步的串行队列 + 跨标签页互斥（审计 B1 / B3）。
 *
 * 以前「启动同步」「连接同步」「立即同步」「自动同步」各走各的：两个 runSync 可以
 * 同时在跑，推送与游标互相覆盖。现在所有入口都经过同一个 `runExclusive`：
 *
 * 1. 本标签页内：排成一条链，一个跑完下一个才开始（失败不会卡住后面的）；
 * 2. 跨标签页：有 `navigator.locks` 时再拿一把同名的 Web Lock，别的标签页的同一个
 *    账户会排队等；没有（老浏览器、测试环境）时退化为只在本页串行，不报错。
 */

export interface SerialQueue {
  run<T>(task: () => Promise<T>): Promise<T>;
}

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const next = tail.then(task, task);
      // 链尾只关心「跑完了没有」，不关心成败——失败不能卡住后面排队的
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}

interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

function lockManager(): LockManagerLike | null {
  const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
  const locks = nav?.locks;
  return locks !== undefined && typeof locks.request === 'function' ? locks : null;
}

/**
 * 在一把跨标签页的锁里执行 `task`；浏览器不支持 Web Locks 时直接执行。
 */
export async function withCrossTabLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  const locks = lockManager();
  if (locks === null) return task();
  return locks.request(name, task);
}

/**
 * 只在「没有别的标签页正在做」时执行（后台任务 drain 用）：拿不到锁就返回 `skipped`。
 * 不支持 Web Locks 时照常执行。
 */
export async function withCrossTabLockIfAvailable<T>(
  name: string,
  task: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  const nav = (globalThis as { navigator?: { locks?: unknown } }).navigator;
  const locks = nav?.locks as
    | {
        request: (
          name: string,
          options: { ifAvailable: boolean },
          cb: (lock: unknown) => Promise<unknown>,
        ) => Promise<unknown>;
      }
    | undefined;
  if (locks === undefined || typeof locks.request !== 'function') {
    return { ran: true, value: await task() };
  }
  let result: { ran: true; value: T } | { ran: false } = { ran: false };
  await locks.request(name, { ifAvailable: true }, async (lock) => {
    if (lock === null) return;
    result = { ran: true, value: await task() };
  });
  return result;
}
