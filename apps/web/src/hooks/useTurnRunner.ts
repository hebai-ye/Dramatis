import {
  type AssembledPrompt,
  asksAboutPast,
  buildIntentPlanMessages,
  buildTurnAnalysisMessages,
  type Card,
  type CharacterInstance,
  type Conversation,
  collectCompletionWithTools,
  createCharacterMessage,
  createManualProvider,
  createOpenAICompatibleProvider,
  createPlayerMessage,
  createTurnId,
  hasSpeech,
  historyPolicyOf,
  type InstanceId,
  type IntentPlanEntry,
  isIntentFirst,
  type Message,
  type MessageId,
  type MessageUsage,
  matchWorldBookEntries,
  needsWebBridge,
  type PromptMemory,
  parseIntentPlan,
  pickPlannedSpeaker,
  type RecalledForPrompt,
  type Room,
  recallForPrompt,
  renderPromptForWeb,
  runTurn,
  type Scene,
  scheduleSpeakers,
  turnsSinceLastSpoke,
} from '@dramatis/core';
import { useCallback, useRef } from 'react';
import type { WebBridgeState } from '../components/WebBridgePanel';
import type { DramatisDb } from '../lib/db';
import { replyTokenLimit } from '../lib/output-limit';
import type { ProvidersApi } from '../lib/providers';
import type { SessionApi } from '../lib/session';
import { resetStreamState, setStreamState } from '../lib/stream-store';
import type { SyncApi } from '../lib/sync';
import {
  enqueueMemoryConsolidation as enqueueMemoryConsolidationTask,
  enqueueSceneSummary as enqueueSceneSummaryTask,
  enqueueTurnAnalysis,
  recordModelCall,
} from '../lib/turn-bookkeeping';
import type { UsageApi } from '../lib/usage';
import { type BackgroundWorkerApi, MEMORY_BUDGET_TOKENS } from '../lib/worker';
import type { Notice } from './useNotices';

function toPromptMemory(recalled: RecalledForPrompt): PromptMemory {
  const event = recalled.event;
  return {
    id: event.id,
    summary: event.summary,
    score: recalled.score,
    // 常规召回 / 提到才想起 / 印象来源：装配时按它标记，检查器按它统计（顺序 57）
    origin: recalled.origin,
    ...(event.perception !== '' ? { perception: event.perception } : {}),
    ...(event.timeline.worldTime !== '' ? { worldTime: event.timeline.worldTime } : {}),
  };
}

/** 取第一句当「盘算」，太长就截断——它是给用户的提示，不是存档。 */
function firstSentence(text: string): string {
  const flat = text.trim().replace(/\s*\n\s*/g, ' ');
  const match = /^[^。！？.!?\n]{4,80}/.exec(flat);
  const sentence = (match?.[0] ?? flat.slice(0, 60)).trim();
  return sentence.length <= 60 ? sentence : `${sentence.slice(0, 60)}…`;
}

export interface TurnRunnerOptions {
  db: DramatisDb | null;
  session: SessionApi;
  providers: ProvidersApi;
  usage: UsageApi;
  worker: BackgroundWorkerApi;
  sync: SyncApi;
  world: Room | null;
  conversation: Conversation | null;
  scene: Scene | null;
  messages: Message[];
  instances: CharacterInstance[];
  /** 本局是否已达调用预算上限（P1-9 熔断）：到了就不问「谁开口」、也不排后台任务。 */
  burned: boolean;
  /** 到上限时给用户看的那句话（原来是 `budget.reason`）。 */
  budgetReason: string | null;
  /** 这一轮生成是不是已经在跑（跑着的时候再点发送什么都不做）。 */
  busy: boolean;
  setBusy: (value: boolean) => void;
  setError: (message: string | null) => void;
  setWarnings: (next: Notice[]) => void;
  setBridge: (next: WebBridgeState | null) => void;
  /** 装配出来的提示词（运行时面板的「提示词」页要显示它）。 */
  setLastPrompt: (prompt: AssembledPrompt | null) => void;
}

