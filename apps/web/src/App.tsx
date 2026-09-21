import {
  type AssembledPrompt,
  applyTurnAnalysis,
  buildIntentPlanMessages,
  buildSceneTransitionNarration,
  buildTurnAnalysisMessages,
  type Card,
  type CharacterInstance,
  type ConversationModes,
  cleanPastedReply,
  collectCompletionWithTools,
  createCharacterMessage,
  createManualProvider,
  createNarrationMessage,
  createOpenAICompatibleProvider,
  createPlayerMessage,
  createTurnId,
  evaluateBudget,
  hasSpeech,
  type InstanceId,
  importCardFromJson,
  importCardFromPng,
  isIntentFirst,
  limitFallbackItems,
  type Message,
  type MessageId,
  type MessageUsage,
  matchWorldBookEntries,
  needsWebBridge,
  type PromptMemory,
  parseIntentPlan,
  parseWorldBook,
  pickPlannedSpeaker,
  type RecalledMemory,
  recallMemories,
  renderPromptForWeb,
  runTurn,
  type Scene,
  scheduleSpeakers,
  selectSceneMembers,
  selectWithinBudget,
  turnsSinceLastSpoke,
  WEB_BRIDGE_TARGET,
} from '@dramatis/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CardDesigner } from './components/CardDesigner';
import { CastDetail } from './components/CastDetail';
import { CastRail } from './components/CastRail';
import { LeftRail, type RailPane } from './components/LeftRail';
import { type FocusRequest, MainChat } from './components/MainChat';
import { MainHeader } from './components/MainHeader';
import { NewConversationDialog } from './components/NewConversationDialog';
import { RuntimePanel } from './components/RuntimePanel';
import { SceneDialog } from './components/SceneDialog';
import { type SettingsCategory, SettingsDialog } from './components/SettingsDialog';
import { SideChat } from './components/SideChat';
import { TopBar } from './components/TopBar';
import { WebBridgePanel, type WebBridgeState } from './components/WebBridgePanel';
import { WorldDesigner } from './components/WorldDesigner';
import { WorldTree } from './components/WorldTree';
import { useAdminChat } from './lib/admin';
import { useAppearance } from './lib/appearance';
import { useArchive } from './lib/archive';
import { loadBridge, saveBridge } from './lib/bridge-store';
import { useProviders } from './lib/providers';
import { useDatabase, useSession } from './lib/session';
import { QUOTA_WARN_RATIO, useStorageStatus } from './lib/storage';
import { useSync } from './lib/sync';
import { extraCalls, useUsage } from './lib/usage';
import { NARROW_SCREEN_QUERY, useFullscreen, useNarrowScreen } from './lib/viewport';
import {
  MEMORY_BUDGET_TOKENS,
  MEMORY_CONSOLIDATE_TASK_KIND,
  SCENE_SUMMARY_TASK_KIND,
  TURN_ANALYSIS_TASK_KIND,
  useBackgroundWorker,
} from './lib/worker';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 界面上的提示条：导入警告与归档结果都走这一种形状。 */
interface Notice {
  code: string;
  message: string;
  /**
   * 可选的「去那儿」按钮（T12）。
   *
   * 归档之后对话就不在主列表里了——只告诉用户「保留在设置里」，他下一刻
   * 还是得自己找。给一个能点的入口，这件事才算说清楚。
   */
  action?: { label: string; run: () => void };
}

function looksLikePng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

/** 世界书与角色卡都是 JSON，用有没有 `entries` 来区分。 */
function looksLikeWorldBook(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'entries' in value;
}

