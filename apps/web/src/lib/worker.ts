import {
  applyAffectUpdates,
  applyConsolidation,
  applyTurnAnalysis,
  buildAffectMessages,
  buildChapterSummaryMessages,
  buildConsolidationPrompt,
  buildExtractionMessages,
  buildMemoryEvents,
  buildSceneSummaryMessages,
  buildTurnAnalysisMessages,
  type ConversationId,
  chapterCandidates,
  collectCompletionWithTools,
  createOpenAICompatibleProvider,
  evaluateBudget,
  type ModelProvider,
  newId,
  nowIso,
  type ProviderPrice,
  parseAffectUpdates,
  parseExtraction,
  parseSummary,
  parseTurnAnalysis,
  pendingSummary,
  planConsolidation,
  type RoomId,
  type SceneId,
  shouldSummarizeScene,
  type TokenUsage,
  type UsageCategory,
} from '@dramatis/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DramatisDb } from './db';

/**
 * 一轮结束后要做的分析：记录记忆 + 推演状态，**合并成一次调用**（P1-9 批量合并）。
 *
 * 原来固定两次（抽取一次、推演一次），合并省下的那一格正好给 P1-6 的意图调用，
 * 总额仍是「每回合额外调用 ≤ 2」。
 */
export const TURN_ANALYSIS_TASK_KIND = 'turn.analyze';
/** 场景场记（P1-5 的场景层）：把攒够的几轮压成一段。 */
export const SCENE_SUMMARY_TASK_KIND = 'scene.summarize';
/** 章节回顾（P1-5 的章节层）：几场戏滚成一条线索。 */
export const CHAPTER_SUMMARY_TASK_KIND = 'chapter.summarize';
/**
 * 记忆合并（顺序 27a 第二步）：把一个视角下一堆「日常经过」压成一条**印象**。
 *
 * 触发点在每轮结算之后（见 App.tsx），但真正「该不该合并」由这个 runner 拿到
 * 最新数据之后再判断——与场记那条路同一个套路：界面只负责「来看一眼」。
 */
export const MEMORY_CONSOLIDATE_TASK_KIND = 'memory.consolidate';
/** 旧任务类型：老库的队列里可能还排着它们，worker 仍然认得。 */
export const MEMORY_TASK_KIND = 'memory.extract';
export const AFFECT_TASK_KIND = 'affect.update';

/** 每个角色每轮最多带入多少 token 的记忆。 */
export const MEMORY_BUDGET_TOKENS = 800;

export interface TurnTaskPayload {
  roomId: RoomId;
  sceneId: SceneId | null;
  /** 归属的对话；归档一条对话时要按它整批撤销记忆。 */
  conversationId: ConversationId | null;
  turnId: string;
}

/** 摘要任务的负载：只存 id，内容现取（与其它后台任务同一条规矩）。 */
export interface SummaryTaskPayload {
  roomId: RoomId;
  conversationId: ConversationId | null;
  /** 场景层任务才有。 */
  sceneId?: SceneId;
}

/**
 * 一次后台任务的结果。
 *
 * `called` 与 `usage` 必须分开：**没调用**（这一轮没攒够内容）不该记进账单，
 * 而**调用了但服务商没返回用量**要记一笔 0 token 的账——账单记的是「发生过什么」。
 */
interface TaskOutcome {
  called: boolean;
  usage: TokenUsage | null;
}

export interface BackgroundProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  /**
   * 这一档配置的单价（每百万 token），用来把 token 换算成钱。
   *
   * 没填就是 null：账单只报 token 数，不编一个假价格（P3-7）。
   */
  price: ProviderPrice | null;
}

/** 任务类型 → 账单分类。老库里的 `memory.extract` / `affect.update` 也各有归属。 */
const CATEGORY_BY_TASK: Record<string, UsageCategory> = {
  [TURN_ANALYSIS_TASK_KIND]: 'analysis',
  [SCENE_SUMMARY_TASK_KIND]: 'summary',
  [CHAPTER_SUMMARY_TASK_KIND]: 'summary',
  [MEMORY_TASK_KIND]: 'memory',
  [MEMORY_CONSOLIDATE_TASK_KIND]: 'memory',
  [AFFECT_TASK_KIND]: 'affect',
};

export interface BackgroundWorkerApi {
  pending: number;
  running: boolean;
  lastError: string | null;
  /** 立刻尝试清空队列。每轮对话结束后调用。 */
  kick: () => void;
}

