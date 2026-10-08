import { newId, nowIso, type RoomId } from '../model/ids.js';
import type { BackgroundTask } from './background-runner.js';
import type { EntityStore } from './entity-store.js';

export interface TaskLease {
  id: string;
  token: string;
}
const COLLECTION = 'backgroundTasks';

/** The web claim remains compatible; rotate an execution token before loading any model input. */
export async function leaseBackgroundTask(
  store: EntityStore,
  claimed: BackgroundTask,
): Promise<(BackgroundTask & { runToken: string }) | null> {
  if (!store.update) throw new Error('后台提交需要原子任务认领，未执行非原子降级。');
  let leased: (BackgroundTask & { runToken: string }) | null = null;
  await store.update<BackgroundTask>(COLLECTION, claimed.id, (current) => {
    if (
      current?.status !== 'running' ||
      current.updatedAt !== claimed.updatedAt ||
      current.attempts !== claimed.attempts ||
      current.runToken !== claimed.runToken
    )
      return undefined;
    leased = { ...current, runToken: newId() };
    return leased;
  });
  return leased;
}

export async function isTaskLeaseCurrent(
  store: EntityStore,
  lease: TaskLease,
  scope?: { roomId: RoomId; turnId: string },
): Promise<boolean> {
  const task = await store.get<BackgroundTask>(COLLECTION, lease.id);
  return (
    task !== null &&
    task.status === 'running' &&
    task.runToken === lease.token &&
    (scope === undefined || (task.roomId === scope.roomId && task.turnId === scope.turnId))
  );
}

/** An old completion/failure must never settle a replacement or recovered execution. */
export async function settleBackgroundTask(store: EntityStore, lease: TaskLease, error?: string): Promise<boolean> {
  if (!store.update) throw new Error('后台完成需要原子更新。');
  let settled = false;
  await store.update<BackgroundTask>(COLLECTION, lease.id, (current) => {
    if (current?.status !== 'running' || current.runToken !== lease.token) return undefined;
    settled = true;
    const attempts = current.attempts + (error === undefined ? 0 : 1);
    return {
      ...current,
      attempts,
      status: error === undefined ? 'done' : attempts >= current.maxAttempts ? 'failed' : 'pending',
      lastError: error?.slice(0, 500) ?? null,
      updatedAt: nowIso(),
    };
  });
  return settled;
}
