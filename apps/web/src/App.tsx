import {
  type AdminArtifact,
  type AssembledPrompt,
  applyTurnAnalysis,
  buildSceneTransitionNarration,
  buildTurnAnalysisMessages,
  type Card,
  type CastName,
  type Conversation,
  type ConversationId,
  type ConversationModes,
  cleanPastedReply,
  createNarrationMessage,
  createTurnId,
  evaluateBudget,
  type InstanceId,
  type MessageId,
  needsWebBridge,
  type RoomId,
  renderPromptForWeb,
  selectSceneMembers,
} from '@dramatis/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CardDesigner } from './components/CardDesigner';
import { CastDetail } from './components/CastDetail';
import { CastRail } from './components/CastRail';
import { CastStrip } from './components/CastStrip';
import { ChatControls } from './components/ChatControls';
import { LeftRail, type RailPane } from './components/LeftRail';
import { type FocusRequest, MainChat } from './components/MainChat';
import { MainHeader } from './components/MainHeader';
import { NewConversationDialog } from './components/NewConversationDialog';
import { PersonaLibrary } from './components/PersonaLibrary';
import { RuntimePanel } from './components/RuntimePanel';
import { SceneDialog } from './components/SceneDialog';
import { type SettingsCategory, SettingsDialog } from './components/SettingsDialog';
import { SideChat } from './components/SideChat';
import { TopBar } from './components/TopBar';
import { WorldDesigner } from './components/WorldDesigner';
import { WorldTree } from './components/WorldTree';
import { useImport } from './hooks/useImport';
import { useNotices } from './hooks/useNotices';
import { useTurnRunner } from './hooks/useTurnRunner';
import { useWebBridge } from './hooks/useWebBridge';
import { useAdminChat } from './lib/admin';
import { useAppearance } from './lib/appearance';
import { useArchive } from './lib/archive';
import { useProviders } from './lib/providers';
import { useDatabase, useSession } from './lib/session';
import { useStorageStatus } from './lib/storage';
import { useSync } from './lib/sync';
import { extraCalls, useUsage } from './lib/usage';
import { useUnlimitedPrompt } from './lib/useUnlimitedPrompt';
import { NARROW_SCREEN_QUERY, useNarrowScreen } from './lib/viewport';
import { useBackgroundWorker } from './lib/worker';

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
   * 无限制模式的提示词（用户 2026-09-25）。
   *
   * 它存在本机 `meta` 里，**不进代码、不进网页包**——网页是公开托管的静态站点，
   * 写进源码就等于公开（`core/prompt/unlimited.ts` 顶上记了来龙去脉）。
   * 代价是不参与同步，换设备要重新粘一次（想跟着账户走要新开同步集合，见 TASKS 68b）。
   */
  const unlimitedPrompt = useUnlimitedPrompt(db);

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
  const providers = useProviders(db, sync);

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
  const [newConversationMode, setNewConversationMode] = useState<
    { kind: 'new-world' } | { kind: 'in-world'; worldId: RoomId } | null
  >(null);
  const [sceneOpen, setSceneOpen] = useState(false);
  const [detailId, setDetailId] = useState<InstanceId | null>(null);

  /*
   * 通知与「装到桌面」引导（顺序 66 从 App 里搬到 hooks/useNotices）。
   * 解构用**原来的名字**，所以下面二十多处调用点一个字都不用改。
   */
  const { error, setError, warnings, setWarnings, installHint, dismissInstallHint } = useNotices(storage.ratio);

  /** 「跳到原句」的最近一次请求（T11）：带序号，重复点击同一条也能再闪一次。 */
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const focusSeqRef = useRef(0);
  /*
   * 网页版桥接的状态（顺序 66 搬到 hooks/useWebBridge）：没有 API Key 时的第一条路。
   * 进度落 sessionStorage，刷新之后还在原来的那一步。名字照旧，调用点不用改。
   */
  const { bridge, setBridge } = useWebBridge('main');
  // 流式四态（正文 / 说话人 / 推理流 / 阶段）住在 lib/stream-store.ts（顺序 59）：
  // 每个 token 只让流式气泡重画，不再让整棵树跟着 setState。
  const [busy, setBusy] = useState(false);
  const [lastPrompt, setLastPrompt] = useState<AssembledPrompt | null>(null);

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

  /**
   * 手机顶栏的角色条只要名字（顺序 62 起 `CastName` 就是这个形状）。
   *
   * 点一下某个角色 = 把他的名字插进输入框（应用里已有的「点名叫人」规则），
   * 于是**不用开面板、也不打断这一轮对话**就能直接跟他说话。
   * 用 `seq` 递增是为了「同一个名字连点两次」也能再插一次——只比文本的话第二次什么都不发生。
   */
  const castNames = useMemo<CastName[]>(
    () => cast.map((instance) => ({ id: instance.id, displayName: instance.displayName })),
    [cast],
  );
  const [castAsk, setCastAsk] = useState<{ text: string; seq: number } | null>(null);
  const castAskSeq = useRef(0);
  const handleAskCast = useCallback((displayName: string): void => {
    castAskSeq.current += 1;
    setCastAsk({ text: displayName, seq: castAskSeq.current });
  }, []);

  const availableCards = useMemo(
    () => session.library.cards.filter((card) => !instances.some((instance) => instance.cardId === card.id)),
    [instances, session.library.cards],
  );

  /*
   * 一轮对话的主循环（顺序 66 搬到 hooks/useTurnRunner）：跑一次生成、生成前的
   * 导演调用、发一句、重抽、改归属，连同它们共用的「造一条角色消息」「排一个场记
   * 后台任务」与「停止」句柄。返回值用**原来的名字**，下面几十处调用点不用改。
   */
  const {
    makeCharacterLine,
    enqueueSceneSummary,
    handleSend,
    handleRegenerate,
    handleReassignMessage,
    stop: handleStop,
  } = useTurnRunner({
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
    budgetReason: budget.reason,
    busy,
    setBusy,
    setError,
    setWarnings,
    setBridge,
    setLastPrompt,
  });

  /* 导入素材（顺序 66 搬到 hooks/useImport）：PNG / JSON 卡与世界书，导完顺手收起手机左栏。 */
  const { handleImport } = useImport({
    session,
    activePersona,
    setError,
    setWarnings,
    onImported: closeRailOnNarrow,
  });

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
      worldTitle: string;
      conversationTitle: string;
      cardIds: string[];
      worldBookIds: string[];
      sceneTitle: string;
      location: string;
      worldTime: string;
    }) => {
      const mode = newConversationMode;
      if (mode === null || (mode.kind === 'in-world' && world?.id !== mode.worldId)) return;
      setNewConversationMode(null);
      const cards = session.library.cards.filter((card) => input.cardIds.includes(card.id));

      // 顶层「新对话」总是创建一个独立世界和它的首条对话。
      if (mode.kind === 'new-world') {
        await session.createWorld({
          title: input.worldTitle,
          conversationTitle: input.conversationTitle,
          sceneTitle: input.sceneTitle,
          location: input.location,
          worldTime: input.worldTime,
          persona: activePersona,
          cards,
          worldBookIds: input.worldBookIds as never,
        });
        return;
      }

      const started = await session.startConversation({
        title: input.conversationTitle,
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
    [activePersona, newConversationMode, session, setWarnings, world?.id],
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

  /**
   * 手机上左右两张卡片互斥（用户 2026-09-24 要求的「推开」效果里，同时推开两侧没有意义，
   * 而且位移会互相叠加）。桌面保持原来的独立行为。
   */
  const handleToggleRail = useCallback((): void => {
    if (!narrow) {
      setCollapsed((value) => !value);
      return;
    }
    const opening = collapsed;
    setCollapsed(!opening);
    if (!opening) setPanelOpen(false);
  }, [collapsed, narrow]);

  const handleTogglePanel = useCallback((): void => {
    if (!narrow) {
      setPanelOpen((value) => !value);
      return;
    }
    const opening = !panelOpen;
    setPanelOpen(opening);
    if (opening) setCollapsed(true);
  }, [narrow, panelOpen]);

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
    [session, setWarnings, setError],
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
    [conversation, session, setWarnings],
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
    [bridge, conversation, db, instances, makeCharacterLine, scene, session, world, setBridge, setError],
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
    [bridge, conversation, db, instances, scene, session, sync, world, setWarnings, setError, setBridge],
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
  }, [bridge, setWarnings, setBridge]);

  const handleChangeModes = useCallback(
    (patch: Partial<ConversationModes>) => {
      if (!conversation) return;
      void session.updateConversation({ modes: { ...conversation.modes, ...patch } });
    },
    [conversation, session],
  );

  /*
   * 传给 MainChat / CastRail / WorldTree 的回调都要是稳定引用（顺序 59）：
   * 它们 memo 了，内联箭头函数每次渲染都是新的，等于没 memo。
   */
  /*
   * 但「稳定引用」还差一步（顺序 62）：这几个回调自己依赖 `session`，而 `session`
   * 每写一次库（记忆、情绪、章节、账单）都会换一个新对象——于是它一变，MainChat 里
   * 那包 `handlers` 就跟着变，几百条 `MessageItem` 的 memo 全部失效。
   * 实测：一轮对话整表重画 36 次。
   *
   * 所以过一道 ref：函数体每次都从最新的那个 session 取，但**函数本身的引用不变**。
   */
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const regenerateRef = useRef(handleRegenerate);
  regenerateRef.current = handleRegenerate;
  const deleteMessageRef = useRef(handleDeleteMessage);
  deleteMessageRef.current = handleDeleteMessage;
  const reassignRef = useRef(handleReassignMessage);
  reassignRef.current = handleReassignMessage;

  const handleSendText = useCallback((text: string) => void handleSend(text), [handleSend]);
  const handleRegenerateId = useCallback((id: MessageId) => void regenerateRef.current(id), []);
  const handleEditMessage = useCallback(
    (id: MessageId, content: string) => void sessionRef.current.updateMessage(id, { content }),
    [],
  );
  const handleDeleteId = useCallback((id: MessageId) => void deleteMessageRef.current(id), []);
  const handleOpenScene = useCallback(() => setSceneOpen(true), []);
  const handleDropInstance = useCallback((id: InstanceId) => void session.setPresence(id, 'onstage'), [session]);
  const handleReassignId = useCallback(
    (id: MessageId, instanceId: InstanceId) => void reassignRef.current(id, instanceId),
    [],
  );
  const handleBridgeReplyText = useCallback((text: string) => void handleBridgeReply(text), [handleBridgeReply]);
  const handleBridgeAnalysisText = useCallback(
    (text: string) => void handleBridgeAnalysis(text),
    [handleBridgeAnalysis],
  );
  const handleAddInstance = useCallback((card: Card) => void session.addInstance(card), [session]);
  const handleOpenWorld = useCallback(
    (id: RoomId) => {
      void session.openWorld(id);
      closeRailOnNarrow();
    },
    [closeRailOnNarrow, session],
  );
  const handleNewConversationInWorld = useCallback(
    async (id: RoomId) => {
      if (world?.id !== id) await session.openWorld(id);
      setNewConversationMode({ kind: 'in-world', worldId: id });
      closeRailOnNarrow();
    },
    [closeRailOnNarrow, session, world?.id],
  );
  const handleOpenConversation = useCallback(
    (id: ConversationId) => {
      void session.openConversation(id);
      closeRailOnNarrow();
    },
    [closeRailOnNarrow, session],
  );
  const handleArchiveConversation = useCallback(
    (target: Conversation) => {
      if (
        window.confirm(
          `归档「${target.title}」？情绪、关系与记忆会回滚到它开始之前，这条时间线相当于没有发生过；对话本身会保留在设置里。`,
        )
      ) {
        void handleArchive(target.id);
      }
    },
    [handleArchive],
  );
  const handleDeleteConversation = useCallback(
    (target: Conversation) => void session.deleteConversation(target.id),
    [session],
  );
  const handleDeleteWorld = useCallback((id: RoomId) => void session.deleteWorld(id), [session]);

  /*
   * 副对话（世界管理员）那一批回调同理（顺序 59）：`SideChat` 也 memo 了，
   * 传内联箭头函数等于每次 App 渲染都让它白重画一遍。
   */
  const handleAdminSend = useCallback((text: string) => void admin.send(text), [admin]);
  const handleAdminBridgeCommit = useCallback((text: string) => void admin.commitBridge(text), [admin]);
  const handleAdoptArtifact = useCallback(
    (id: MessageId, artifact: AdminArtifact) => void session.adoptArtifact(id, artifact.id),
    [session],
  );
  const handleDiscardArtifact = useCallback(
    (id: MessageId, artifact: AdminArtifact) => void session.discardArtifact(id, artifact.id),
    [session],
  );
  const handleRevokeArtifact = useCallback(
    (id: MessageId, artifact: AdminArtifact) => void session.revokeArtifact(id, artifact.id),
    [session],
  );
  /** 素材库 id 清单：每次渲染新造一个数组会让 `SideChat` 的 memo 失效。 */
  const adminExistingIds = useMemo(
    () => [
      ...session.library.cards.map((card) => card.id),
      ...session.library.worldBooks.map((book) => book.id),
      ...session.personas.map((persona) => persona.id),
    ],
    [session.library.cards, session.library.worldBooks, session.personas],
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
      className={[
        'app',
        appearance.value.background === '' ? '' : 'has-bg',
        /*
         * 手机上左右两侧都是「把主对话推开」的卡片（用户 2026-09-24 要求，
         * 参考他给的 DeepSeek 截图），所以打开状态要落在根上，CSS 才能一起位移
         * 顶栏与工作区。桌面不加这两个类，行为一个字不变。
         */
        narrow && !collapsed ? 'rail-open' : '',
        narrow && panelOpen ? 'panel-open' : '',
      ]
        .filter((name) => name !== '')
        .join(' ')}
      style={
        {
          '--chat-bg': appearance.value.background === '' ? 'none' : `url("${appearance.value.background}")`,
          '--chat-bg-opacity': appearance.value.background === '' ? 0 : appearance.value.backgroundOpacity,
        } as React.CSSProperties
      }
    >
      <TopBar
        collapsed={collapsed}
        onToggleCollapsed={handleToggleRail}
        degraded={boot?.degraded ?? false}
        backgroundPending={worker.pending}
        narrow={narrow}
        castStrip={<CastStrip cast={castNames} isSide={isSide} onAsk={handleAskCast} />}
        chatControls={
          <ChatControls
            isSide={isSide}
            disabled={disabled}
            panelOpen={panelOpen}
            onToggleKind={() => void handleToggleKind()}
            onTogglePanel={handleTogglePanel}
          />
        }
      />

      <div className={collapsed ? 'app-body collapsed' : 'app-body'}>
        {/*
          手机上左栏**始终挂着**（收起时用位移推到屏幕外）：不挂就没法播「滑出来」的动效，
          而打开时主对话是靠 CSS 平移让位的。桌面保持原样——收起就是不渲染那一列。
        */}
        {collapsed && !narrow ? null : (
          <LeftRail
            pane={pane}
            onPaneChange={setPane}
            onNewConversation={() => {
              setNewConversationMode({ kind: 'new-world' });
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
                  onOpenWorld={handleOpenWorld}
                  onNewConversation={(id) => void handleNewConversationInWorld(id)}
                  onOpenConversation={handleOpenConversation}
                  onArchiveConversation={handleArchiveConversation}
                  onRenameConversation={(target, title) => void session.renameConversation(target.id, title)}
                  onDeleteConversation={handleDeleteConversation}
                  onDeleteWorld={handleDeleteWorld}
                />
              </>
            }
            panel={
              <>
                {pane === 'personas' ? (
                  <section className="panel">
                    <PersonaLibrary
                      personas={session.personas}
                      disabled={disabled}
                      onSave={(persona) => void session.savePersona(persona)}
                      onDelete={(id) => void session.deletePersona(id)}
                    />
                  </section>
                ) : null}

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

        <div className="workspace">
          {/*
            手机上这一行（「世界名 · 对话名」）整条不渲染（用户 2026-09-24 要求）：
            在场角色与两颗按钮已经搬到顶栏，剩下的标题在对话区上面白占一行。
            改名入口搬到左栏的对话列表里（WorldTree 的「改名」）。
          */}
          {narrow ? null : (
            <MainHeader
              world={world}
              conversation={conversation}
              cast={cast}
              disabled={disabled}
              panelOpen={panelOpen}
              narrow={narrow}
              onToggleKind={() => void handleToggleKind()}
              onTogglePanel={handleTogglePanel}
              onRenameConversation={(title) => void session.updateConversation({ title })}
            />
          )}

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
                  busy={admin.busy}
                  ready={ready}
                  archived={archived}
                  bridge={admin.bridge}
                  manualMode={needsWebBridge(providers.apiKey)}
                  error={admin.error}
                  onBridgeCommit={handleAdminBridgeCommit}
                  onBridgeCancel={admin.cancelBridge}
                  onSend={handleAdminSend}
                  onStop={admin.stop}
                  onAdopt={handleAdoptArtifact}
                  onDiscard={handleDiscardArtifact}
                  onRevoke={handleRevokeArtifact}
                  existingIds={adminExistingIds}
                />
              ) : (
                <MainChat
                  conversation={conversation}
                  scene={scene}
                  messages={messages}
                  cast={cast}
                  busy={busy}
                  ready={ready}
                  archived={archived}
                  focus={focus}
                  showIntent={appearance.value.showIntent}
                  bridge={bridge}
                  manualMode={bridge !== null || needsWebBridge(providers.apiKey)}
                  insertRequest={castAsk}
                  onBridgeReply={handleBridgeReplyText}
                  onBridgeAnalysis={handleBridgeAnalysisText}
                  onBridgeSkip={handleBridgeSkip}
                  onSend={handleSendText}
                  onStop={handleStop}
                  onRegenerate={handleRegenerateId}
                  onEdit={handleEditMessage}
                  onDelete={handleDeleteId}
                  onChangeModes={handleChangeModes}
                  unlimitedPrompt={unlimitedPrompt}
                  onOpenScene={handleOpenScene}
                  onDropInstance={handleDropInstance}
                  onReassign={handleReassignId}
                />
              )}

              {/*
                手机上运行时面板也是一张从右侧滑出来的卡片（CSS ≤640px）：
                打开时主对话向左让位，不再铺一层黑遮罩盖住它。
              */}
              <div className={panelOpen ? 'runtime-drawer open' : 'runtime-drawer'}>
                {panelOpen || narrow ? (
                  <RuntimePanel
                    open={panelOpen}
                    focusOnOpen={narrow}
                    onClose={() => setPanelOpen(false)}
                    scene={scene}
                    instances={instances}
                    memories={session.memories}
                    conversations={session.conversations}
                    activeConversationId={conversation?.id ?? null}
                    personas={session.personas}
                    personaId={conversation?.personaId ?? null}
                    playerName={conversation?.playerName ?? world?.playerName ?? ''}
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
                    failedTasks={worker.failed}
                    onRetryFailed={() => void worker.retryFailed()}
                    disabled={disabled}
                    onSceneChange={(patch) => void session.updateScene(patch)}
                    onStartNewScene={(title) => void handleStartNewScene({ title, location: '', worldTime: '' })}
                    onSetPresence={(id, presence) => void session.setPresence(id, presence)}
                    onSelectPersona={(persona) => void session.setPersona(persona)}
                    onRenameInstance={(id, name) => void session.updateInstance(id, { displayName: name })}
                    onRemoveInstance={(id) => void session.removeInstance(id)}
                    onAddInstance={(card) => void session.addInstance(card)}
                    onDetachWorldBook={(id) => void session.detachWorldBook(id)}
                    onUpdateMemory={(id, patch) => void session.updateMemory(id, patch)}
                    onDeleteMemory={(id) => void session.deleteMemory(id)}
                    onLocateMemory={handleLocateMemory}
                  />
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
              onAddInstance={handleAddInstance}
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
          </p>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              dismissInstallHint();
            }}
          >
            知道了
          </button>
        </div>
      ) : null}

      {/*
        点「被移开的对话区」= 收起侧栏（用户 2026-09-24 第二轮要求）：
        一层透明的可点区域，盖在对话与顶栏之上、侧栏卡片之下。
        侧栏自己那些关闭按钮（左栏的 ≡、面板的「收起面板」）已经按用户要求删掉。
      */}
      {narrow && (!collapsed || panelOpen) ? (
        <button
          type="button"
          className="drawer-backdrop"
          aria-label="收起侧栏"
          onClick={() => {
            setCollapsed(true);
            setPanelOpen(false);
          }}
        />
      ) : null}

      {newConversationMode !== null &&
      (newConversationMode.kind === 'new-world' || world?.id === newConversationMode.worldId) ? (
        <NewConversationDialog
          mode={newConversationMode.kind}
          currentWorldTitle={world?.title}
          cards={session.library.cards}
          worldBooks={session.library.worldBooks}
          defaultCardIds={newConversationMode.kind === 'new-world' ? [] : instances.map((instance) => instance.cardId)}
          attachedBookIds={newConversationMode.kind === 'new-world' ? [] : (world?.worldBookIds ?? [])}
          disabled={disabled}
          onClose={() => setNewConversationMode(null)}
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

      {/* 设置弹窗：模型、外观、账户、数据与归档；玩家身份已移到左栏。 */}
      {settingsCategory === null ? null : (
        <SettingsDialog
          category={settingsCategory}
          onCategoryChange={setSettingsCategory}
          onClose={() => setSettingsCategory(null)}
          providers={providers}
          appearance={appearance}
          archivedConversations={session.archivedConversations}
          activeConversationId={conversation?.id ?? null}
          disabled={disabled}
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