function makeProvider(config: BackgroundProviderConfig): ModelProvider {
  return createOpenAICompatibleProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    // 后台任务也要算得清成本：抽取与推演是每回合固定两次调用
    includeUsage: true,
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

  const drainingRef = useRef(false);
  /** `running` 的镜像（顺序 62）：判断「要不要 setState」时不能读渲染期的状态。 */
  const runningRef = useRef(false);
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

  /**
   * 一轮结束后的分析：一份提示词同时拿到「记忆」与「状态变化」（P1-9 批量合并）。
   *
   * 合并的前提是两件事吃同一批消息、同一批在场角色，所以不损失信息；
   * 省下来的调用额度给 P1-6 的意图调用。解析层宽容，模型偶尔只写一半也不会整轮作废。
   */
  const runTurnAnalysis = useCallback(
    async (payload: TurnTaskPayload, config: BackgroundProviderConfig): Promise<TaskOutcome> => {
      if (!db) return { called: false, usage: null };
      const context = await loadTurn(payload);
      if (!context) return { called: false, usage: null };

      const completion = await collectCompletionWithTools(
        makeProvider(config),
        buildTurnAnalysisMessages({
          scene: context.scene,
          cast: context.participants,
          playerName: context.room.playerName,
          messages: context.messages,
        }),
        { temperature: 0.2 },
      );

      /*
       * 落库交给内核的那份共用实现（`applyTurnAnalysis`）：网页版桥接下用户粘回来的
       * 那段输出走的是同一个函数，两条路的幂等与清理规则因此不会漂移。
       */
      await applyTurnAnalysis({
        repository: db.repository,
        roomId: payload.roomId,
        sceneId: payload.sceneId,
        conversationId: payload.conversationId,
        turnId: payload.turnId,
        worldTime: context.scene?.worldTime ?? '',
        participants: context.participants,
        raw: completion.text,
      });

      return { called: true, usage: completion.usage };
    },
    [db, loadTurn],
  );

  /** 旧任务类型：老库队列里可能还排着（抽取、推演各一次）。 */
  const runMemoryExtraction = useCallback(
    async (payload: TurnTaskPayload, config: BackgroundProviderConfig): Promise<TaskOutcome> => {
      if (!db) return { called: false, usage: null };
      const context = await loadTurn(payload);
      if (!context) return { called: false, usage: null };

      const completion = await collectCompletionWithTools(
        makeProvider(config),
        buildExtractionMessages({
          scene: context.scene,
          cast: context.participants,
          playerName: context.room.playerName,
          messages: context.messages,
        }),
        { temperature: 0.2 },
      );
      const raw = completion.text;

      const extraction = parseExtraction(raw);
      const sequence = await db.repository.nextMemorySequence(payload.roomId);
      const { events } = buildMemoryEvents({
        roomId: payload.roomId,
        sceneId: payload.sceneId,
        conversationId: payload.conversationId,
        worldTime: context.scene?.worldTime ?? '',
        sequence,
        participants: context.participants,
        extraction,
        turnId: payload.turnId,
      });

      // 先清掉这一轮可能残留的旧记忆，让重试天然幂等
      await db.repository.deleteMemoriesByTurn(payload.roomId, payload.turnId);
      await db.repository.saveMemories(events);
      return { called: true, usage: completion.usage };
    },
    [db, loadTurn],
  );

  const runAffectUpdate = useCallback(
    async (payload: TurnTaskPayload, config: BackgroundProviderConfig): Promise<TaskOutcome> => {
      if (!db) return { called: false, usage: null };
      const context = await loadTurn(payload);
      if (!context) return { called: false, usage: null };

      // 幂等：同一个回合已经推演过就不再叠加，否则重试会让关系翻倍
      const already = context.participants.some((instance) =>
        instance.affect.history.some((change) => change.turnId === payload.turnId),
      );
      if (already) return { called: false, usage: null };

      const completion = await collectCompletionWithTools(
        makeProvider(config),
        buildAffectMessages({
          cast: context.participants,
          playerName: context.room.playerName,
          messages: context.messages,
        }),
        { temperature: 0.2 },
      );

      const { applied } = applyAffectUpdates(context.participants, parseAffectUpdates(completion.text), {
        at: new Date().toISOString(),
        turnId: payload.turnId,
      });
      for (const item of applied) {
        await db.repository.saveInstance(item.next);
      }
      return { called: true, usage: completion.usage };
    },
    [db, loadTurn],
  );

  /**
   * 场景场记（P1-5 的场景层）。
   *
   * 只压游标之后的消息，所以重跑不会把同一段压两遍；攒不够就**连调用都不发**
   * （`called: false`，不进账单）。摘要写回场景的 `recap`，原文一个字都不动。
   */
  /**
   * 记忆合并（顺序 27a 第二步）。
   *
   * 拿到的是**最新**的记忆列表，再决定要不要合并——界面那边只负责「这一轮结算完了，
   * 来看一眼」。计划函数是纯的（`planConsolidation`），所以这里只做三件事：
   * 看计划 → 调一次模型 → 把印象与「已盖章的原文」一起落库。
   *
   * 一次只处理**一组**：一组 40 条压成 1 条已经省下 39 条的位置，
   * 而每一次调用都在花用户的钱。积压的话下一轮任务会接着处理。
   */
  const runMemoryConsolidation = useCallback(
    async (payload: TurnTaskPayload, config: BackgroundProviderConfig): Promise<TaskOutcome> => {
      if (!db) return { called: false, usage: null };

      const memories = await db.repository.listMemories(payload.roomId);
      const group = planConsolidation(memories)[0];
      if (group === undefined) return { called: false, usage: null };

      const completion = await collectCompletionWithTools(
        makeProvider(config),
        [{ role: 'user', content: buildConsolidationPrompt(group, memories) }],
        { temperature: 0.2 },
      );

      const result = applyConsolidation({ group, memories, reply: completion.text });
      /*
       * 原文与印象**一起写**：印象先落库、原文盖章失败的话，下一轮会把同一批再压一次，
       * 于是同一个印象会有两份（内容一样但 id 不同）。一次写完就没有这个窗口。
       */
      const toSave = [...result.originals, ...(result.impression === null ? [] : [result.impression])];
      if (toSave.length > 0) await db.repository.saveMemories(toSave);

      return { called: true, usage: completion.usage };
    },
    [db],
  );

  const runSceneSummary = useCallback(
    async (payload: SummaryTaskPayload, config: BackgroundProviderConfig): Promise<TaskOutcome> => {
      if (!db || payload.sceneId === undefined) return { called: false, usage: null };

      const scene = await db.repository.getScene(payload.sceneId);
      if (!scene) return { called: false, usage: null };

      // 带上墓碑：场记游标那条被删了也要认得出位置（审计 C4），输出里墓碑会被滤掉
      const messages = await db.repository.listMessages(payload.roomId, { includeDeleted: true });
      // **触发判断只在这一处**：界面只负责「这一轮结算完了，来看一眼」，
      // 攒够没攒够由拿到最新数据的人判断。放在界面侧会让过期的场景对象
      // 重复触发（真机第一轮就出现过两次摘要调用）。
      //
      // 已结束的场景例外（顺序 58）：换场时排的那趟「收尾」原来也按 8 轮 / 2400 token 判，
      // 于是每一场最后的几轮永远进不了场记；历史按场记覆盖收起之后，它们会永久留在提示词里。
      // 结束了、还有没压的尾巴，就压——一场只多一次小调用。
      const closedWithTail = scene.endedAt !== null && pendingSummary(scene, messages).messages.length > 0;
      if (!closedWithTail && !shouldSummarizeScene(scene, messages)) return { called: false, usage: null };
      const pending = pendingSummary(scene, messages);

      const room = await db.repository.getRoom(payload.roomId);
      const instances = await db.repository.listInstances(payload.roomId);
      const audience = new Set(pending.messages.flatMap((message) => message.audience));
      // 场记里的人名要与原文对得上：谁在这场戏里说过话，或者本来就在名单上
      const cast = instances.filter((instance) => audience.has(instance.id) || scene.cast.includes(instance.id));

      const completion = await collectCompletionWithTools(
        makeProvider(config),
        buildSceneSummaryMessages({
          scene,
          cast: cast.map((instance) => ({ id: instance.id, displayName: instance.displayName })),
          playerName: room?.playerName ?? '玩家',
          messages: pending.messages,
          previousSummary: scene.recap ?? '',
        }),
        { temperature: 0.2 },
      );

      const parsed = parseSummary(completion.text);
      if (parsed.summary !== '') {
        const recap =
          parsed.keyFacts.length === 0 ? parsed.summary : `${parsed.summary}\n要点：${parsed.keyFacts.join('；')}`;
        const lastSeq = pending.messages.reduce(
          (max, message) => Math.max(max, message.localSeq),
          scene.recapUpToSeq ?? 0,
        );
        // 游标记消息 id（合并之后 localSeq 会撞号），序号只作为老数据的兜底
        const lastMessage = pending.messages.at(-1);
        await db.repository.saveScene({
          ...scene,
          recap,
          recapUpToSeq: lastSeq,
          ...(lastMessage === undefined ? {} : { recapUpToMessageId: lastMessage.id }),
          recapUpdatedAt: nowIso(),
        });
      }
      // 空摘要也算调用过了：账照记，游标不动，下一轮重新攒
      return { called: true, usage: completion.usage };
    },
    [db],
  );

  /**
   * 章节回顾（P1-5 的章节层）。
   *
   * 只收「已经有场记」的场景——还有原文的场景不需要提前压。攒不够就返回，
   * 不发调用。
   */
  const runChapterSummary = useCallback(
    async (payload: SummaryTaskPayload, config: BackgroundProviderConfig): Promise<TaskOutcome> => {
      if (!db) return { called: false, usage: null };

      const scenes = await db.repository.listScenes(payload.roomId);
      const scoped =
        payload.conversationId === null
          ? scenes
          : scenes.filter((scene) => scene.conversationId === payload.conversationId);
      const chapters = await db.repository.listChapterSummaries(
        payload.roomId,
        payload.conversationId === null ? {} : { conversationId: payload.conversationId },
      );

      const candidates = chapterCandidates({
        scenes: scoped,
        coveredSceneIds: chapters.flatMap((chapter) => chapter.sceneIds),
      });
      if (candidates.scenes.length === 0) return { called: false, usage: null };

      const room = await db.repository.getRoom(payload.roomId);
      const first = candidates.scenes[0];
      const name = first === undefined ? '前情' : first.location.trim() === '' ? first.title : first.location.trim();

      const completion = await collectCompletionWithTools(
        makeProvider(config),
        buildChapterSummaryMessages({
          title: name,
          playerName: room?.playerName ?? '玩家',
          scenes: candidates.scenes.map((scene) => ({
            title: scene.title,
            location: scene.location,
            summary: scene.recap ?? '',
          })),
        }),
        { temperature: 0.2 },
      );

      const parsed = parseSummary(completion.text);
      if (parsed.summary !== '') {
        const at = nowIso();
        await db.repository.saveChapterSummary({
          id: newId(),
          roomId: payload.roomId,
          conversationId: payload.conversationId,
          title: `第 ${String(chapters.length + 1)} 章 · ${name}`,
          sceneIds: candidates.scenes.map((scene) => scene.id),
          summary: parsed.summary,
          keyFacts: parsed.keyFacts,
          createdAt: at,
          updatedAt: at,
          deletedAt: null,
        });
      }
      return { called: true, usage: completion.usage };
    },
    [db],
  );

  /**
   * 场记写完顺手看看够不够滚一章。
   *
   * 幂等键里带上「够了几场」：不够时什么都不做，等更多场戏攒起来之后
   * 数字变大 → 是个新键 → 才会真的跑一次。这样不必额外判断「上次失败了吗」。
   */
  const enqueueChapterIfReady = useCallback(
    async (payload: SummaryTaskPayload) => {
      if (!db) return;

      const scenes = await db.repository.listScenes(payload.roomId);
      const scoped =
        payload.conversationId === null
          ? scenes
          : scenes.filter((scene) => scene.conversationId === payload.conversationId);
      const chapters = await db.repository.listChapterSummaries(
        payload.roomId,
        payload.conversationId === null ? {} : { conversationId: payload.conversationId },
      );
      const candidates = chapterCandidates({
        scenes: scoped,
        coveredSceneIds: chapters.flatMap((chapter) => chapter.sceneIds),
      });
      if (candidates.scenes.length === 0) return;

      await db.queue.enqueue({
        kind: CHAPTER_SUMMARY_TASK_KIND,
        idempotencyKey: `${CHAPTER_SUMMARY_TASK_KIND}:${payload.conversationId ?? 'none'}:${String(candidates.scenes.length)}`,
        roomId: payload.roomId,
        turnId: null,
        payload: { roomId: payload.roomId, conversationId: payload.conversationId },
      });
    },
    [db],
  );

  const drain = useCallback(async () => {
    if (!db || drainingRef.current) return;
    drainingRef.current = true;
    /*
     * 只在「真的开始干活」时置忙（顺序 62）。
     *
     * 8 秒的兜底定时器每响一次都会调 `drain`，而队列常常是空的：
     * 原来无论有没有活干都 `setRunning(true)` / `setRunning(false)`，React 对
     * 「值没变」的 setState 仍会重渲染一次那个组件——而它就在 App 里，
     * 于是**静置时每 8 秒整棵树重画两遍**（600 条消息的列表实测每次 350–840ms）。
     */
    try {
      for (;;) {
        const [task] = await db.queue.take(1);
        if (!task) break;
        // 真拿到活了才置忙：空跑的 tick 不该惊动 React（顺序 62）
        if (!runningRef.current) {
          runningRef.current = true;
          setRunning(true);
        }

        try {
          const config = providerRef.current;
          if (!config || config.apiKey.trim() === '') {
            throw new Error('后台任务缺少可用的模型配置或 API Key');
          }

          /**
           * 熔断检查（P1-9）：每次都拿**最新**的账单与这个世界的上限重算一遍，
           * 而不是用界面渲染时算出来的状态——队列可能积压，界面也可能还没刷新。
           */
          const payload = task.payload as TurnTaskPayload;
          const roomIdForBudget = payload.roomId;
          const room = await db.repository.getRoom(roomIdForBudget);
          const limits = room?.budget ?? null;
          if (limits !== null) {
            const state = evaluateBudget(await db.ledger.summary({ roomId: roomIdForBudget }), limits);
            if (state.burned) {
              // 直接收掉这一条：留着会让它每次启动都重跑一遍
              await db.queue.complete(task.id);
              setLastError(`${state.reason ?? '已达本局上限'}，后台任务已暂停（角色回复不受影响）`);
              continue;
            }
          }

          let outcome: TaskOutcome = { called: false, usage: null };
          if (task.kind === TURN_ANALYSIS_TASK_KIND) {
            outcome = await runTurnAnalysis(payload, config);
          } else if (task.kind === MEMORY_TASK_KIND) {
            outcome = await runMemoryExtraction(payload, config);
          } else if (task.kind === AFFECT_TASK_KIND) {
            outcome = await runAffectUpdate(payload, config);
          } else if (task.kind === SCENE_SUMMARY_TASK_KIND) {
            outcome = await runSceneSummary(task.payload as SummaryTaskPayload, config);
          } else if (task.kind === CHAPTER_SUMMARY_TASK_KIND) {
            outcome = await runChapterSummary(task.payload as SummaryTaskPayload, config);
          } else if (task.kind === MEMORY_CONSOLIDATE_TASK_KIND) {
            outcome = await runMemoryConsolidation(payload, config);
          }

          // 落一笔账。服务商没返回 usage 时 token 记 0，但**这一笔照样记**——
          // 调用确实发生过，不记的话用户会因为漏账而低估开销（T7）。
          // 反过来，**没调用**的（内容没攒够）一笔都不记。
          const category = CATEGORY_BY_TASK[task.kind];
          if (category !== undefined && outcome.called) {
            await db.ledger.record({
              roomId: payload.roomId,
              conversationId: payload.conversationId,
              turnId: payload.turnId,
              category,
              model: config.model,
              promptTokens: outcome.usage?.promptTokens ?? 0,
              completionTokens: outcome.usage?.completionTokens ?? 0,
              price: config.price,
            });
          }

          // 场记更新完，顺手看看够不够滚一章（够了才入队，不够时那一趟是空跑）
          if (task.kind === SCENE_SUMMARY_TASK_KIND && outcome.called) {
            await enqueueChapterIfReady(task.payload as SummaryTaskPayload);
          }

          await db.queue.complete(task.id);
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
      if (runningRef.current) {
        runningRef.current = false;
        setRunning(false);
      }
      await refreshPending();
    }
  }, [
    db,
    enqueueChapterIfReady,
    refreshPending,
    runAffectUpdate,
    runChapterSummary,
    runMemoryExtraction,
    runMemoryConsolidation,
    runSceneSummary,
    runTurnAnalysis,
  ]);

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

  // 返回对象要稳定（顺序 59）：App 把它当依赖，每次渲染新造一个就会让下游的 memo 全部失效
  return useMemo(() => ({ pending, running, lastError, kick }), [pending, running, lastError, kick]);
}