export interface TurnRunnerApi {
  /** 把一条角色回复造成消息（网页版桥接的第一步也走它，所以对外返回）。 */
  makeCharacterLine: (speaker: CharacterInstance, content: string, turnId: string, sceneValue: Scene) => Message;
  /** 让后台看一眼这一场要不要压场记（换场时也要用，所以对外返回）。 */
  enqueueSceneSummary: (target: Scene, key: string) => Promise<void>;
  handleSend: (text: string) => Promise<void>;
  handleRegenerate: (id: MessageId) => Promise<void>;
  handleReassignMessage: (id: MessageId, instanceId: InstanceId) => Promise<void>;
  /** 停止这一轮生成（输入区那颗「停止」）。 */
  stop: () => void;
}

/**
 * 一轮对话的主循环（顺序 66 从 App.tsx 搬出来，纯搬家不改行为）。
 *
 * 搬走的是四块里最大的那一块：`runGeneration`（跑一次生成）、`runIntentPlan`
 * （生成前的导演调用）、`handleSend`（发一句：落玩家这句 → 排谁说话 → 逐人生成 →
 * 排后台任务）、`handleRegenerate`（重抽，连同这一轮的后台写入一起撤销）、
 * `handleReassignMessage`（改归属，按重抽那条路重算）。顺带搬来了它们共用的
 * `makeCharacterLine`（造一条角色消息）、`enqueueSceneSummary` / `enqueueMemoryConsolidation`
 * （把两件后台活排进队列）以及流式的 `abortRef`。
 *
 * 为什么单独一个 hook：这五件事一起构成聊天主循环（发一句 / 重抽 / 改归属都靠它），
 * 依赖面有二十多项，留在 1853 行的 App 里既难读也容易在改动时碰坏别的部分。
 * 对外只暴露 App 真正还要用的入口——`runGeneration` / `runIntentPlan` 只在这个
 * hook 内部使用，不返回，免得外面多出两条能绕过主循环的路。
 */
