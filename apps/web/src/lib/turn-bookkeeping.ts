import type { ConversationId, InstanceId, ProviderPrice, RoomId, SceneId, UsageCategory } from '@dramatis/core';
import type { DramatisDb } from './db';
import { MEMORY_CONSOLIDATE_TASK_KIND, SCENE_SUMMARY_TASK_KIND, TURN_ANALYSIS_TASK_KIND } from './worker';

/**
 * 一个回合的「记账」与「入队」（顺序 65 收敛重复）。
 *
 * 这两件事原本在聊天主循环里各写了三份：发一句、重抽、改归属都各自拼一遍
 * `db.ledger.record` 与 `db.queue.enqueue` 的字段。它们的形状必须一致——
 * 少填一个 `turnId`，重抽就撤不掉那一笔；幂等键算错，同一轮会重复抽取记忆——
 * 所以集中在**一个地方**拼，主循环只负责说「谁、哪一轮、花了多少」。
 *
 * 顺带把两处「这一轮之后要排的活」也收在这里（场记、记忆合并）：它们与一轮分析
 * 是同一类东西，读的时候应该一起看。
 */

/** 只需要「踢一下队列」这一件事，避免把整份 worker API 拖进来。 */
export interface QueueKicker {
  kick: () => void;
}

/**
 * 账单要的那两个 token 数。
 *
 * 内核的 `MessageUsage` 与服务商层的 `TokenUsage` 都长这样（后者两个字段是可选的），
 * 这里只取共同的部分，两条路都能直接传进来。
 */
export interface TokenCounts {
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
}

/** 一次模型调用的账（T7）。`usage` 缺省时 token 记 0——调用发生过就得记。 */
export async function recordModelCall(
  db: DramatisDb | null,
  input: {
    category: UsageCategory;
    model: string;
    roomId?: RoomId | null;
    conversationId?: ConversationId | null;
    turnId?: string | null;
    usage?: TokenCounts | null;
    /**
     * 装配提示词时估算的 prompt token 数（顺序 71）。
     *
     * 与 `usage.promptTokens` 配成一对，账单就能算出启发式口径低估了多少——
     * 这一路是唯一能拿到 `assemblePrompt` 结果的地方，所以只有这里记得上。
     */
    promptEstimate?: number | null;
    price?: ProviderPrice | null;
    /** 说话的那个角色；世界管理员这类不属于任何角色的调用不填。 */
    speaker?: { id: InstanceId; name: string } | null;
  },
): Promise<void> {
  if (db === null) return;
  await db.ledger.record({
    roomId: input.roomId ?? null,
    conversationId: input.conversationId ?? null,
    turnId: input.turnId ?? null,
    category: input.category,
    model: input.model,
    promptTokens: input.usage?.promptTokens ?? 0,
    completionTokens: input.usage?.completionTokens ?? 0,
    promptEstimate: input.promptEstimate ?? null,
    speakerInstanceId: input.speaker?.id ?? null,
    speakerName: input.speaker?.name ?? '',
    price: input.price ?? null,
  });
}

/**
 * 排一条「一轮分析」的后台任务（记忆 + 状态变化）。
 *
 * 幂等键按回合给，所以一轮只会有一条；`distinct` 用在**重抽 / 改归属**上——
 * 那两条路会先 `clearTurn` 清掉旧记录，再排一条新的（带时间戳保证一定起得来）。
 */
export async function enqueueTurnAnalysis(
  db: DramatisDb | null,
  worker: QueueKicker,
  input: {
    roomId: RoomId;
    conversationId: ConversationId;
    /** 重抽 / 改归属那条路上的消息可能没有场景（历史数据），所以允许 null。 */
    sceneId: SceneId | null;
    turnId: string;
    distinct?: boolean;
  },
): Promise<void> {
  if (db === null) return;
  await db.queue.enqueue({
    kind: TURN_ANALYSIS_TASK_KIND,
    idempotencyKey: `${TURN_ANALYSIS_TASK_KIND}:${input.turnId}${input.distinct === true ? `:${String(Date.now())}` : ''}`,
    roomId: input.roomId,
    turnId: input.turnId,
    payload: {
      roomId: input.roomId,
      sceneId: input.sceneId,
      turnId: input.turnId,
      conversationId: input.conversationId,
    },
  });
  worker.kick();
}

/**
 * 让后台看一眼这一场要不要压场记（P1-5 的场景层）。
 *
 * 这里**不做阈值判断**：攒够没攒够由后台拿着最新数据决定（同一个纯函数），
 * 界面侧的判断会拿着过期的场景对象重复触发——真机第一轮就出现过两次摘要调用。
 * 幂等键按回合给：一轮只排一次队，攒不够时那一趟是空跑，不发调用、不记账。
 */
export async function enqueueSceneSummary(
  db: DramatisDb | null,
  worker: QueueKicker,
  input: { roomId: RoomId; conversationId: ConversationId; sceneId: SceneId; key: string },
): Promise<void> {
  if (db === null) return;
  await db.queue.enqueue({
    kind: SCENE_SUMMARY_TASK_KIND,
    idempotencyKey: `${SCENE_SUMMARY_TASK_KIND}:${input.sceneId}:${input.key}`,
    roomId: input.roomId,
    turnId: null,
    payload: { roomId: input.roomId, sceneId: input.sceneId, conversationId: input.conversationId },
  });
  worker.kick();
}

/**
 * 让后台看一眼「记忆该不该合并」（顺序 27a）。
 *
 * 与场记那条路同一个套路：这里**不做阈值判断**（判断在 worker 里拿着最新数据做），
 * 只负责按「每 40 条记忆」排一次队——幂等键里带桶号，所以同一批记忆只会排一次，
 * 攒不够时那一趟是空跑（不发调用、不记账）。
 */
export async function enqueueMemoryConsolidation(
  db: DramatisDb | null,
  worker: QueueKicker,
  input: { roomId: RoomId; conversationId: ConversationId },
): Promise<void> {
  if (db === null) return;
  const memories = await db.repository.listMemories(input.roomId);
  const bucket = Math.floor(memories.length / 40);
  await db.queue.enqueue({
    kind: MEMORY_CONSOLIDATE_TASK_KIND,
    idempotencyKey: `${MEMORY_CONSOLIDATE_TASK_KIND}:${input.conversationId}:${String(bucket)}`,
    roomId: input.roomId,
    turnId: null,
    payload: { roomId: input.roomId, conversationId: input.conversationId },
  });
  worker.kick();
}
