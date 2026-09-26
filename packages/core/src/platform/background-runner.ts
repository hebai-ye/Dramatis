import { newId, nowIso } from '../model/ids.js';
import { type EntityStore, updateEntity } from './entity-store.js';

/**
 * 后台任务队列（ROADMAP P1-9，重抽撤销见 P0-7）。
 *
 * 之所以在 P0 就建好：移动端浏览器与桌面浏览器都会在不活跃时丢弃页面，
 * 后台任务随时可能被打断。队列因此必须**幂等且可恢复**——
 * 下次启动时把中断的任务捡回来继续做，而不是让角色的记忆停在半路。
 */
export type BackgroundTaskStatus = 'pending' | 'running' | 'done' | 'failed';

export interface BackgroundTask<TPayload = unknown> {
  id: string;
  /** 任务类型，例如 'memory.extract' / 'affect.update'。 */
  kind: string;
  roomId: string | null;
  turnId: string | null;
  payload: TPayload;
  status: BackgroundTaskStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  /**
   * 幂等键。同一 key 重复入队只会保留一条，
   * 这是「任务被中断后重跑」不会产生重复记忆的保证。
   */
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueInput<TPayload = unknown> {
  kind: string;
  payload: TPayload;
  idempotencyKey: string;
  roomId?: string | null;
  turnId?: string | null;
  maxAttempts?: number;
}

export interface BackgroundRunner {
  enqueue<TPayload>(input: EnqueueInput<TPayload>): Promise<BackgroundTask<TPayload>>;
  /** 取出待执行任务，按入队顺序。不会改变任务状态，由调用方负责 complete / fail。 */
  take(limit?: number): Promise<BackgroundTask[]>;
  complete(id: string): Promise<void>;
  fail(id: string, error: string): Promise<void>;
  /** 重抽时撤销同一回合尚未完成的任务（P0-7）。返回撤销数量。 */
  cancelByTurn(turnId: string): Promise<number>;
  /**
   * 把某一回合的任务记录整体清掉，**包括已经跑完的**。
   *
   * 重抽要用这个而不是 `cancelByTurn`：任务跑完之后那条「已完成」的记录仍然
   * 占着幂等键，于是重新入队会被当成重复任务直接返回，这一轮的记忆就再也
   * 抽不出来了（真实模型端到端测试里踩到的坑）。
   */
  clearTurn(turnId: string): Promise<number>;
  /** 启动时调用：把中断的 running 任务改回 pending。 */
  recoverInterrupted(): Promise<number>;
  pendingCount(): Promise<number>;
  list(limit?: number): Promise<BackgroundTask[]>;
}

const COLLECTION = 'backgroundTasks';
const DEFAULT_MAX_ATTEMPTS = 3;

export function createBackgroundRunner(store: EntityStore): BackgroundRunner {
  return {
    async enqueue<TPayload>(input: EnqueueInput<TPayload>): Promise<BackgroundTask<TPayload>> {
      const existing = await store.list<BackgroundTask<TPayload>>(COLLECTION, {
        where: { idempotencyKey: input.idempotencyKey },
      });
      const found = existing[0];
      if (found) return found;

      const now = nowIso();
      const task: BackgroundTask<TPayload> = {
        id: newId(),
        kind: input.kind,
        roomId: input.roomId ?? null,
        turnId: input.turnId ?? null,
        payload: input.payload,
        status: 'pending',
        attempts: 0,
        maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        lastError: null,
        idempotencyKey: input.idempotencyKey,
        createdAt: now,
        updatedAt: now,
      };
      await store.put(COLLECTION, task);
      return task;
    },

    async take(limit = 1): Promise<BackgroundTask[]> {
      const pending = await store.list<BackgroundTask>(COLLECTION, {
        where: { status: 'pending' },
        orderBy: 'createdAt',
        direction: 'asc',
        limit,
      });

      // 必须把状态变更后的对象返回给调用方，否则调用方拿到的是过期的 pending，
      // 会以为自己没有独占这个任务。
      //
      // 认领是一次**原子的比较交换**（审计 B3）：在同一个事务里重读，只有仍是 pending
      // 才改成 running。两个标签页同时 list 到同一条时，后到的那个读到的已经是 running，
      // 于是放弃——模型不会被调两次、账单不会记两笔、情绪不会叠加两次。
      const claimed: BackgroundTask[] = [];
      for (const task of pending) {
        let won = false;
        const result = await updateEntity<BackgroundTask>(store, COLLECTION, task.id, (current) => {
          if (current === null || current.status !== 'pending') return undefined;
          won = true;
          return { ...current, status: 'running', updatedAt: nowIso() };
        });
        if (won && result !== null) claimed.push(result);
      }
      return claimed;
    },

    async complete(id: string): Promise<void> {
      const task = await store.get<BackgroundTask>(COLLECTION, id);
      if (!task) return;
      await store.put(COLLECTION, { ...task, status: 'done', updatedAt: nowIso() });
    },

    async fail(id: string, error: string): Promise<void> {
      const task = await store.get<BackgroundTask>(COLLECTION, id);
      if (!task) return;

      const attempts = task.attempts + 1;
      await store.put(COLLECTION, {
        ...task,
        attempts,
        status: attempts >= task.maxAttempts ? 'failed' : 'pending',
        lastError: error.slice(0, 500),
        updatedAt: nowIso(),
      });
    },

    async cancelByTurn(turnId: string): Promise<number> {
      const tasks = await store.list<BackgroundTask>(COLLECTION, { where: { turnId } });
      const pending = tasks.filter((task) => task.status === 'pending' || task.status === 'running');
      for (const task of pending) {
        await store.remove(COLLECTION, task.id);
      }
      return pending.length;
    },

    async clearTurn(turnId: string): Promise<number> {
      const tasks = await store.list<BackgroundTask>(COLLECTION, { where: { turnId } });
      for (const task of tasks) {
        await store.remove(COLLECTION, task.id);
      }
      return tasks.length;
    },

    async recoverInterrupted(): Promise<number> {
      const running = await store.list<BackgroundTask>(COLLECTION, { where: { status: 'running' } });
      for (const task of running) {
        await store.put(COLLECTION, {
          ...task,
          status: 'pending',
          lastError: '上次运行被中断，已重新排队',
          updatedAt: nowIso(),
        });
      }
      return running.length;
    },

    async pendingCount(): Promise<number> {
      return store.count(COLLECTION, { status: 'pending' });
    },

    async list(limit = 50): Promise<BackgroundTask[]> {
      return store.list<BackgroundTask>(COLLECTION, {
        orderBy: 'createdAt',
        direction: 'desc',
        limit,
      });
    },
  };
}
