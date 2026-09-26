import { type BackgroundTask, type EntityStore, nowIso, updateEntity } from '@dramatis/core';

/**
 * 后台队列在网页侧的补充操作（审计 B2）。
 *
 * 内核的 `take()` 永远给「最老的那条 pending」，失败的任务 `fail()` 后又回到 pending，
 * 于是同一条任务在一次 drain 里被连着拿三次、几毫秒内三败即永久 failed。这里补三件事：
 *
 * - `listPending`：看一眼排队的任务，由调用方挑「这一轮能跑的」（退避到点、本轮没失败过）；
 * - `claim`：把挑中的那一条标成 running（只在它仍是 pending 时）；
 * - `retryFailed`：把已经停在 failed 的任务重新排回队列（给界面「重试失败任务」用）。
 *
 * 直接读写与内核同一个集合与同一个形状，不改内核语义。
 */
const COLLECTION = 'backgroundTasks';

/** 首次失败后等多久再试；之后每次 ×4，封顶 10 分钟。 */
export const RETRY_BASE_MS = 15_000;
export const RETRY_MAX_MS = 10 * 60_000;

export interface TaskQueueExtras {
  listPending(limit?: number): Promise<BackgroundTask[]>;
  claim(id: string): Promise<BackgroundTask | null>;
  retryFailed(): Promise<number>;
  failedCount(): Promise<number>;
}

export function createTaskQueueExtras(store: EntityStore): TaskQueueExtras {
  return {
    async listPending(limit = 50) {
      return store.list<BackgroundTask>(COLLECTION, {
        where: { status: 'pending' },
        orderBy: 'createdAt',
        direction: 'asc',
        limit,
      });
    },

    /**
     * 认领一条任务：**必须是原子的**（审计 B3）。
     *
     * 走 `updateEntity`——网页侧 `apps/web/src/lib/db.ts` 实现了 `update`，那是 IndexedDB 的
     * 一个 readwrite 事务（同一仓库上重叠的 readwrite 事务，包括别的标签页的，会被排在它后面）。
     *
     * 原来的 `get` → `put` 是两步：两个标签页同时 list 到同一条 pending，各自都以为自己拿到了，
     * 同一条任务会被跑两遍（模型调两次、账单记两笔、情绪叠加两次）。main 内核的 `take()` 早就是
     * 原子的（`packages/core/src/platform/background-runner.ts` 的 `updateEntity` + `won` 判据），
     * 这个网页侧的补丁不能比它弱。
     */
    async claim(id) {
      let won = false;
      const result = await updateEntity<BackgroundTask>(store, COLLECTION, id, (current) => {
        if (current === null || current.status !== 'pending') return undefined;
        won = true;
        return { ...current, status: 'running', updatedAt: nowIso() };
      });
      return won ? result : null;
    },

    async retryFailed() {
      const failed = await store.list<BackgroundTask>(COLLECTION, { where: { status: 'failed' } });
      for (const task of failed) {
        await store.put(COLLECTION, { ...task, status: 'pending', attempts: 0, updatedAt: nowIso() });
      }
      return failed.length;
    },

    async failedCount() {
      return store.count(COLLECTION, { status: 'failed' });
    },
  };
}

/**
 * 这条任务最早什么时候可以再试（毫秒时间戳）。没失败过就是「现在」。
 *
 * 退避时间从任务自己带的 `attempts` 与 `updatedAt`（`fail()` 会更新它）推出来，
 * 所以刷新页面、换个标签页都照样生效，不需要额外字段。
 */
export function nextAttemptAt(task: Pick<BackgroundTask, 'attempts' | 'updatedAt'>): number {
  if (task.attempts <= 0) return 0;
  const delay = Math.min(RETRY_BASE_MS * 4 ** (task.attempts - 1), RETRY_MAX_MS);
  const last = Date.parse(task.updatedAt);
  return Number.isNaN(last) ? 0 : last + delay;
}

/** 从排队的任务里挑出这一轮能跑的第一条：退避到点、且本轮还没失败过。 */
export function pickRunnable(
  tasks: readonly BackgroundTask[],
  options: { now: number; skip: ReadonlySet<string> },
): BackgroundTask | null {
  for (const task of tasks) {
    if (options.skip.has(task.id)) continue;
    if (nextAttemptAt(task) > options.now) continue;
    return task;
  }
  return null;
}
