import {
  buildExtractionMessages,
  buildMemoryEvents,
  collectCompletion,
  createOpenAICompatibleProvider,
  type MemoryEvent,
  parseExtraction,
  type RoomId,
  type SceneId,
} from '@dramatis/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DramatisDb } from './db';

export const MEMORY_TASK_KIND = 'memory.extract';

/** 每个角色每轮最多带入多少 token 的记忆。 */
export const MEMORY_BUDGET_TOKENS = 800;

export interface MemoryTaskPayload {
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

export interface MemoryWorkerApi {
  pending: number;
  running: boolean;
  lastError: string | null;
  /** 立刻尝试清空队列。每轮对话结束后调用。 */
  kick: () => void;
}

/**
 * 记忆抽取工作线程（ROADMAP P1-1）。
 *
 * 抽取走后台队列而不是阻塞对话：用户不需要等它，而且队列是幂等可恢复的，
 * 页面被浏览器回收后下次打开会接着做。
 *
 * 任务负载里只存 id 不存消息内容：内容从库里现取，这样重试、跨会话恢复
 * 都不会因为负载过期而出错，也不会把同一条消息存两遍。
 */
export function useMemoryWorker(options: {
  db: DramatisDb | null;
  provider: BackgroundProviderConfig | null;
  onIngested: (events: readonly MemoryEvent[]) => void;
}): MemoryWorkerApi {
  const { db, provider, onIngested } = options;
  const [pending, setPending] = useState(0);
  const [running, setRunning] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const drainingRef = useRef(false);
  const onIngestedRef = useRef(onIngested);
  const providerRef = useRef(provider);

  // 这些回调每次渲染都是新对象；用 ref 跟随，避免把 drain 变成依赖泥球
  onIngestedRef.current = onIngested;
  providerRef.current = provider;

  const refreshPending = useCallback(async () => {
    if (!db) return;
    setPending(await db.queue.pendingCount());
  }, [db]);

  const runExtraction = useCallback(
    async (taskId: string, payload: MemoryTaskPayload): Promise<void> => {
      if (!db) return;

      const config = providerRef.current;
      if (!config) throw new Error('没有可用的后台模型配置');
      if (config.apiKey.trim() === '') throw new Error('后台模型缺少 API Key');

      const room = await db.repository.getRoom(payload.roomId);
      if (!room) throw new Error('房间已经不存在');

      const allMessages = await db.repository.listMessages(payload.roomId);
      const turnMessages = allMessages.filter((message) => message.turnId === payload.turnId);
      if (turnMessages.length === 0) {
        // 这一轮已经被撤销（重抽或删除），没什么可抽取的
        await db.queue.complete(taskId);
        return;
      }

      const instances = await db.repository.listInstances(payload.roomId);
      const audience = new Set(turnMessages.flatMap((message) => message.audience));
      const participants = instances.filter((instance) => audience.has(instance.id));

      const scene = payload.sceneId === null ? null : await db.repository.getScene(payload.sceneId);

      const provider = createOpenAICompatibleProvider({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
      });

      const raw = await collectCompletion(
        provider,
        buildExtractionMessages({
          scene,
          cast: participants,
          playerName: room.playerName,
          messages: turnMessages,
        }),
        { temperature: 0.2 },
      );

      const extraction = parseExtraction(raw);
      const sequence = await db.repository.nextMemorySequence(payload.roomId);
      const { events } = buildMemoryEvents({
        roomId: payload.roomId,
        sceneId: payload.sceneId,
        worldTime: scene?.worldTime ?? '',
        sequence,
        participants,
        extraction,
        turnId: payload.turnId,
      });

      // 先清掉这一轮可能残留的旧记忆，让重试天然幂等
      await db.repository.deleteMemoriesByTurn(payload.roomId, payload.turnId);
      await db.repository.saveMemories(events);
      await db.queue.complete(taskId);
      onIngestedRef.current(events);
    },
    [db],
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
          if (task.kind !== MEMORY_TASK_KIND) {
            await db.queue.complete(task.id);
            continue;
          }
          await runExtraction(task.id, task.payload as MemoryTaskPayload);
          setLastError(null);
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
  }, [db, refreshPending, runExtraction]);

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

  return { pending, running, lastError, kick };
}
