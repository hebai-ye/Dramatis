import {
  applyAffectUpdates,
  buildAffectMessages,
  buildExtractionMessages,
  buildMemoryEvents,
  collectCompletion,
  createOpenAICompatibleProvider,
  type ModelProvider,
  parseAffectUpdates,
  parseExtraction,
  type RoomId,
  type SceneId,
} from '@dramatis/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DramatisDb } from './db';

export const MEMORY_TASK_KIND = 'memory.extract';
export const AFFECT_TASK_KIND = 'affect.update';

/** 每个角色每轮最多带入多少 token 的记忆。 */
export const MEMORY_BUDGET_TOKENS = 800;

export interface TurnTaskPayload {
  roomId: RoomId;
  sceneId: SceneId | null;
  turnId: string;
}

export interface BackgroundProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
}

export interface BackgroundWorkerApi {
  pending: number;
  running: boolean;
  lastError: string | null;
  /** 本次会话完成的调用次数，用于观察后台开销。 */
  completed: number;
  /** 立刻尝试清空队列。每轮对话结束后调用。 */
  kick: () => void;
}

function makeProvider(config: BackgroundProviderConfig): ModelProvider {
  return createOpenAICompatibleProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
  });
}

/**
 * 后台任务工作线程（ROADMAP P1-9）。
 *
 * 抽取与状态推演都走同一个队列，而不是各自起一套定时器：
 * 队列是幂等且可恢复的，页面被浏览器回收后下次打开会接着做；
 * 所有后台开销也只在这一个地方发生，便于统计与控制。
 *
 * 任务负载里只存 id 不存消息内容——内容从库里现取。这样重试、
 * 跨会话恢复都不会因为负载过期而出错，也不会把同一条消息存两遍。
 */
export function useBackgroundWorker(options: {
  db: DramatisDb | null;
  provider: BackgroundProviderConfig | null;
  /** 任何后台写入完成后触发，让 UI 重新载入。 */
  onChanged: () => void;
}): BackgroundWorkerApi {
  const { db, provider, onChanged } = options;
  const [pending, setPending] = useState(0);
  const [running, setRunning] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(0);

  const drainingRef = useRef(false);
  const onChangedRef = useRef(onChanged);
  const providerRef = useRef(provider);

  // 这两个每次渲染都是新对象；用 ref 跟随，避免把 drain 变成依赖泥球
  onChangedRef.current = onChanged;
  providerRef.current = provider;

  const refreshPending = useCallback(async () => {
    if (!db) return;
    setPending(await db.queue.pendingCount());
  }, [db]);

  /** 读取一个回合的上下文：房间、消息、在场角色、场景。 */
  const loadTurn = useCallback(
    async (payload: TurnTaskPayload) => {
      if (!db) return null;

      const room = await db.repository.getRoom(payload.roomId);
      if (!room) return null;

      const allMessages = await db.repository.listMessages(payload.roomId);
      const messages = allMessages.filter((message) => message.turnId === payload.turnId);
      if (messages.length === 0) return null;

      const instances = await db.repository.listInstances(payload.roomId);
      const audience = new Set(messages.flatMap((message) => message.audience));

      return {
        room,
        messages,
        participants: instances.filter((instance) => audience.has(instance.id)),
        scene: payload.sceneId === null ? null : await db.repository.getScene(payload.sceneId),
      };
    },
    [db],
  );

  const runMemoryExtraction = useCallback(
    async (payload: TurnTaskPayload, config: BackgroundProviderConfig): Promise<void> => {
      if (!db) return;
      const context = await loadTurn(payload);
      if (!context) return;

      const raw = await collectCompletion(
        makeProvider(config),
        buildExtractionMessages({
          scene: context.scene,
          cast: context.participants,
          playerName: context.room.playerName,
          messages: context.messages,
        }),
        { temperature: 0.2 },
      );

      const extraction = parseExtraction(raw);
      const sequence = await db.repository.nextMemorySequence(payload.roomId);
      const { events } = buildMemoryEvents({
        roomId: payload.roomId,
        sceneId: payload.sceneId,
        worldTime: context.scene?.worldTime ?? '',
        sequence,
        participants: context.participants,
        extraction,
        turnId: payload.turnId,
      });

      // 先清掉这一轮可能残留的旧记忆，让重试天然幂等
      await db.repository.deleteMemoriesByTurn(payload.roomId, payload.turnId);
      await db.repository.saveMemories(events);
    },
    [db, loadTurn],
  );

  const runAffectUpdate = useCallback(
    async (payload: TurnTaskPayload, config: BackgroundProviderConfig): Promise<void> => {
      if (!db) return;
      const context = await loadTurn(payload);
      if (!context) return;

      // 幂等：同一个回合已经推演过就不再叠加，否则重试会让关系翻倍
      const already = context.participants.some((instance) =>
        instance.affect.history.some((change) => change.turnId === payload.turnId),
      );
      if (already) return;

      const raw = await collectCompletion(
        makeProvider(config),
        buildAffectMessages({
          cast: context.participants,
          playerName: context.room.playerName,
          messages: context.messages,
        }),
        { temperature: 0.2 },
      );

      const { applied } = applyAffectUpdates(context.participants, parseAffectUpdates(raw), {
        at: new Date().toISOString(),
        turnId: payload.turnId,
      });
      for (const item of applied) {
        await db.repository.saveInstance(item.next);
      }
    },
    [db, loadTurn],
  );

  const drain = useCallback(async () => {
    if (!db || drainingRef.current) return;
    drainingRef.current = true;
    setRunning(true);

    try {
      for (;;) {
        const [task] = await db.queue.take(1);
        if (!task) break;

        try {
          const config = providerRef.current;
          if (!config || config.apiKey.trim() === '') {
            throw new Error('后台任务缺少可用的模型配置或 API Key');
          }

          const payload = task.payload as TurnTaskPayload;
          if (task.kind === MEMORY_TASK_KIND) {
            await runMemoryExtraction(payload, config);
          } else if (task.kind === AFFECT_TASK_KIND) {
            await runAffectUpdate(payload, config);
          }

          await db.queue.complete(task.id);
          setCompleted((value) => value + 1);
          setLastError(null);
          onChangedRef.current();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setLastError(message);
          await db.queue.fail(task.id, message);
        }
      }
    } finally {
      drainingRef.current = false;
      setRunning(false);
      await refreshPending();
    }
  }, [db, refreshPending, runAffectUpdate, runMemoryExtraction]);

  const kick = useCallback(() => {
    void drain();
  }, [drain]);

  // 启动时清一次积压，之后每 8 秒补一次，兜住页面被挂起的情况
  useEffect(() => {
    void refreshPending();
    if (!db || !provider) return;

    kick();
    const timer = setInterval(() => kick(), 8000);
    return () => clearInterval(timer);
  }, [db, kick, provider, refreshPending]);

  return { pending, running, lastError, completed, kick };
}