function toPromptMemory(recalled: RecalledMemory): PromptMemory {
  const event = recalled.event;
  return {
    id: event.id,
    summary: event.summary,
    score: recalled.score,
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

/**
 * 应用外壳（LAYOUT 的骨架）。
 *
 * 顶栏只放折叠按钮，其余留给未来的世界视图；左栏分三段；主区是
 * 「标题栏 + 对话 + 输入区」加右缘的角色栏。会话状态与回合逻辑都留在这里，
 * 各区域各自只管自己那一块。
 */
export function App() {
  const { db, boot, error: dbError } = useDatabase();
  const session = useSession(db);
  const providers = useProviders(db);
  const world = session.world;
  const conversation = session.conversation;

  /**
   * 用量账单（T7）。房间与对话一变就换一份账：跨对话、跨世界各算各的。
   */
  const usage = useUsage(db, {
    roomId: world?.id ?? null,
    conversationId: conversation?.id ?? null,
  });

  /**
   * 调用预算（P1-9 熔断）。
   *
   * 到上限时只停**生成之外**的调用：意图判断、一轮分析、分层摘要。
   * 角色回复永远照常——聊到一半突然说不出话，比多花几分钱糟糕得多。
   */
  const budget = evaluateBudget(usage.world, world?.budget ?? null);
  const burned = budget.burned;

  /**
   * 多设备同步（P2-6）。
   *
   * 启动时如果配置与密码都在，会自动同步一次；之后**每轮结束自动推一次**
   * （节流 20 秒，见 lib/sync.ts），用户也可以随时手动触发。
   */
  const sync = useSync(db, { onChanged: () => void session.refreshAll() });

  const worker = useBackgroundWorker({
    db,
    provider: providers.background,
    onChanged: () => {
      void session.reloadWorld();
      // 后台写完一笔账，界面上的数字要跟着动
      void usage.reload();
      // 记忆与情绪通常比回复晚几秒才落库，这一趟请求走同一个节流窗口
      sync.requestAutoSync();
    },
  });

  const admin = useAdminChat({
    db,
    session,
    providers,
    onChanged: () => {
      void session.reloadWorld();
    },
  });

  /**
   * 封存导出 / 导入（P2-4）。导入之后立刻打开新世界——否则用户会以为没导进来。
   */
  const archive = useArchive({
    db,
    onImported: (id) => session.openWorld(id),
  });

  /** 本机存储的持久化与配额（P2-3）：配额快满时在界面上提醒导出封存。 */
  const storage = useStorageStatus();

  /** 外观偏好：色调（酒馆 / 浅色 / 深色）、对话区背景、意图是否默认展开。 */
  const appearance = useAppearance();

  /**
   * 左栏的可见性。
   *
   * 桌面默认展开；**手机默认收起**——窄屏上左栏是抽屉，盖在对话上，
   * 默认铺开会把对话挤没（ROADMAP P2-1）。
   */
  const narrow = useNarrowScreen();
  /** 全屏：手机上浏览器顶栏/底栏占地方时，一键把它们收起来。 */
  const fullscreen = useFullscreen();
  const [collapsed, setCollapsed] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(NARROW_SCREEN_QUERY).matches,
  );
  /** 窄屏上「选完了就自动收起来」：抽屉不该一直挡着对话。 */
  const closeRailOnNarrow = useCallback(() => {
    if (narrow) setCollapsed(true);
  }, [narrow]);
  const [pane, setPane] = useState<RailPane>('list');
  const [panelOpen, setPanelOpen] = useState(false);
  /**
   * 设置改成了弹窗（用户要求）：分六个大类，从哪一类进由调用方决定
   * （比如归档后那条提示会把「已归档」直接打开）。
   */
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory | null>(null);
  const [newConversationOpen, setNewConversationOpen] = useState(false);
  const [sceneOpen, setSceneOpen] = useState(false);
  const [detailId, setDetailId] = useState<InstanceId | null>(null);

  const [warnings, setWarnings] = useState<Notice[]>([]);
  /**
   * 手机上的「装到桌面」引导（顺序 29）。
   *
   * 手机上浏览器会把地址栏与底部工具栏一直摆在那儿，装成应用之后才是真全屏——顺带还更容易
   * 拿到持久化存储。只在窄屏、且用户没关过的时候提一次。
   */
  const [installHint, setInstallHint] = useState(
    () => typeof window !== 'undefined' && window.localStorage.getItem('dramatis.installHint.dismissed') !== '1',
  );
  const [error, setError] = useState<string | null>(null);
  /** 「跳到原句」的最近一次请求（T11）：带序号，重复点击同一条也能再闪一次。 */
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const focusSeqRef = useRef(0);
  /**
   * 网页版桥接的状态（没有 API Key 时的第一条路）。
   *
   * 非 null 表示「正等着用户把网页版的输出贴回来」：`reply` 阶段等角色回复，
   * `analysis` 阶段等这一轮的记忆与情绪。它只活在内存里——刷新页面等于放弃这次转接，
   * 但已经落盘的玩家消息还在，重新发一次接着走就行。
   */
  const [bridge, setBridge] = useState<WebBridgeState | null>(() => loadBridge<WebBridgeState>('main'));

  /** 桥接进度落进 sessionStorage：刷新（或切后台回来）之后还在原来的那一步（顺序 25）。 */
  useEffect(() => {
    saveBridge('main', bridge);
  }, [bridge]);
  const [streamText, setStreamText] = useState('');
  const [streamSpeaker, setStreamSpeaker] = useState('');
  const [reasoningText, setReasoningText] = useState('');
  /**
   * 一轮正在做什么。
   *
   * 为什么要有它：生成之前还有一次「谁开口、他想做什么」的便宜调用，加上推理模型
   * 会先流一段推理流，用户看到的是「气泡一直空着，过一会儿整段话砸下来」。
   * 有了这个阶段名，界面从第一毫秒就有话说（正在判断谁开口 / 正在写）。
   */
  const [phase, setPhase] = useState<'idle' | 'planning' | 'writing'>('idle');
  const [busy, setBusy] = useState(false);
  const [lastPrompt, setLastPrompt] = useState<AssembledPrompt | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /**
   * 存储快满时提醒一次（P2-3）。
   *
   * 等到写不进去才说就晚了——那时候用户已经丢了一轮对话。所以到 80% 就提醒
   * 导出封存；同一个提醒只出现一次，用户点掉之后不再重复烦他。
   */
  useEffect(() => {
    const ratio = storage.ratio;
    if (ratio === null || ratio < QUOTA_WARN_RATIO) return;
    setWarnings((previous) =>
      previous.some((item) => item.code === 'quota')
        ? previous
        : [
            ...previous,
            {
              code: 'quota',
              message: `浏览器给本站的存储已经用掉约 ${String(Math.round(ratio * 100))}%，再写可能失败。建议现在导出一份封存（设置 → 封存）。`,
            },
          ],
    );
  }, [storage.ratio]);

  const scene = session.scene;
  const messages = session.messages;
  const instances = session.instances;
  const personas = session.personas;

  const activePersona = personas.find((persona) => persona.id === world?.personaId) ?? null;
  const ready = world !== null && conversation !== null;
  const archived = conversation?.archivedAt != null;
  const isSide = conversation?.kind === 'side';

  /** 此刻在场的人，标题栏与旁白都用它。 */
  const cast = useMemo(
    () => (scene === null ? [] : instances.filter((instance) => scene.cast.includes(instance.id))),
    [instances, scene],
  );

  const availableCards = useMemo(
    () => session.library.cards.filter((card) => !instances.some((instance) => instance.cardId === card.id)),
    [instances, session.library.cards],
  );

  /** 跑一次生成，返回角色说出的完整内容。 */
  const runGeneration = useCallback(
    async (options: {
      speaker: CharacterInstance;
      card: Card;
      history: Message[];
      playerInput: string;
      memories?: readonly PromptMemory[];
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

      // 世界书按关键词命中插入，扫描范围是玩家输入加最近几轮
      const scanText = [options.playerInput, ...options.history.slice(-8).map((message) => message.content)].join('\n');
      const worldBookMatches = session.worldBooks.flatMap((book) => matchWorldBookEntries(book, { scanText }));

      let accumulated = '';
      let usage: MessageUsage | null = null;
      // 推理流也算「模型自己的盘算」：它不肯按格式写意图时，这是唯一真实的计划来源
      let reasoning = '';
      let assembled: AssembledPrompt | null = null;
      for await (const event of runTurn(
        {
          card: options.card,
          instance: options.speaker,
          room: world,
          scene,
          cast: instances,
          history: options.history,
          playerInput: options.playerInput,
          worldBookMatches,
          memories: options.memories === undefined ? [] : [...options.memories],
          // 前情提要（P1-5）：早就不在窗口里的那几场戏，压成几行带过来
          chapters: session.chapters,
          attachmentSources: { memories: session.memories, chapters: session.allChapters },
          modes: conversation?.modes,
          ...(options.intent === undefined || options.intent === null
            ? {}
            : { intent: options.intent.intent, intentMode: options.intent.mode as 'reply' }),
          budget: { maxTokens: profile.maxTokens, reserveForReply: profile.reserveForReply },
        },
        provider,
        { params: { temperature: profile.temperature }, signal: options.signal },
      )) {
        switch (event.type) {
          case 'prompt':
            assembled = event.prompt;
            setLastPrompt(event.prompt);
            break;
          case 'reasoning':
            reasoning += event.text;
            setReasoningText(reasoning);
            break;
          case 'text':
            accumulated += event.text;
            if (options.showStream) setStreamText(accumulated);
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
      session.worldBooks,
      world,
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
    }) => {
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
        await db?.ledger.record({
          roomId: world?.id ?? null,
          conversationId: conversation?.id ?? null,
          turnId: input.turnId,
          category: 'intent',
          model: config.model,
          promptTokens: completion.usage?.promptTokens ?? 0,
          completionTokens: completion.usage?.completionTokens ?? 0,
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

  /**
   * 每回合结算之后，让后台看一眼这一场要不要压场记（P1-5 的场景层）。
   *
   * 这里**不做阈值判断**：攒够没攒够由后台拿着最新数据决定（同一个纯函数），
   * 界面侧的判断会拿着过期的场景对象重复触发——真机第一轮就出现过两次摘要调用。
   * 幂等键按回合给：一轮只排一次队，攒不够时那一趟是空跑，不发调用、不记账。
   */
  const enqueueSceneSummary = useCallback(
    async (target: Scene, key: string) => {
      if (!db || !world || !conversation) return;
      if (burned) return;

      await db.queue.enqueue({
        kind: SCENE_SUMMARY_TASK_KIND,
        idempotencyKey: `${SCENE_SUMMARY_TASK_KIND}:${target.id}:${key}`,
        roomId: world.id,
        turnId: null,
        payload: { roomId: world.id, sceneId: target.id, conversationId: conversation.id },
      });
      worker.kick();
    },
    [burned, conversation, db, worker, world],
  );

  /**
   * 每回合结算之后，让后台看一眼「记忆该不该合并」（顺序 27a）。
   *
   * 与场记那条路同一个套路：这里**不做阈值判断**（判断在 worker 里拿着最新数据做），
   * 只负责按「每 40 条记忆」排一次队——幂等键里带桶号，所以同一批记忆只会排一次，
   * 攒不够时那一趟是空跑（不发调用、不记账）。
   */
  const enqueueMemoryConsolidation = useCallback(async () => {
    if (!db || !world || !conversation || burned) return;
    const memories = await db.repository.listMemories(world.id);
    const bucket = Math.floor(memories.length / 40);
    await db.queue.enqueue({
      kind: MEMORY_CONSOLIDATE_TASK_KIND,
      idempotencyKey: `${MEMORY_CONSOLIDATE_TASK_KIND}:${conversation.id}:${String(bucket)}`,
      roomId: world.id,
      turnId: null,
      payload: { roomId: world.id, conversationId: conversation.id },
    });
    worker.kick();
  }, [burned, conversation, db, worker, world]);

  const handleImport = useCallback(
    async (file: File) => {
      setError(null);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());

        if (!looksLikePng(bytes)) {
          const text = new TextDecoder('utf-8').decode(bytes);
          const parsed = JSON.parse(text) as unknown;

          if (looksLikeWorldBook(parsed)) {
            const { book, warnings: bookWarnings } = parseWorldBook(parsed, file.name.replace(/\.json$/i, ''));
            await session.saveWorldBook(book);
            setWarnings(bookWarnings);
            return;
          }
        }

        const result = looksLikePng(bytes)
          ? await importCardFromPng(bytes, file.name)
          : importCardFromJson(new TextDecoder('utf-8').decode(bytes), file.name);

        // 先入库，再决定要不要马上用
        await session.saveCard(result.card);
        setWarnings(result.warnings);

        // 一张卡都没有的时候，导入即开一条新世界线，省掉一步
        if (session.world === null) {
          await session.createWorld({ title: result.card.name, persona: activePersona, cards: [result.card] });
        }
        /*
         * 手机上导入完就把左抽屉收起来：导完卡最想看的是刚开出来的那条线，
         * 而抽屉正盖着它（实测要再点一次「收起左栏」才看得见）。
         */
        closeRailOnNarrow();

        if (result.card.embeddedWorldBook !== null) {
          const { book } = parseWorldBook(result.card.embeddedWorldBook, `${result.card.name} 的内嵌世界书`);
          await session.saveWorldBook(book);
          await session.attachWorldBook(book);
        }
      } catch (importError) {
        setError(importError instanceof Error ? importError.message : String(importError));
      }
    },
    [activePersona, closeRailOnNarrow, session],
  );

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
      setStreamText('');
      setStreamSpeaker('');
      setReasoningText('');
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
        setPhase('planning');
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
          const recalled = selectWithinBudget(
            // 兜底上限（T22）：有命中的那一轮最多再带两条「顺带想起」的记忆。
            // 实测 800 token 里原本平均有 5 条是这类无关条目，把预算让出去之后，
            // 命中条目从 4.0 涨到 5.1 条（EVAL 第五节）。
            limitFallbackItems(
              recallMemories(recallPool, {
                observerId: speaker.id,
                text: [text, ...history.slice(-6).map((message) => message.content)].join('\n'),
                participantIds: scene.cast,
                location: scene.location,
                now,
              }),
            ),
            MEMORY_BUDGET_TOKENS,
          );

          setStreamSpeaker(speaker.displayName);
          setPhase('writing');
          const plannedIntent = intentByInstance.get(speaker.id) ?? null;
          const generation = await runGeneration({
            speaker,
            card: speakerCard,
            history: first ? history : continuedHistory,
            playerInput: first ? text : '',
            memories: recalled.map(toPromptMemory),
            showStream: true,
            signal: controller.signal,
            intent: plannedIntent,
          });

          // 记一笔账。服务商没返回 usage 时 token 记 0，但调用确实发生过，
          // 所以这一条照样记——漏账会让用户低估开销（T7）
          // 网页版那一轮不经过服务商，没有 token 也没有钱——记一条 0 只会污染账单
          if (!manual) {
            await db.ledger.record({
              roomId: world.id,
              conversationId: conversation.id,
              turnId,
              category: 'generation',
              model: profile.model,
              promptTokens: generation.usage?.promptTokens ?? 0,
              completionTokens: generation.usage?.completionTokens ?? 0,
              speakerInstanceId: speaker.id,
              speakerName: speaker.displayName,
              price: profile.price ?? null,
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

          if (reply.trim() !== '') {
            const created = makeCharacterLine(speaker, reply, turnId, scene);
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
          }
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
              message: `${budget.reason ?? '已达本局上限'}——这一轮只生成回复，不做意图判断与后台记录。可在运行时的「用量」页调整上限。`,
            },
          ]);
          return;
        }
        await db.queue.enqueue({
          kind: TURN_ANALYSIS_TASK_KIND,
          idempotencyKey: `${TURN_ANALYSIS_TASK_KIND}:${turnId}`,
          roomId: world.id,
          turnId,
          payload: { roomId: world.id, sceneId: scene.id, turnId, conversationId: conversation.id },
        });
        worker.kick();
      } catch (sendError) {
        const message = sendError instanceof Error ? sendError.message : String(sendError);
        setError(controller.signal.aborted ? `已停止生成（${message}）` : message);
      } finally {
        setStreamText('');
        setReasoningText('');
        setPhase('idle');
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
      budget.reason,
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
      setStreamText('');
      setStreamSpeaker(speaker.displayName);
      setPhase('writing');
      setReasoningText('');

      // 用 clearTurn 而不是 cancelByTurn：已经跑完的任务记录会占着幂等键，
      // 不清掉的话下面重新入队会被当成重复任务
      await db.queue.clearTurn(target.turnId);
      for (const message of turnMessages) {
        if (message.role === 'character') await session.deleteMessage(message.id);
      }
      await session.revertTurn(target.turnId);

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
        await db.ledger.record({
          roomId: world.id,
          conversationId: conversation.id,
          turnId: target.turnId,
          category: 'generation',
          model: providers.active?.model ?? '',
          promptTokens: generation.usage?.promptTokens ?? 0,
          completionTokens: generation.usage?.completionTokens ?? 0,
          speakerInstanceId: speaker.id,
          speakerName: speaker.displayName,
          price: providers.active?.price ?? null,
        });
        await usage.reload();

        if (generation.text.trim() !== '') {
          await session.appendMessages([
            {
              ...makeCharacterLine(speaker, generation.text, target.turnId, scene),
              ...(generation.usage === null ? {} : { usage: generation.usage }),
            },
          ]);
        }

        // 重抽撤销了这一轮的后台任务，必须重新排一次队。
        // 不补这一步的话，被重抽的那一轮会永远不再抽取记忆——角色的记忆里
        // 就永久缺了一段（真实模型端到端测试里就是这样发现的：重抽两次之后
        // 记忆条数少了一条，再也没有回来）。
        await db.queue.enqueue({
          kind: TURN_ANALYSIS_TASK_KIND,
          idempotencyKey: `${TURN_ANALYSIS_TASK_KIND}:${target.turnId}`,
          roomId: world.id,
          turnId: target.turnId,
          payload: {
            roomId: world.id,
            sceneId: scene.id,
            turnId: target.turnId,
            conversationId: conversation.id,
          },
        });
        worker.kick();
      } catch (regenerateError) {
        const message = regenerateError instanceof Error ? regenerateError.message : String(regenerateError);
        setError(controller.signal.aborted ? `已停止生成（${message}）` : message);
      } finally {
        setStreamText('');
        setReasoningText('');
        setPhase('idle');
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
    ],
  );

  const handleDeleteMessage = useCallback(
    async (id: MessageId) => {
      const target = messages.find((message) => message.id === id);
      if (!target) return;

      if (target.role === 'character' && db) {
        await db.queue.cancelByTurn(target.turnId);
        await session.revertTurn(target.turnId);
      }
      await session.deleteMessage(id);
    },
    [db, messages, session],
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

      await db.queue.enqueue({
        kind: TURN_ANALYSIS_TASK_KIND,
        // 带时间戳：clearTurn 已经清掉旧记录，这里再带上时间戳保证一定起一条新任务
        idempotencyKey: `${TURN_ANALYSIS_TASK_KIND}:${target.turnId}:${String(Date.now())}`,
        roomId: world.id,
        turnId: target.turnId,
        payload: {
          roomId: world.id,
          sceneId: target.sceneId,
          turnId: target.turnId,
          conversationId: conversation.id,
        },
      });
      worker.kick();
    },
    [conversation, db, messages, providers.apiKey, session, worker, world],
  );

  /** 切换场景：开一场新的，并留下一条旁白式动作（谁跟谁去了哪里）。 */
  const handleStartNewScene = useCallback(
    async (input: { title: string; location: string; worldTime: string; cast?: readonly InstanceId[] }) => {
      if (!world || !conversation) return;

      const created = await session.startNewScene(input);
      if (!created) return;

      const members = selectSceneMembers(instances, created);
      const content = buildSceneTransitionNarration({ next: created, members });

      await session.appendMessages([
        createNarrationMessage({
          roomId: world.id,
          conversationId: conversation.id,
          sceneId: created.id,
          turnId: createTurnId(),
          content,
        }),
      ]);

      // 上一场戏在换场那一刻就该收尾：把它剩下的几轮压成场记，够多就接着滚一章
      if (scene !== null && scene.id !== created.id) {
        // 换场时也看一眼上一场：结尾那几轮不该丢在场记之外
        await enqueueSceneSummary(scene, 'close');
      }
    },
    [conversation, enqueueSceneSummary, instances, scene, session, world],
  );

  const handleNewConversation = useCallback(
    async (input: {
      title: string;
      cardIds: string[];
      worldBookIds: string[];
      sceneTitle: string;
      location: string;
      worldTime: string;
    }) => {
      setNewConversationOpen(false);
      const cards = session.library.cards.filter((card) => input.cardIds.includes(card.id));

      // 还没有世界时，「新对话」顺带把世界建起来：否则用户会卡在「没有世界可开线」
      if (session.world === null) {
        await session.createWorld({
          title: input.title,
          persona: activePersona,
          cards,
          worldBookIds: input.worldBookIds as never,
        });
        return;
      }

      const started = await session.startConversation({
        title: input.title,
        cards,
        worldBookIds: input.worldBookIds as never,
        sceneTitle: input.sceneTitle,
        location: input.location,
        worldTime: input.worldTime,
      });
      if (started !== null && started.attachments.length > 0) {
        const message = started.attachments
          .map((report) => {
            const dropped = report.dropped.impressions + report.dropped.chapters;
            return `已从《${report.sourceConversationTitle}》给「${report.cardName}」带去 ${String(
              report.impressions,
            )} 条印象 / ${String(report.chapters)} 章${dropped === 0 ? '' : `，预算所限丢了 ${String(dropped)} 条`}`;
          })
          .join('；');
        setWarnings((previous) => [
          ...previous.filter((item) => item.code !== 'conversation.memory-attachment'),
          { code: 'conversation.memory-attachment', message: `${message}。` },
        ]);
      }
    },
    [activePersona, session],
  );

  /** 「创建」走副对话；还没有世界就先建一个空世界，否则管理员无处落脚。 */
  const handleCreateWithAi = useCallback(async () => {
    if (session.world === null) {
      await session.createWorld({ title: '新世界', persona: activePersona, cards: [] });
    }
    await session.openSideConversation();
    setPane('list');
  }, [activePersona, session]);

  const handleToggleKind = useCallback(async () => {
    if (conversation?.kind === 'side') {
      const main = session.conversations.find((item) => item.kind === 'main');
      if (main) await session.openConversation(main.id);
      return;
    }
    await session.openSideConversation();
  }, [conversation, session]);

  const handleArchive = useCallback(
    async (targetConversationId: string) => {
      const report = await session.archiveConversation(targetConversationId as never);
      if (report === null) return;
      setError(null);
      setWarnings([
        {
          code: 'conversation.archived',
          message: `已归档：回滚了 ${String(report.restoredInstances)} 名角色的状态，撤销了 ${String(
            report.removedMemories,
          )} 条记忆。对话本身没有删——它在「设置 → 已归档的对话」里，可以回顾、也能导出正文。`,
          action: {
            // 归档后对话就从主列表消失了，给一步到位的入口（T12）
            label: '去看这条对话',
            run: () => {
              setSettingsCategory('archive');
              setWarnings([]);
            },
          },
        },
      ]);
    },
    [session],
  );

  /**
   * 「跳到原句」（T11）：切回产生这条记忆的那条对话，并让那条消息闪一下。
   *
   * 记忆面板里的条目大多来自别的对话——这正是需要它的原因：用户看到
   * 「秦娘眼中的事」，想知道她当时到底听见了什么，一步就该到那里。
   */
  const handleLocateMemory = useCallback(
    (turnId: string) => {
      const hit = session.locateTurn(turnId);
      if (hit === null) {
        setWarnings([
          {
            code: 'memory.locate',
            message: '这条记忆对应的原句已经不在了（那一轮可能被重抽或删掉过）。',
          },
        ]);
        return;
      }

      focusSeqRef.current += 1;
      const request: FocusRequest = { id: hit.messageId, seq: focusSeqRef.current };

      if (hit.conversationId !== conversation?.id) {
        // 先切对话，再亮原句：立刻亮会落在一个还没渲染出来的节点上
        void session.openConversation(hit.conversationId).then(() => setFocus(request));
        return;
      }
      setFocus(request);
    },
    [conversation, session],
  );

  /**
   * 网页版桥接第一步：收下用户从网页版粘回来的**角色回复**。
   *
   * 走的落盘路径与自动生成完全一样（`makeCharacterLine` → `appendMessages`），
   * 所以意图解析、转写标记清理、气泡分段、右侧角色栏……全都不用另写一遍。
   * 收下之后立刻准备第二步的提示词：同一轮的记忆与情绪推演。
   */
  const handleBridgeReply = useCallback(
    async (raw: string) => {
      if (!db || !world || !scene || !conversation || bridge === null || bridge.stage !== 'reply') return;
      if (bridge.turnId === undefined || bridge.speakerInstanceId === undefined) return;

      const speaker = instances.find((item) => item.id === bridge.speakerInstanceId);
      if (speaker === undefined) {
        setError('找不到这一轮该说话的角色（也许它已经离开了这个世界）。');
        setBridge(null);
        return;
      }

      const text = cleanPastedReply(raw);
      if (text === '') {
        setError('贴回来的内容是空的。');
        return;
      }

      setBusy(true);
      try {
        const line = makeCharacterLine(speaker, text, bridge.turnId, scene);
        await session.appendMessages([line]);

        // 这一轮要说给谁听：名单里在场的那几位，与自动路径的 audience 一致
        const cast = instances.filter((instance) => scene.cast.includes(instance.id));
        const turnMessages = [...session.messages.filter((message) => message.turnId === bridge.turnId), line];

        setBridge({
          stage: 'analysis',
          turnId: bridge.turnId,
          speakerInstanceId: speaker.id,
          speakerName: speaker.displayName,
          prompt: renderPromptForWeb(
            buildTurnAnalysisMessages({
              scene,
              cast,
              playerName: world.playerName,
              messages: turnMessages,
            }),
          ),
        });
      } catch (bridgeError) {
        setError(bridgeError instanceof Error ? bridgeError.message : String(bridgeError));
      } finally {
        setBusy(false);
      }
    },
    [bridge, conversation, db, instances, makeCharacterLine, scene, session, world],
  );

  /**
   * 网页版桥接第二步：收下这一轮的**记忆与情绪**。
   *
   * 落库走内核的 `applyTurnAnalysis`——与后台任务用的是同一个函数，
   * 所以「贴回来的记忆」和「API 跑出来的记忆」在库里长得一模一样。
   */
  const handleBridgeAnalysis = useCallback(
    async (raw: string) => {
      if (!db || !world || !scene || !conversation || bridge === null || bridge.stage !== 'analysis') return;
      if (bridge.turnId === undefined) return;

      setBusy(true);
      try {
        const result = await applyTurnAnalysis({
          repository: db.repository,
          roomId: world.id,
          sceneId: scene.id,
          conversationId: conversation.id,
          turnId: bridge.turnId,
          worldTime: scene.worldTime,
          participants: instances.filter((instance) => scene.cast.includes(instance.id)),
          raw,
        });
        await session.reloadWorld();
        setBridge(null);
        setWarnings([
          {
            code: 'bridge.analysis',
            message: `这一轮记下了：${String(result.memories)} 条记忆${
              result.updates > 0 ? `、${String(result.updates)} 名角色的状态有变化` : ''
            }。${
              result.unmatchedSpeakers.length > 0
                ? `（有 ${String(result.unmatchedSpeakers.length)} 个名字没对上在场角色，那几条只记了客观经过）`
                : ''
            }`,
          },
        ]);
        sync.requestAutoSync();
      } catch (bridgeError) {
        setError(bridgeError instanceof Error ? bridgeError.message : String(bridgeError));
      } finally {
        setBusy(false);
      }
    },
    [bridge, conversation, db, instances, scene, session, sync, world],
  );

  /** 放弃这一次转接：第一步放弃等于这一轮没有回复，第二步放弃等于这一轮没写记忆。 */
  const handleBridgeSkip = useCallback(() => {
    const stage = bridge?.stage ?? null;
    setBridge(null);
    if (stage === 'analysis') {
      setWarnings([
        {
          code: 'bridge.skip',
          message:
            '这一轮没有写记忆与情绪（第二步跳过了）。想让它记住，把第二步的提示词贴一次就行；或者在设置里填一个 API Key，之后这些都会自动跑。',
        },
      ]);
    }
  }, [bridge]);

  const handleToggleMode = useCallback(
    (key: keyof ConversationModes, value: boolean) => {
      if (!conversation) return;
      void session.updateConversation({ modes: { ...conversation.modes, [key]: value } });
    },
    [conversation, session],
  );

  const disabled = busy || !session.ready;
  const detail = detailId === null ? null : (instances.find((instance) => instance.id === detailId) ?? null);
  const worldId = world?.id ?? null;

  // 换世界时把选中态清掉，避免看到上一个世界的角色详情
  useEffect(() => {
    if (worldId === null) return;
    setDetailId(null);
  }, [worldId]);

  return (
    /*
     * 对话区背景通过两个 CSS 变量下发：`.chat-surface::before` 拿它画背景。
     * 背景挂在不滚动的那一层上，所以滑动时它固定、只有对话在动。
     */
    <div
      className={appearance.value.background === '' ? 'app' : 'app has-bg'}
      style={
        {
          '--chat-bg': appearance.value.background === '' ? 'none' : `url("${appearance.value.background}")`,
          '--chat-bg-opacity': appearance.value.background === '' ? 0 : appearance.value.backgroundOpacity,
        } as React.CSSProperties
      }
    >
      <TopBar
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((value) => !value)}
        backendKind={boot?.backendKind ?? ''}
        degraded={boot?.degraded ?? false}
        backgroundPending={worker.pending}
        fullscreen={fullscreen}
      />

      <div className={collapsed ? 'app-body collapsed' : 'app-body'}>
        {collapsed ? null : (
          <LeftRail
            pane={pane}
            onPaneChange={setPane}
            onNewConversation={() => {
              setNewConversationOpen(true);
              closeRailOnNarrow();
            }}
            onCreateWithAi={() => {
              void handleCreateWithAi();
              closeRailOnNarrow();
            }}
            onImportFile={(file) => void handleImport(file)}
            onOpenSettings={() => setSettingsCategory('model')}
            onOpenAccount={() => setSettingsCategory('account')}
            disabled={disabled}
            list={
              <>
                {error !== null || dbError !== null || session.error !== null ? (
                  <div className="notice error">
                    <strong>出错了</strong>
                    <p>{error ?? session.error ?? dbError}</p>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        setError(null);
                        session.clearError();
                      }}
                    >
                      知道了
                    </button>
                  </div>
                ) : null}

                {warnings.length > 0 ? (
                  <div className="notice warn">
                    <strong>提示</strong>
                    <ul>
                      {warnings.map((item, index) => (
                        <li key={`${String(index)}-${item.message.slice(0, 12)}`}>
                          {item.message}
                          {item.action === undefined ? null : (
                            <button type="button" className="ghost" onClick={item.action?.run}>
                              {item.action.label}
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                    <button type="button" className="ghost" onClick={() => setWarnings([])}>
                      知道了
                    </button>
                  </div>
                ) : null}

                <WorldTree
                  worlds={session.worlds}
                  activeWorldId={world?.id ?? null}
                  conversations={session.conversations}
                  activeConversationId={conversation?.id ?? null}
                  disabled={disabled}
                  onOpenWorld={(id) => {
                    void session.openWorld(id);
                    closeRailOnNarrow();
                  }}
                  onOpenConversation={(id) => {
                    void session.openConversation(id);
                    closeRailOnNarrow();
                  }}
                  onArchiveConversation={(target) => {
                    if (
                      window.confirm(
                        `归档「${target.title}」？情绪、关系与记忆会回滚到它开始之前，这条时间线相当于没有发生过；对话本身会保留在设置里。`,
                      )
                    ) {
                      void handleArchive(target.id);
                    }
                  }}
                  onDeleteConversation={(target) => void session.deleteConversation(target.id)}
                  onDeleteWorld={(id) => void session.deleteWorld(id)}
                />
              </>
            }
            panel={
              <>
                {pane === 'cards' ? (
                  <section className="panel">
                    <CardDesigner
                      cards={session.library.cards}
                      disabled={disabled}
                      onSave={(card) => void session.saveCard(card)}
                      onDelete={(id) => void session.deleteCard(id)}
                    />
                  </section>
                ) : null}

                {pane === 'worldbooks' ? (
                  <section className="panel">
                    <WorldDesigner
                      books={session.library.worldBooks}
                      attachedIds={world?.worldBookIds ?? []}
                      disabled={disabled}
                      onSave={(book) => void session.saveWorldBook(book)}
                      onDelete={(id) => void session.deleteWorldBook(id)}
                      onAttach={(book) => void session.attachWorldBook(book)}
                    />
                  </section>
                ) : null}
              </>
            }
          />
        )}

        {/*
          窄屏上左栏是抽屉（P2-1）：铺一层遮罩，点哪儿都收起来。
          桌面上不渲染——那时左栏是常驻的一列，遮罩没有意义。
        */}
        {!collapsed && narrow ? (
          <button type="button" className="rail-scrim" aria-label="收起左栏" onClick={() => setCollapsed(true)} />
        ) : null}

        <div className="workspace">
          <MainHeader
            world={world}
            conversation={conversation}
            cast={cast}
            disabled={disabled}
            panelOpen={panelOpen}
            onToggleKind={() => void handleToggleKind()}
            onTogglePanel={() => setPanelOpen((value) => !value)}
            onRenameConversation={(title) => void session.updateConversation({ title })}
          />

          {world === null || conversation === null ? (
            <section className="chat-surface empty">
              <p className="hint">还没有打开的对话。</p>
              <p className="hint">
                导入一张角色卡，或者用左栏的「新对话」开一条线；也可以点「创建」让世界管理员陪你起草。
              </p>
              {needsWebBridge(providers.apiKey) ? (
                <p className="hint">
                  <strong>没有 API Key 也能开始</strong>
                  ：导入一张卡之后，应用会把每一轮要发的提示词交给你，贴进 DeepSeek 网页版，再把回复粘回来。
                </p>
              ) : null}
            </section>
          ) : (
            <div className="workspace-body">
              {isSide ? (
                <SideChat
                  conversation={conversation}
                  messages={messages}
                  streamText={admin.streamText}
                  busy={admin.busy}
                  ready={ready}
                  archived={archived}
                  bridge={admin.bridge}
                  manualMode={needsWebBridge(providers.apiKey)}
                  onBridgeCommit={(text) => void admin.commitBridge(text)}
                  onBridgeCancel={admin.cancelBridge}
                  onSend={(text) => void admin.send(text)}
                  onStop={admin.stop}
                  onAdopt={(messageId, artifact) => void session.adoptArtifact(messageId, artifact.id)}
                  onDiscard={(messageId, artifact) => void session.discardArtifact(messageId, artifact.id)}
                  onRevoke={(messageId, artifact) => void session.revokeArtifact(messageId, artifact.id)}
                  existingIds={[
                    ...session.library.cards.map((card) => card.id),
                    ...session.library.worldBooks.map((book) => book.id),
                  ]}
                />
              ) : (
                <MainChat
                  conversation={conversation}
                  scene={scene}
                  messages={messages}
                  cast={cast}
                  streamText={streamText}
                  streamSpeaker={streamSpeaker}
                  reasoningText={reasoningText}
                  phase={phase}
                  busy={busy}
                  ready={ready}
                  archived={archived}
                  focus={focus}
                  showIntent={appearance.value.showIntent}
                  bridge={bridge}
                  manualMode={bridge !== null || needsWebBridge(providers.apiKey)}
                  onBridgeReply={(text) => void handleBridgeReply(text)}
                  onBridgeAnalysis={(text) => void handleBridgeAnalysis(text)}
                  onBridgeSkip={handleBridgeSkip}
                  onSend={(text) => void handleSend(text)}
                  onStop={() => abortRef.current?.abort()}
                  onRegenerate={(id) => void handleRegenerate(id)}
                  onEdit={(id, content) => void session.updateMessage(id, { content })}
                  onDelete={(id) => void handleDeleteMessage(id)}
                  onToggleMode={handleToggleMode}
                  onOpenScene={() => setSceneOpen(true)}
                  onDropInstance={(id) => void session.setPresence(id, 'onstage')}
                  onReassign={(id, instanceId) => void handleReassignMessage(id, instanceId)}
                />
              )}

              {/*
                手机上运行时面板是**覆盖层**（CSS 里 ≤640px 那段）：铺一层遮罩，
                点哪儿都收起来。桌面上不渲染——那时它是一个常驻的窄列。
              */}
              {panelOpen && narrow ? (
                <button
                  type="button"
                  className="runtime-scrim"
                  aria-label="收起运行时面板"
                  onClick={() => setPanelOpen(false)}
                />
              ) : null}

              <div className={panelOpen ? 'runtime-drawer open' : 'runtime-drawer'}>
                {panelOpen ? (
                  <>
                    {/* 手机上「面板」按钮被盖住了，抽屉里要有一个能自己关的出口 */}
                    <button type="button" className="ghost drawer-close" onClick={() => setPanelOpen(false)}>
                      收起面板
                    </button>
                    <RuntimePanel
                      scene={scene}
                      instances={instances}
                      memories={session.memories}
                      conversations={session.conversations}
                      activeConversationId={conversation?.id ?? null}
                      chapters={session.chapters}
                      attachedWorldBooks={session.worldBooks}
                      libraryCards={session.library.cards}
                      worldCards={session.cards}
                      prompt={lastPrompt}
                      pending={worker.pending}
                      extraCalls={extraCalls(usage.world)}
                      usage={{ world: usage.world, conversation: usage.conversation }}
                      budget={budget}
                      budgetLimits={world?.budget ?? null}
                      onSaveBudget={(limits) => void session.setBudget(limits)}
                      conversationTitle={conversation?.title ?? ''}
                      workerError={worker.lastError}
                      disabled={disabled}
                      onSceneChange={(patch) => void session.updateScene(patch)}
                      onStartNewScene={(title) => void handleStartNewScene({ title, location: '', worldTime: '' })}
                      onSetPresence={(id, presence) => void session.setPresence(id, presence)}
                      onRenameInstance={(id, name) => void session.updateInstance(id, { displayName: name })}
                      onRemoveInstance={(id) => void session.removeInstance(id)}
                      onAddInstance={(card) => void session.addInstance(card)}
                      onDetachWorldBook={(id) => void session.detachWorldBook(id)}
                      onUpdateMemory={(id, patch) => void session.updateMemory(id, patch)}
                      onDeleteMemory={(id) => void session.deleteMemory(id)}
                      onLocateMemory={handleLocateMemory}
                    />
                  </>
                ) : null}
              </div>
            </div>
          )}

          {!isSide && world !== null && conversation !== null ? (
            <CastRail
              instances={instances}
              scene={scene}
              cards={session.cards}
              disabled={disabled}
              onOpenDetail={setDetailId}
              availableCards={availableCards}
              onAddInstance={(card) => void session.addInstance(card)}
            />
          ) : null}
        </div>
      </div>

      {narrow && installHint ? (
        <div className="notice warn install-hint">
          <strong>手机上想要全屏，把它装成应用</strong>
          <p>
            地址栏与底部工具栏会一直占着地方。用浏览器菜单里的「安装应用」／「添加到主屏幕」 （iPhone 上是分享 →
            添加到主屏幕）装一次，打开就是全屏，也更容易拿到持久化存储。
            现在也可以点顶栏的「全屏」先把浏览器界面收起来。
          </p>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              window.localStorage.setItem('dramatis.installHint.dismissed', '1');
              setInstallHint(false);
            }}
          >
            知道了
          </button>
        </div>
      ) : null}

      {newConversationOpen ? (
        <NewConversationDialog
          cards={session.library.cards}
          worldBooks={session.library.worldBooks}
          defaultCardIds={instances.map((instance) => instance.cardId)}
          attachedBookIds={world?.worldBookIds ?? []}
          disabled={disabled}
          onClose={() => setNewConversationOpen(false)}
          onSubmit={(input) => void handleNewConversation(input)}
        />
      ) : null}

      {sceneOpen ? (
        <SceneDialog
          scene={scene}
          instances={instances}
          disabled={disabled}
          onClose={() => setSceneOpen(false)}
          onSave={(patch) => void session.updateScene(patch)}
          onStartNewScene={(input) => void handleStartNewScene(input)}
        />
      ) : null}

      {detail === null ? null : (
        <CastDetail
          instance={detail}
          card={session.cards.find((card) => card.id === detail.cardId) ?? null}
          memories={session.memories}
          disabled={disabled}
          onClose={() => setDetailId(null)}
          onRename={(id, name) => void session.updateInstance(id, { displayName: name })}
          onSetPresence={(id, presence) => void session.setPresence(id, presence)}
          onRemove={(id) => {
            setDetailId(null);
            void session.removeInstance(id);
          }}
          onRevertChange={(id, changeId) => void session.revertAffectChange(id, changeId)}
        />
      )}

      {/* 设置弹窗：分六个大类（模型配置 / 个性化 / 身份 / 同步 / 数据 / 已归档） */}
      {settingsCategory === null ? null : (
        <SettingsDialog
          category={settingsCategory}
          onCategoryChange={setSettingsCategory}
          onClose={() => setSettingsCategory(null)}
          providers={providers}
          appearance={appearance}
          personas={personas}
          activePersonaId={activePersona?.id ?? null}
          archivedConversations={session.archivedConversations}
          activeConversationId={conversation?.id ?? null}
          disabled={disabled}
          onSelectPersona={(persona) => void session.setPersona(persona)}
          onSavePersona={(persona) => void session.savePersona(persona)}
          onDeletePersona={(id) => void session.deletePersona(id)}
          onOpenArchived={(id) => {
            void session.openConversation(id);
            setSettingsCategory(null);
          }}
          onDeleteArchived={(target) => void session.deleteConversation(target.id)}
          onExportArchive={() => (world === null ? Promise.resolve(null) : archive.exportWorld(world.id))}
          onImportArchive={archive.importArchive}
          onExportTranscript={(id) => archive.exportTranscript(session.bundleOf(id), world?.title ?? '')}
          storage={storage}
          backendKind={boot?.backendKind ?? ''}
          sync={sync}
        />
      )}
    </div>
  );
}
