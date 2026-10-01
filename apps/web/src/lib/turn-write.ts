import {
  type CharacterInstance,
  createBackgroundRunner,
  type EntityStore,
  type Message,
  type MessageId,
  Repository,
  type RoomId,
  revertAffectForTurn,
  withStoreTransaction,
} from '@dramatis/core';

/**
 * 顺序 77：把「一轮内的一批写入」放进同一个事务。
 *
 * 改之前，重抽（重写一条回复）和改归属（把一条回复换给另一个角色）都是**分多步**
 * 落盘的：改消息 → 清这一轮的后台任务 → 撤这一轮的记忆与情绪。中间任何一步失败
 * （存储报错、标签页被关、配额满）都会留下一半的状态——回复换了、可上一轮的情绪
 * 还在，或者任务键没了、记忆还在。极端情况下用户会看到「同一句话两副情绪」。
 *
 * 现在这三步共用一个 IndexedDB 事务（所有集合都在同一张 object store 上，见
 * `db.ts` 的 `store.transaction`），要么全部落地，要么一条都不落。
 *
 * 两条边界，写在这里免得以后有人好心搬进来：
 * - **模型调用、用量账单、`worker.kick()` 不进事务**：钱花了、网络发了是回滚不了的，
 *   通知也必须等事务真的提交（账目与网络 Promise 还会让 IndexedDB 事务提前提交）。
 * - **界面状态在事务外对齐**：`session.ts` 拿到结果后再 `setSnapshot`。
 */

/** 重写一条已存在的回复时要一起处理的东西。 */
export interface RewriteTurnInput {
  /** 要原地改写的那条消息。 */
  messageId: MessageId;
  /** 覆盖上去的字段（正文、用量、意图…）。 */
  patch: Partial<Message>;
  roomId: RoomId;
  /** 这条消息所属的一轮；这一轮的后台任务与记忆会一起撤掉。 */
  turnId: string;
}

/** 撤一轮之后的实况，供界面状态对齐用。 */
export interface RevertTurnResult {
  /** 软删（撤）掉的记忆条数。 */
  removedMemories: number;
  /** 情绪真的被还原过的角色实例（没变的不会出现在这里）。 */
  revertedInstances: CharacterInstance[];
}

export interface TurnWriteResult {
  /** 改写后的消息；`null` = 这条消息已经不在库里（被删掉或被同步覆盖）。 */
  message: Message | null;
  /** 事务里清掉的这一轮的后台任务条数（含已完成记录）。 */
  clearedTasks: number;
  /** 事务里撤掉的这一轮的记忆与情绪。 */
  reverted: RevertTurnResult;
}

const NOTHING_REVERTED: RevertTurnResult = { removedMemories: 0, revertedInstances: [] };

/**
 * 撤掉这一轮的记忆与情绪，**只落盘、不动界面状态**。
 *
 * 与 `session.ts` 原来的顺序逐字一致（先删这一轮的记忆，再把每个角色的情绪还原），
 * 区别只是现在跑在调用方的事务作用域上。
 */
async function revertTurnOn(scope: EntityStore, roomId: RoomId, turnId: string): Promise<RevertTurnResult> {
  const repository = new Repository(scope);

  const removedMemories = await repository.deleteMemoriesByTurn(roomId, turnId);

  const stored = await repository.listInstances(roomId);
  const reverted = stored.map((instance) => revertAffectForTurn(instance, turnId));
  const revertedInstances: CharacterInstance[] = [];
  for (let index = 0; index < reverted.length; index += 1) {
    const next = reverted[index];
    if (next !== undefined && next !== stored[index]) {
      await repository.saveInstance(next);
      revertedInstances.push(next);
    }
  }

  return { removedMemories, revertedInstances };
}

/** 只撤这一轮（「删除这一轮的后台写入」这条独立的入口用它）。 */
export async function revertTurnWrites(store: EntityStore, roomId: RoomId, turnId: string): Promise<RevertTurnResult> {
  return withStoreTransaction(store, (scope) => revertTurnOn(scope, roomId, turnId));
}

/**
 * 重抽 / 改归属：原地改写这条消息，并把这一轮的后台写入一起撤掉。
 *
 * 消息已经不在了就直接返回 `null`——**不撤任何东西**：原来那套是「先改写，改不动
 * 就报错收场」，此时没必要再动这一轮的账。
 */
export async function rewriteTurnWrites(store: EntityStore, input: RewriteTurnInput): Promise<TurnWriteResult> {
  return withStoreTransaction(store, async (scope) => {
    const repository = new Repository(scope);

    const message = await repository.updateMessage(input.messageId, input.patch);
    if (message === null) {
      return { message: null, clearedTasks: 0, reverted: NOTHING_REVERTED };
    }

    const clearedTasks = await createBackgroundRunner(scope).clearTurn(input.turnId);
    const reverted = await revertTurnOn(scope, input.roomId, input.turnId);

    return { message, clearedTasks, reverted };
  });
}