export function useTurnRunner({
  db,
  session,
  providers,
  usage,
  worker,
  sync,
  world,
  conversation,
  scene,
  messages,
  instances,
  burned,
  budgetReason,
  busy,
  setBusy,
  setError,
  setWarnings,
  setBridge,
  setLastPrompt,
}: TurnRunnerOptions): TurnRunnerApi {
  /** 这一轮生成的取消句柄（「停止」按钮按它）。 */
  const abortRef = useRef<AbortController | null>(null);
  const stop = useCallback(() => abortRef.current?.abort(), []);

  /** 跑一次生成，返回角色说出的完整内容。 */
  const runGeneration = useCallback(
    async (options: {
      speaker: CharacterInstance;
      card: Card;
      history: Message[];
      playerInput: string;
      memories?: readonly PromptMemory[];
      /**
       * 判「提到」用的玩家这一句（顺序 57/58）：同一回合第二名角色发言时 `playerInput` 为空
       * （玩家的话已经在历史里），但「提到什么」仍然要按玩家这一句判。缺省用 `playerInput`。
       */
      mentionText?: string;
      showStream: boolean;
      signal: AbortSignal;
      /** 导演调用给出的这一轮打算（P1-6）；没有就退回让模型自己判断。 */
      intent?: { intent: string; mode: string } | null;
    }): Promise<{
      text: string;
      usage: MessageUsage | null;
      reasoning: string;
      /** 这一次装配出来的提示词。网页版桥接要把它整段交给用户。 */
      prompt: AssembledPrompt | null;
    }> => {
      const profile = providers.active;
      if (!profile || !world || !scene) return { text: '', usage: null, reasoning: '', prompt: null };

      /*
       * 没有 Key 的时候换成「不联网的模型」：装配照常跑（世界书、记忆召回、预算守卫、
       * 视角裁剪一个都不少），但不产出任何内容——提示词随后交给网页版桥接。
       * 这样两条路共用**同一份提示词**，而不是各写一套。
       */
      const provider = needsWebBridge(providers.apiKey)
        ? createManualProvider(profile.model)
        : createOpenAICompatibleProvider({
            baseUrl: profile.baseUrl,
            apiKey: providers.apiKey,
            model: profile.model,
            // 要真实用量：这是 P3-7 的成本统计，也是 P1-9 设熔断阈值的依据
            includeUsage: true,
          });

      /*
       * 世界书按关键词命中插入（顺序 60）：窗口按时间从旧到新给过去，
       * **每条条目用自己的 `scanDepth`** 从末尾截取（没写就用全局默认 8 条），
       * 递归、group 与概率都在 `matchWorldBookEntries` 里处理。
       */
      const scanLines = [...options.history.map((message) => message.content), options.playerInput];
      const worldBookMatches = session.worldBooks.flatMap((book) => matchWorldBookEntries(book, { scanLines }));

      let accumulated = '';
      let usage: MessageUsage | null = null;
      // 推理流也算「模型自己的盘算」：它不肯按格式写意图时，这是唯一真实的计划来源
      let reasoning = '';
      let assembled: AssembledPrompt | null = null;
      const mentionText = options.mentionText ?? options.playerInput;
      for await (const event of runTurn(
        {
          card: options.card,
          instance: options.speaker,
          room: world,
          scene,
          player: {
            name: conversation?.playerName ?? world.playerName,
            description: conversation?.playerPersona ?? world.playerPersona,
          },
          cast: instances,
          history: options.history,
          playerInput: options.playerInput,
          worldBookMatches,
          memories: options.memories === undefined ? [] : [...options.memories],
          // 前情提要（P1-5）：早就不在窗口里的那几场戏，压成几行带过来
          chapters: session.chapters,
          attachmentSources: { memories: session.memories, chapters: session.allChapters },
          modes: conversation?.modes,
          /*
           * 历史按场记覆盖收起（顺序 58）：这条对话的全部场景用来判断哪些原文已被场记覆盖、
           * 带上还没进章节的前几场场记；策略落在对话模式里（缺省 recap-aware / 40）；
           * 玩家这一句提到收起段里的什么，装配会把那几条原文取回来。
           */
          scenes: session.scenes,
          historyPolicy: historyPolicyOf(conversation?.modes),
          mention: { text: mentionText, askingPast: asksAboutPast(mentionText) },
          ...(options.intent === undefined || options.intent === null
            ? {}
            : { intent: options.intent.intent, intentMode: options.intent.mode as 'reply' }),
          budget: { maxTokens: profile.maxTokens, reserveForReply: profile.reserveForReply },
        },
        provider,
        {
          // reserveForReply 只为提示词腾出空间，并不会限制供应商输出；
          // 普通聊天模型单角色最多 512 token；推理模型的额度还包含隐藏推理，不硬截断。
          params: {
            temperature: profile.temperature,
            maxTokens: replyTokenLimit(profile.model, profile.reserveForReply),
          },
          signal: options.signal,
        },
      )) {
        switch (event.type) {
          case 'prompt':
            assembled = event.prompt;
            setLastPrompt(event.prompt);
            break;
          case 'reasoning':
            reasoning += event.text;
            setStreamState('main', { reasoning });
            break;
          case 'text':
            accumulated += event.text;
            if (options.showStream) setStreamState('main', { text: accumulated });
            break;
          case 'done':
            accumulated = event.text;
            usage = event.usage;
            break;
        }
      }
      return { text: accumulated, usage, reasoning, prompt: assembled };
    },
    [
      conversation,
      instances,
      providers,
      scene,
      session.allChapters,
      session.chapters,
      session.memories,
      session.scenes,
      session.worldBooks,
      world,
      setLastPrompt,
    ],
  );

  const makeCharacterLine = useCallback(
    (speaker: CharacterInstance, content: string, turnId: string, sceneValue: Scene): Message =>
      createCharacterMessage({
        roomId: sceneValue.roomId,
        conversationId: sceneValue.conversationId,
        sceneId: sceneValue.id,
        turnId,
        speakerInstanceId: speaker.id,
        speakerName: speaker.displayName,
        content,
        audience: sceneValue.cast,
      }),
    [],
  );

  /**
   * 生成前的导演调用（P1-6）。返回 null 表示这一轮不用它。
   *
   * 走后台/便宜模型配置；用户在对话模式里关掉「意图先行」时直接跳过。
   */
  const runIntentPlan = useCallback(
    async (input: {
      text: string;
      history: Message[];
      scene: Scene;
      instances: CharacterInstance[];
      turnId: string;
    }): Promise<IntentPlanEntry[] | null> => {
      if (!isIntentFirst(conversation?.modes)) return null;
      // 熔断：已达本局上限就不再问「谁开口、想做什么」，退回纯规则调度
      if (burned) return null;
      const config =
        providers.background ??
        (providers.active === null
          ? null
          : {
              baseUrl: providers.active.baseUrl,
              apiKey: providers.apiKey,
              model: providers.active.model,
              temperature: 0.2,
              price: providers.active.price ?? null,
            });
      if (config === null || config.apiKey.trim() === '') return null;

      try {
        const completion = await collectCompletionWithTools(
          createOpenAICompatibleProvider({
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            model: config.model,
          }),
          buildIntentPlanMessages({
            scene: input.scene,
            cast: input.instances.filter(
              (instance) => instance.presence === 'onstage' && input.scene.cast.includes(instance.id),
            ),
            playerName: world?.playerName ?? '玩家',
            playerInput: input.text,
            recentMessages: input.history.slice(-8),
            maxSpeakers: 1,
          }),
          { temperature: config.temperature },
        );
        // 这一调用的开销也要算进成本：它是每回合固定多出来的一次。
        // 走账单而不是内存计数——刷新之后这笔钱还得在（T7）
        await recordModelCall(db, {
          category: 'intent',
          model: config.model,
          roomId: world?.id ?? null,
          conversationId: conversation?.id ?? null,
          turnId: input.turnId,
          usage: completion.usage ?? null,
          price: config.price,
        });
        void usage.reload();
        return parseIntentPlan(completion.text);
      } catch {
        // 导演调用失败不该拦下这一轮：退回规则调度，照样能玩
        return null;
      }
    },
    [burned, conversation, db, providers, usage, world],
  );

  /** 当前世界与对话下压一场场记（拼装部分在 lib/turn-bookkeeping.ts，顺序 65）。 */
  const enqueueSceneSummary = useCallback(
    async (target: Scene, key: string) => {
      if (!db || !world || !conversation || burned) return;
      await enqueueSceneSummaryTask(db, worker, {
        roomId: world.id,
        conversationId: conversation.id,
        sceneId: target.id,
        key,
      });
    },
    [burned, conversation, db, worker, world],
  );

  /** 当前对话的记忆该不该合并（顺序 27a；阈值判断在 worker 里）。 */
  const enqueueMemoryConsolidation = useCallback(async () => {
    if (!db || !world || !conversation || burned) return;
    await enqueueMemoryConsolidationTask(db, worker, { roomId: world.id, conversationId: conversation.id });
  }, [burned, conversation, db, worker, world]);

  const handleSend = useCallback(
    async (text: string) => {
      /*
       * 以前这里是一句 `return`：世界/场景/对话还没加载完时点发送，**什么都不发生**，
       * 用户只会觉得「按钮坏了」（侧边浏览器真机测试里撞到过一次这种静默失败）。
       * 现在把话说出来——这一句只在真正没准备好的那一瞬间出现。
       */
      if (!db || !world || !scene || !conversation) {
        setWarnings([
          { code: 'turn.not-ready', message: '这条世界线还在加载（世界 / 场景 / 对话），稍等一下再点一次。' },
        ]);
        return;
      }
      if (busy) return;

      const profile = providers.active;
      if (!profile) {
        setError('还没有模型配置');
        return;
      }
      /*
       * 没有 API Key 不再是死路：走**网页版桥接**——应用把提示词交给你，
       * 你贴进 DeepSeek 网页版，再把回复粘回来。第一次打开这个应用的人
       * 手里多半没有 Key，挡在这里等于挡掉「先看看好不好玩」这件事。
       */
      const manual = needsWebBridge(providers.apiKey);

      setError(null);
      setBusy(true);
      setStreamState('main', { text: '', speaker: '', reasoning: '', phase: 'planning' });
      setBridge(null);

      const turnId = createTurnId();
      const history = messages;

      const playerMessage = createPlayerMessage({
        roomId: world.id,
        conversationId: conversation.id,
        sceneId: scene.id,
        turnId,
        speakerName: world.playerName,
        content: text,
        audience: scene.cast,
      });
      await session.appendMessages([playerMessage]);

      const controller = new AbortController();
      abortRef.current = controller;
      let continuedHistory: Message[] = [...history, playerMessage];

      try {
        // 只有真的说了话的那一轮才算「发言」：全程只做动作的角色不该被冷却压住
        const spokeHistory = history.filter((message) => message.role !== 'character' || hasSpeech(message.content));
        const since = turnsSinceLastSpoke(spokeHistory, turnId);
        const previousSpeakerId =
          [...history].reverse().find((message) => message.role === 'character')?.speakerInstanceId ?? null;

        // 每个角色上一轮自己声明的意图（P1-6）：说自己「只是在看」的人，这一轮让一让
        const lastIntentByInstance = new Map<InstanceId, string>();
        for (const message of history) {
          if (message.role !== 'character' || message.speakerInstanceId === null) continue;
          if (message.intent === undefined) continue;
          lastIntentByInstance.set(message.speakerInstanceId, message.intent);
        }

        const schedule = scheduleSpeakers({
          playerInput: text,
          candidates: instances.map((instance) => ({
            instance,
            turnsSinceSpoke: since.get(instance.id) ?? null,
            lastIntent: lastIntentByInstance.get(instance.id) ?? null,
          })),
          // 名单以当前场景为准：presence 是「他在这个世界的状态」，
          // 而多条对话并存时，onstage 的角色未必在这条线的这场戏里
          cast: scene.cast,
          // 玩家接着往下说时，仍由上一位接话，不要因为冷却就换人
          previousSpeakerId,
          maxSpeakers: 1,
        });

        /**
         * 生成前的导演调用（P1-6）。
         *
         * 规则调度器读不懂「这句话其实是在刺秦娘」，这一调用能；它给出的意图还会
         * 写进生成提示词，让角色照着自己的打算落笔。用便宜模型（后台配置）跑，
         * 并且**只是建议**：名字不在名单里就退回规则调度，绝不让看不见的人上台。
         * 用户可以在「对话模式」里关掉它，省下这一次调用。
         */
        const plan = await runIntentPlan({ text, history, scene, instances, turnId });
        const sceneCast = instances.filter(
          (instance) => instance.presence === 'onstage' && scene.cast.includes(instance.id),
        );
        const planned = plan === null ? null : pickPlannedSpeaker(plan, sceneCast);
        const speakers = planned === null ? schedule.speakers : [planned.instance.id];
        const intentByInstance = new Map<InstanceId, { intent: string; mode: string }>();
        if (planned !== null) intentByInstance.set(planned.instance.id, { intent: planned.intent, mode: planned.mode });

        let first = true;
        for (const speakerId of speakers) {
          const speaker = instances.find((item) => item.id === speakerId);
          if (!speaker) continue;
          const speakerCard = session.cards.find((item) => item.id === speaker.cardId);
          if (!speakerCard) continue;

          // 只召回这个人自己的视角条目
          const now = new Date().toISOString();
          /*
           * 顺序 27c：跨对话旧记忆不能再走普通召回，否则附件索引已经省下的正文
           * 会从另一条路原样漏回来。常规召回只看当前对话；旧对话由记忆附件
           * 在关键词/过去意图命中时按需展开。
           */
          const recallPool = session.memories.filter((memory) => memory.conversationId === conversation?.id);
          /*
           * 顺序 57：统一的记忆入口。常规通路只在**未被印象取代**的条目里召回
           * （合并过的原文不再线性涨池子），兜底上限照旧（T22：有命中时最多再带两条
           * 「顺带想起」，实测 800 token 里原本平均 5 条是无关条目，EVAL 第五节）。
           * 被取代的原文只走两条补充通路：玩家**这一句**提到了它的关键词（不看历史，
           * 否则一个词会连着六轮翻旧账），或玩家在问过去时顺着印象的来源展开。
           */
          const recall = recallForPrompt(
            recallPool,
            {
              observerId: speaker.id,
              text: [text, ...history.slice(-6).map((message) => message.content)].join('\n'),
              participantIds: scene.cast,
              location: scene.location,
              now,
            },
            {
              budgetTokens: MEMORY_BUDGET_TOKENS,
              mentionText: text,
              askingPast: asksAboutPast(text),
            },
          );
          const recalled = recall.selected;

          setStreamState('main', { text: '', reasoning: '', speaker: speaker.displayName, phase: 'writing' });
          const plannedIntent = intentByInstance.get(speaker.id) ?? null;
          const generation = await runGeneration({
            speaker,
            card: speakerCard,
            history: first ? history : continuedHistory,
            playerInput: first ? text : '',
            // 第二名角色发言时 playerInput 为空，但「提到了什么」仍按玩家这一句判
            mentionText: text,
            memories: recalled.map(toPromptMemory),
            showStream: true,
            signal: controller.signal,
            intent: plannedIntent,
          });

          // 记一笔账。服务商没返回 usage 时 token 记 0，但调用确实发生过，
          // 所以这一条照样记——漏账会让用户低估开销（T7）
          // 网页版那一轮不经过服务商，没有 token 也没有钱——记一条 0 只会污染账单
          if (!manual) {
            await recordModelCall(db, {
              category: 'generation',
              model: profile.model,
              roomId: world.id,
              conversationId: conversation.id,
              turnId,
              usage: generation.usage,
              price: profile.price ?? null,
              speaker: { id: speaker.id, name: speaker.displayName },
            });
          }

          const reply = generation.text;
          first = false;

          if (recalled.length > 0) {
            void session.markRecalled(
              recalled.map((item) => item.event),
              now,
            );
          }

          /*
           * 网页版桥接：装配完了但没人接话（`createManualProvider` 不产出内容），
           * 于是把这份提示词原样交给用户，进入第一阶段。
           */
          if (manual) {
            if (generation.prompt === null) {
              setError('提示词装配失败，这一轮没法转到网页版。');
              continue;
            }
            setBridge({
              stage: 'reply',
              turnId,
              speakerInstanceId: speaker.id,
              speakerName: speaker.displayName,
              prompt: renderPromptForWeb(generation.prompt.messages),
            });
            continue;
          }

          if (reply.trim() === '') {
            throw new Error('模型没有返回可显示的角色回复。玩家消息已保留，请检查模型设置后重试。');
          }
          const created = makeCharacterLine(speaker, reply, turnId, scene);
          if (created.content.trim() === '') {
            throw new Error('模型只返回了格式标记，没有可显示的角色回复。玩家消息已保留，请重试。');
          }
          const line: Message = {
            ...created,
            // 用量挂在消息上：刷新之后仍然能看见这一轮花了多少
            ...(generation.usage === null ? {} : { usage: generation.usage }),
            // 导演调用给出的意图挂在消息上：用户能看到「他这一轮想做什么」
            ...(plannedIntent === null ? {} : { intent: plannedIntent.intent, intentSource: 'planned' as const }),
            // 没按格式声明意图时，用它自己的推理首句当盘算（有推理流的模型才有）
            ...(plannedIntent === null && created.intent === undefined && generation.reasoning.trim() !== ''
              ? { intent: firstSentence(generation.reasoning), intentSource: 'reasoning' as const }
              : {}),
          };
          await session.appendMessages([line]);
          continuedHistory = [...continuedHistory, line];
          // 落盘后立刻收掉流式副本，避免后台排队/记账期间同一条回复显示两遍。
          // 消息快照只在 appendMessages 更新一次；finally 的 reset 此时是 no-op。
          resetStreamState('main');
        }

        // 一轮分析（记忆 + 状态变化）合成一次调用，不阻塞对话；负载只存 id，内容现取
        await usage.reload();
        /*
         * 网页版桥接下不排后台任务：这里没有模型可用，排进去只会变成一条失败记录。
         * 记忆与情绪的落库改由桥接的第二步承担（用户贴回来时当场写）。
         */
        if (manual) return;
        // 让后台看一眼这一场要不要压场记（够不够由后台判断，不够不会发调用）
        await enqueueSceneSummary(scene, turnId);
        // 再看一眼这一条对话的记忆该不该合并（顺序 27a；同样由后台判断阈值）
        await enqueueMemoryConsolidation();
        // 熔断时不再排后台任务：这一轮照常生成，但不写记忆、不推演状态
        if (burned) {
          setWarnings([
            {
              code: 'budget',
              message: `${budgetReason ?? '已达本局上限'}——这一轮只生成回复，不做意图判断与后台记录。可在运行时的「用量」页调整上限。`,
            },
          ]);
          return;
        }
        await enqueueTurnAnalysis(db, worker, {
          roomId: world.id,
          conversationId: conversation.id,
          sceneId: scene.id,
          turnId,
        });
      } catch (sendError) {
        const message = sendError instanceof Error ? sendError.message : String(sendError);
        setError(controller.signal.aborted ? `已停止生成（${message}）` : message);
      } finally {
        resetStreamState('main');
        setBusy(false);
        abortRef.current = null;
        /*
         * 一轮结束就排一次同步（节流 20 秒，见 lib/sync.ts）。
         *
         * 放在 finally 而不是 try 末尾：中途报错、用户点了停止，这一轮已经落库的
         * 东西照样该推出去——「聊完这轮手机上就能看到」不该因为一次调用失败而失效。
         */
        sync.requestAutoSync();
      }
    },
    [
      budgetReason,
      burned,
      busy,
      conversation,
      db,
      enqueueSceneSummary,
      enqueueMemoryConsolidation,
      instances,
      makeCharacterLine,
      messages,
      providers,
      runGeneration,
      runIntentPlan,
      scene,
      session,
      sync,
      usage,
      worker,
      world,
      setBusy,
      setError,
      setBridge,
      setWarnings,
    ],
  );

  /**
   * 重抽。
   *
   * 关键是**把这一轮的后台写入一起撤销**：取消排队中的任务，删掉旧回复，
   * 再把已经落盘的情绪变化反向还原。只删消息不撤状态，关系会越抽越高。
   */
  const handleRegenerate = useCallback(
    async (id: MessageId) => {
      if (!db || !world || !scene || !conversation || busy) return;

      const target = messages.find((message) => message.id === id);
      if (!target) return;

      const turnMessages = messages.filter((message) => message.turnId === target.turnId);
      const playerMessage = turnMessages.find((message) => message.role === 'player');
      if (!playerMessage) {
        setError('这一轮找不到对应的玩家发言，无法重抽');
        return;
      }

      const speaker = instances.find((item) => item.id === target.speakerInstanceId);
      const speakerCard = speaker ? session.cards.find((item) => item.id === speaker.cardId) : null;
      if (!speaker || !speakerCard) {
        setError('找不到这条回复对应的角色');
        return;
      }

      setError(null);
      setBusy(true);
      setStreamState('main', { text: '', reasoning: '', speaker: speaker.displayName, phase: 'writing' });

      const earlierHistory = messages.filter((message) => message.turnId !== target.turnId);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const generation = await runGeneration({
          speaker,
          card: speakerCard,
          history: earlierHistory,
          playerInput: playerMessage.content,
          showStream: true,
          signal: controller.signal,
        });

        // 重抽同样是一次真实调用：旧的那笔账不撤销（钱花了），新的这笔记上
        await recordModelCall(db, {
          category: 'generation',
          model: providers.active?.model ?? '',
          roomId: world.id,
          conversationId: conversation.id,
          turnId: target.turnId,
          usage: generation.usage,
          price: providers.active?.price ?? null,
          speaker: { id: speaker.id, name: speaker.displayName },
        });
        await usage.reload();

        if (generation.text.trim() === '') {
          throw new Error('模型没有返回可显示的角色回复，原回复已保留。请检查模型设置后重试。');
        }
        const replacement = makeCharacterLine(speaker, generation.text, target.turnId, scene);
        if (replacement.content.trim() === '') {
          throw new Error('模型只返回了格式标记，原回复已保留。请重试。');
        }

        // 先确认完整的新回复，再撤销旧回复与后台状态。服务商过滤、截断或断流时，
        // 不触碰旧消息、记忆和队列；它们仍是这一轮最后一次成功的结果。
        // clearTurn 会移除已完成任务的幂等键，以便新的分析重新入队。
        await db.queue.clearTurn(target.turnId);
        await session.revertTurn(target.turnId);
        await session.appendMessages([
          {
            ...replacement,
            ...(generation.usage === null ? {} : { usage: generation.usage }),
          },
        ]);
        for (const message of turnMessages) {
          if (message.role === 'character') await session.deleteMessage(message.id);
        }

        // 重抽撤销了这一轮的后台任务，必须重新排一次队。
        // 不补这一步的话，被重抽的那一轮会永远不再抽取记忆——角色的记忆里
        // 就永久缺了一段（真实模型端到端测试里就是这样发现的：重抽两次之后
        // 记忆条数少了一条，再也没有回来）。
        await enqueueTurnAnalysis(db, worker, {
          roomId: world.id,
          conversationId: conversation.id,
          sceneId: scene.id,
          turnId: target.turnId,
        });
      } catch (regenerateError) {
        const message = regenerateError instanceof Error ? regenerateError.message : String(regenerateError);
        setError(controller.signal.aborted ? `已停止生成（${message}）` : message);
      } finally {
        resetStreamState('main');
        setBusy(false);
        abortRef.current = null;
      }
    },
    [
      busy,
      conversation,
      db,
      instances,
      makeCharacterLine,
      messages,
      providers,
      runGeneration,
      scene,
      session,
      usage,
      worker,
      world,
      setBusy,
      setError,
    ],
  );

  /**
   * 改归属（T18）：这条回复其实是别人说的。
   *
   * 不只是换个名字——**这一轮的后台写入要重算**：谁说的话，抽取出来的视角记忆
   * 与关系变化都不一样。所以按重抽那条路径来：清掉该回合的队列记录、撤销已写入的
   * 记忆与情绪变化，改完归属再重新排队。
   */
  const handleReassignMessage = useCallback(
    async (id: MessageId, instanceId: InstanceId) => {
      if (!db || !world || !conversation) return;
      const target = messages.find((message) => message.id === id);
      const speaker = session.instances.find((instance) => instance.id === instanceId);
      if (!target || !speaker || target.speakerInstanceId === instanceId) return;

      setError(null);
      await session.updateMessage(id, { speakerInstanceId: speaker.id, speakerName: speaker.displayName });

      await db.queue.clearTurn(target.turnId);
      await session.revertTurn(target.turnId);

      /*
       * 网页版模式：没有模型可调，所以「重算这一轮」改成再贴一次第二步。
       * 不这么做的话，改完归属这一轮的记忆就永久空了（撤销容易、重写没路）。
       */
      if (needsWebBridge(providers.apiKey)) {
        const turnMessages = [
          ...messages.filter((message) => message.turnId === target.turnId && message.id !== id),
          { ...target, speakerInstanceId: speaker.id, speakerName: speaker.displayName },
        ].sort((left, right) => (left.createdAt < right.createdAt ? -1 : 1));
        const cast = session.instances.filter((instance) => instance.presence === 'onstage');
        setBridge({
          stage: 'analysis',
          turnId: target.turnId,
          speakerInstanceId: speaker.id,
          speakerName: speaker.displayName,
          prompt: renderPromptForWeb(
            buildTurnAnalysisMessages({
              scene: session.scene,
              cast,
              playerName: world.playerName,
              messages: turnMessages,
            }),
          ),
        });
        setWarnings([
          {
            code: 'bridge.reassign',
            message:
              '说话的人换了，所以这一轮已经写下的记忆与情绪被清掉了。把下面这段提示词再贴一次网页版，就能按新的归属重写。',
          },
        ]);
        return;
      }

      // distinct：clearTurn 已经清掉旧记录，带上时间戳保证一定起一条新任务
      await enqueueTurnAnalysis(db, worker, {
        roomId: world.id,
        conversationId: conversation.id,
        sceneId: target.sceneId,
        turnId: target.turnId,
        distinct: true,
      });
    },
    [conversation, db, messages, providers.apiKey, session, worker, world, setWarnings, setError, setBridge],
  );

  return {
    makeCharacterLine,
    enqueueSceneSummary,
    handleSend,
    handleRegenerate,
    handleReassignMessage,
    stop,
  };
}
