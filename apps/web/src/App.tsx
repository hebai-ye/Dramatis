import {
  type AdminArtifact,
  type AssembledPrompt,
  budgetWriteVersion,
  buildSceneTransitionNarration,
  buildSignatures,
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
  type Scene,
  type SignatureOwner,
  selectSceneMembers,
} from '@dramatis/core';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CastDetail } from './components/CastDetail';
import { CastRail } from './components/CastRail';
import { CastStrip } from './components/CastStrip';
import { ChatControls } from './components/ChatControls';
import { DeepSeekKeyDialog } from './components/DeepSeekKeyDialog';
import { DialogShell } from './components/DialogShell';
import { ImportRecoveryNotice } from './components/ImportRecoveryNotice';
import { LazyPanel } from './components/LazyPanel';
import { LeftRail } from './components/LeftRail';
import { LibraryWorkspace, LibraryWorkspaceProvider } from './components/LibraryWorkspace';
import { type FocusRequest, MainChat } from './components/MainChat';
import { MainHeader } from './components/MainHeader';
import { NewConversationDialog } from './components/NewConversationDialog';
import runtimeAddress from './components/RuntimePanel?lazy-module-url';
import { SceneDialog, type SceneSwitchResult } from './components/SceneDialog';
import type { SettingsCategory } from './components/SettingsDialog';
import sideAddress from './components/SideChat?lazy-module-url';
import { TopBar } from './components/TopBar';
import { WorldTree } from './components/WorldTree';
import { createBudgetDraftStore } from './hooks/useBudgetDraftMemory';
import { useDeepSeekSetup } from './hooks/useDeepSeekSetup';
import { useImport } from './hooks/useImport';
import { useLibraryNavigation, useLibrarySurface } from './hooks/useLibraryWorkspace';
import { useNotices } from './hooks/useNotices';
import { useTurnRunner } from './hooks/useTurnRunner';
import { useWebBridge } from './hooks/useWebBridge';
import { useAdminChat } from './lib/admin';
import { useAppearance } from './lib/appearance';
import { useArchive } from './lib/archive';
import {
  applyBridgeAnalysis,
  bridgeReplyBatch,
  prepareBridgeAnalysis,
  prepareReassignedBridgeAnalysis,
  readPendingBridgeProgress,
  recoverPendingBridgeState,
  validateBridgeReplyContent,
  validatePendingBridgeTurn,
} from './lib/bridge-store';
import { ChatDraftProvider, type SubmitOutcome } from './lib/chat-draft';
import { activeDbName } from './lib/db';
import { createLazyModule } from './lib/lazy-module';
import { avatarOf } from './lib/portraits';
import { useProviders } from './lib/providers';
import { useDatabase, useSession } from './lib/session';
import { useStorageStatus } from './lib/storage';
import { useSync } from './lib/sync';
import { extraCalls, useUsage } from './lib/usage';
import { NARROW_SCREEN_QUERY, useNarrowScreen } from './lib/viewport';
import { useBackgroundWorker } from './lib/worker';
import { UNLIMITED_PROMPT } from './prompt/unlimitedPreset';

const loadRuntimePanel = createLazyModule(
  runtimeAddress,
  (module: typeof import('./components/RuntimePanel')) => module.RuntimePanel,
);
const loadSideChat = createLazyModule(sideAddress, (module: typeof import('./components/SideChat')) => module.SideChat);

const loadSettingsDialog = () =>
  import('./components/SettingsDialog').then((module) => ({ default: module.SettingsDialog }));
const loadAccountDialog = () =>
  import('./components/AccountDialog').then((module) => ({ default: module.AccountDialog }));

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
    turnId: session.messages.at(-1)?.turnId ?? null,
  });

  /**
   * 无限制模式的正文（用户 2026-09-26 裁定，顺序 92）。
   *
   * **仓库里固定一份，所有对话共用**：正文写在 `prompt/unlimited-preset.txt`，
   * 由 `prompt/unlimitedPreset.ts` 用 Vite 的 `?raw` 读成字符串。它会被编译进公开可下载的
   * 网页包——这是用户明确接受的取舍（早先版本为了保密把正文挪进本机库，本批又搬了回来，
   * 来龙去脉写在 `prompt/unlimitedPreset.ts` 与 `core/prompt/unlimited.ts` 的注释里）。
   * 生成那一侧在 `useTurnRunner` 里另取一次同一个常量；这里只用于菜单的「配没配好」。
   */
  const unlimitedPrompt = UNLIMITED_PROMPT;

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
    accountKey: activeDbName(),
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
    onImported: async (id) => {
      if (!(await beforeNavigate())) throw new Error('当前编辑尚未保存，未切换世界。导入的世界可从左栏稍后打开。');
      await session.refreshAll();
      await session.openWorld(id);
    },
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
  const [panelOpen, setPanelOpen] = useState(false);
  const runtimeFlushRef = useRef<(() => Promise<boolean>) | null>(null);
  const beforeNavigate = useCallback(() => runtimeFlushRef.current?.() ?? Promise.resolve(true), []);
  const registerRuntimeFlush = useCallback((flush: (() => Promise<boolean>) | null) => {
    runtimeFlushRef.current = flush;
  }, []);
  const closeRuntime = useCallback(() => {
    void beforeNavigate().then((ok) => {
      if (ok) setPanelOpen(false);
    });
  }, [beforeNavigate]);
  const {
    libraryNavigation,
    enterLibrary,
    returnFromLibrary,
    openWorld,
    openConversation,
    navigateCreated,
    navigateSide,
    navigateImported,
  } = useLibraryNavigation(session, db, narrow, setCollapsed, setPanelOpen, beforeNavigate);
  const [libraryOccupied, setLibraryOccupied] = useState(false);
  // 桌面允许双开；缩到手机宽度时左栏优先，避免两侧位移同时作用。
  useLayoutEffect(() => {
    if (narrow && !collapsed && panelOpen) setPanelOpen(false);
  }, [narrow, collapsed, panelOpen]);
  /** 账户与设置独立打开，入口函数确保不叠窗。 */
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const dialogReturnFocus = useRef<HTMLElement | null>(null);
  const openSettings = useCallback(
    (category: SettingsCategory = 'model') => {
      dialogReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setAccountOpen(false);
      setSettingsCategory(category);
      closeRailOnNarrow();
    },
    [closeRailOnNarrow],
  );
  const openAccount = useCallback(() => {
    dialogReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSettingsCategory(null);
    setAccountOpen(true);
    closeRailOnNarrow();
  }, [closeRailOnNarrow]);
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
  useEffect(() => {
    if ((boot?.pendingAccountDeletions ?? 0) === 0) return;
    setWarnings((previous) =>
      previous.some((item) => item.code === 'account-cleanup')
        ? previous
        : [
            ...previous,
            {
              code: 'account-cleanup',
              message:
                '本机账户已移出列表，但仍有清理未完成。请关闭其他 Dramatis 标签页；在账户中查看或重试清理。服务器密文副本不会因此删除。',
              action: { label: '查看账户', run: openAccount },
            },
          ],
    );
  }, [boot?.pendingAccountDeletions, openAccount, setWarnings]);

  /** 「跳到原句」的最近一次请求（T11）：带序号，重复点击同一条也能再闪一次。 */
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const focusSeqRef = useRef(0);
  const locateNavigationRef = useRef<Promise<void>>(Promise.resolve());
  const locateTargetsRef = useRef<Set<ConversationId>>(new Set());
  const previousConversationIdRef = useRef(conversation?.id);
  useEffect(() => {
    if (previousConversationIdRef.current === conversation?.id) return;
    previousConversationIdRef.current = conversation?.id;
    if (
      focus !== null &&
      focus.conversationId !== conversation?.id &&
      (conversation?.id === undefined || !locateTargetsRef.current.has(conversation.id))
    ) {
      focusSeqRef.current += 1;
      locateTargetsRef.current.clear();
      setFocus(null);
    }
  }, [conversation?.id, focus]);
  const cancelPendingFocus = useCallback((): void => {
    focusSeqRef.current += 1;
    locateTargetsRef.current.clear();
    setFocus(null);
  }, []);
  /*
   * 网页版桥接的状态（顺序 66 搬到 hooks/useWebBridge）：没有 API Key 时的第一条路。
   * 进度落 sessionStorage，刷新之后还在原来的那一步。名字照旧，调用点不用改。
   */
  const { bridge, setBridge } = useWebBridge('main');
  // 流式四态（正文 / 说话人 / 推理流 / 阶段）住在 lib/stream-store.ts（顺序 59）：
  // 每个 token 只让流式气泡重画，不再让整棵树跟着 setState。
  const [busy, setBusy] = useState(false);
  const [ownedPrompt, setOwnedPrompt] = useState<{
    prompt: AssembledPrompt;
    scope: string;
    label: string;
    preparedAt: string;
  } | null>(null);

  const scene = session.scene;
  const sceneUiScopeRef = useRef({ worldId: world?.id, conversationId: conversation?.id, sceneId: scene?.id });
  sceneUiScopeRef.current = { worldId: world?.id, conversationId: conversation?.id, sceneId: scene?.id };
  const messages = session.messages;
  const instances = session.instances;
  const personas = session.personas;
  const accountKey = activeDbName();
  const budgetDraftOwnerRef = useRef({ accountKey, store: createBudgetDraftStore() });
  if (budgetDraftOwnerRef.current.accountKey !== accountKey)
    budgetDraftOwnerRef.current = { accountKey, store: createBudgetDraftStore() };
  const promptScope = JSON.stringify([accountKey, world?.id ?? null, conversation?.id ?? null]);
  const promptScopeRef = useRef(promptScope);
  promptScopeRef.current = promptScope;
  const promptLabel = [world?.title, conversation?.title].filter(Boolean).join(' / ');
  const setLastPrompt = useCallback(
    (prompt: AssembledPrompt | null, speakerName?: string) => {
      if (promptScopeRef.current !== promptScope) return;
      setOwnedPrompt(
        prompt === null
          ? null
          : {
              prompt,
              scope: promptScope,
              label: [promptLabel, speakerName].filter(Boolean).join(' / '),
              preparedAt: new Date().toISOString(),
            },
      );
    },
    [promptScope, promptLabel],
  );
  const currentPrompt = ownedPrompt?.scope === promptScope ? ownedPrompt : null;
  const consumeFocus = useCallback(
    (seq: number, found: boolean) => {
      if (focusSeqRef.current === seq) locateTargetsRef.current.clear();
      setFocus((current) => (current?.seq === seq ? null : current));
      if (!found)
        setWarnings((previous) => [
          ...previous.filter((item) => item.code !== 'message.locate'),
          { code: 'message.locate', message: '这条原句已不在当前记录中，可以继续查看其他消息。' },
        ]);
    },
    [setWarnings],
  );

  const bridgeRequestRef = useRef<symbol | null>(null);
  const runnerBridgeRequestRef = useRef(0);
  const bridgeOwnerRef = useRef<{
    db: typeof db;
    bridge: typeof bridge;
    roomId: RoomId | null;
    conversationId: ConversationId | null;
    sceneId: string | null;
    accountKey: string;
  } | null>(null);
  useLayoutEffect(() => {
    if (bridgeRequestRef.current !== null) {
      bridgeRequestRef.current = null;
      setBusy(false);
    }
    runnerBridgeRequestRef.current++;
    bridgeOwnerRef.current = {
      db,
      bridge,
      roomId: world?.id ?? null,
      conversationId: conversation?.id ?? null,
      sceneId: scene?.id ?? null,
      accountKey,
    };
    return () => {
      bridgeOwnerRef.current = null;
    };
  }, [db, bridge, world?.id, conversation?.id, scene?.id, accountKey]);

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

  /**
   * 每个角色「只有他写过」的说法（顺序 79），串线提示的素材。
   *
   * 口径写在 `packages/core/src/render/bleed.ts`：只用**用户自己写的角色卡**
   * （描述、性格、标签），不猜道具词表；世界书与场景设定里写过的说法算全场共有，
   * 被排除在外——否则「客栈」「柜台」这类布景词会把每个人都判成串线。
   *
   * 与 `avatars` 同一套路：内容拼成 `signatureKey`，只有它变了才重建数组。
   * `MessageList`/`MessageItem` 是按引用比较的 `memo`，每轮分析写入后无条件换新数组
   * 会让几百条消息全部重画。
   */
  const signatureKey = [
    ...cast.map((instance) => {
      const card = session.library.cards.find((item) => item.id === instance.cardId);
      return [
        instance.id,
        instance.displayName,
        card?.name ?? '',
        card?.nickname ?? '',
        card?.description ?? '',
        card?.personality ?? '',
        (card?.tags ?? []).join('、'),
      ].join(':');
    }),
    ...session.worldBooks.flatMap((book) => book.entries.map((entry) => entry.content)),
    scene?.summary ?? '',
  ].join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: 内容已汇总进 signatureKey，避免后台每轮写入触发重建
  const signatures = useMemo<SignatureOwner[]>(
    () =>
      buildSignatures(
        cast.map((instance) => {
          const card = session.library.cards.find((item) => item.id === instance.cardId);
          return {
            instanceId: instance.id,
            displayName: instance.displayName,
            material: [card?.description ?? '', card?.personality ?? '', (card?.tags ?? []).join('、')],
            aliases: [instance.displayName, card?.name ?? '', card?.nickname ?? ''],
          };
        }),
        {
          shared: [
            ...session.worldBooks.flatMap((book) => book.entries.map((entry) => entry.content)),
            scene?.summary ?? '',
          ],
        },
      ),
    [signatureKey],
  );
  /** 包含离场角色：旧消息仍应显示原说话人的头像。状态数值变化不重建这份映射。 */
  const avatarKey = instances
    .map((instance) => {
      const card = session.library.cards.find((item) => item.id === instance.cardId);
      return `${instance.id}:${instance.cardId}:${card?.updatedAt ?? ''}`;
    })
    .join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅头像相关的角色卡版本变化时才更新旧消息
  const avatars = useMemo<Record<string, string | null>>(
    () =>
      Object.fromEntries(
        instances.map((instance) => [
          instance.id,
          avatarOf(session.library.cards.find((card) => card.id === instance.cardId)),
        ]),
      ),
    [avatarKey],
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

  // The runner also opens analysis after “改归属”. Prepare from committed data
  // before displaying that prompt, just as the normal pasted-reply path does.
  const publishRunnerBridge = useCallback(
    (next: typeof bridge) => {
      const owner = bridgeOwnerRef.current;
      if (
        !owner ||
        owner.db !== db ||
        owner.roomId !== (world?.id ?? null) ||
        owner.conversationId !== (conversation?.id ?? null) ||
        owner.sceneId !== (scene?.id ?? null) ||
        owner.accountKey !== accountKey ||
        activeDbName() !== accountKey
      )
        return;
      const request = ++runnerBridgeRequestRef.current;
      if (next?.stage !== 'analysis') {
        setBridge(next);
        return;
      }
      if (!db || !world || !conversation || !scene || !next.turnId) {
        setError('当前世界或场景已变化，无法准备桥接分析。');
        return;
      }
      void prepareReassignedBridgeAnalysis(
        db.repository,
        {
          roomId: world.id,
          conversationId: conversation.id,
          sceneId: scene.id,
        },
        next.turnId,
        accountKey,
      )
        .then((prepared) => {
          if (
            runnerBridgeRequestRef.current === request &&
            bridgeOwnerRef.current === owner &&
            activeDbName() === accountKey
          )
            setBridge(prepared);
        })
        .catch((failure: unknown) => {
          if (runnerBridgeRequestRef.current === request && bridgeOwnerRef.current === owner)
            setError(
              `回复归属已保存，但分析准备失败：${failure instanceof Error ? failure.message : String(failure)}；请检查原回合后重试。`,
            );
        });
    },
    [accountKey, conversation, db, scene, setBridge, setError, world],
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
    prepareBridgeReply,
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
    accountKey,
    bridgeOpen: bridge !== null,
    setBusy,
    setError,
    setWarnings,
    setBridge: publishRunnerBridge,
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
    async (input: {
      title: string;
      location: string;
      worldTime: string;
      cast?: readonly InstanceId[];
    }): Promise<SceneSwitchResult> => {
      if (!world || !conversation) return { status: 'unavailable', message: '当前对话尚未就绪，请稍后再试。' };
      const scope = sceneUiScopeRef.current;
      if (scope.worldId !== world.id || scope.conversationId !== conversation.id || scope.sceneId !== scene?.id)
        return { status: 'unavailable', message: '当前场景已变化，请关闭后重新打开场景面板。' };

      const created = await session.startNewScene(input);
      if (!created) return { status: 'unavailable', message: '未能开启新场景，请检查当前对话后再试。' };

      try {
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

        if (scene !== null && scene.id !== created.id) await enqueueSceneSummary(scene, 'close');
        return { status: 'complete' };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const message = `场景已切换，但换场记录或上一场收尾未完成：${detail}`;
        setWarnings((previous) => [
          ...previous.filter((notice) => notice.code !== 'scene.transition'),
          { code: 'scene.transition', message },
        ]);
        return { status: 'partial', message: `换场记录或上一场收尾未完成：${detail}` };
      }
    },
    [conversation, enqueueSceneSummary, instances, scene, session, world, setWarnings],
  );
  const handleSceneSave = useCallback(
    async (patch: Partial<Scene>): Promise<void> => {
      const scope = sceneUiScopeRef.current;
      if (
        !world ||
        !conversation ||
        !scene ||
        scope.worldId !== world.id ||
        scope.conversationId !== conversation.id ||
        scope.sceneId !== scene.id
      )
        throw new Error('当前场景已变化，请关闭后重新打开场景面板。');
      const saved = await session.setWorldScene(patch, conversation.id, world.id);
      if (saved === null) throw new Error('未能保存当前场景，请检查对话是否仍可编辑。');
    },
    [world, conversation, scene, session],
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
      if (mode === null || (mode.kind === 'in-world' && world?.id !== mode.worldId))
        throw new Error('创建目标已变化，请重新打开新对话。');
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
    if (!(await beforeNavigate())) return;
    cancelPendingFocus();
    if (session.world === null) {
      await session.createWorld({ title: '新世界', persona: activePersona, cards: [] });
    }
    await session.openSideConversation();
  }, [activePersona, session, beforeNavigate, cancelPendingFocus]);

  const handleToggleKind = useCallback(async () => {
    if (!(await beforeNavigate())) return;
    cancelPendingFocus();
    if (conversation?.kind === 'side') {
      const main = session.conversations.find((item) => item.kind === 'main');
      if (main) await session.openConversation(main.id);
      return;
    }
    await session.openSideConversation();
  }, [conversation, session, beforeNavigate, cancelPendingFocus]);

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
    if (opening) setPanelOpen(false);
  }, [collapsed, narrow]);

  const handleTogglePanel = useCallback(async (): Promise<void> => {
    if (panelOpen && !(await beforeNavigate())) return;
    if (!narrow) {
      setPanelOpen((value) => !value);
      return;
    }
    const opening = !panelOpen;
    setPanelOpen(opening);
    if (opening) setCollapsed(true);
  }, [narrow, panelOpen, beforeNavigate]);

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
              openSettings('archive');
              setWarnings([]);
            },
          },
        },
      ]);
    },
    [session, setWarnings, setError, openSettings],
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
      const request: FocusRequest = { id: hit.messageId, seq: focusSeqRef.current, conversationId: hit.conversationId };
      locateTargetsRef.current.add(hit.conversationId);
      setFocus(request);
      // 同时点多条记忆时按请求顺序切换；后发的目标最终获胜，过期请求不再启动。
      locateNavigationRef.current = locateNavigationRef.current
        .catch(() => {})
        .then(async () => {
          if (focusSeqRef.current !== request.seq) return;
          await session.openConversation(hit.conversationId);
          setFocus((current) => (current?.seq === request.seq ? { ...current, settled: true } : current));
        });
    },
    [session, setWarnings],
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

      const pending = bridge.pendingTurn;
      if (!pending) {
        setError('这份旧回复缺少来源绑定，未写入任何消息；请放弃旧进度并重新准备这一轮。');
        return;
      }
      if (pending.accountKey !== accountKey) {
        setError('这份回复不属于当前本机账户，或旧进度缺少账户来源；请回到原账户，或放弃后重新准备。');
        return;
      }
      const savedTurn = session.messages.filter((message) => message.turnId === bridge.turnId);
      if (pending) {
        const issue = validatePendingBridgeTurn(
          pending,
          { roomId: world.id, conversationId: conversation.id, sceneId: scene.id },
          savedTurn,
        );
        if (issue !== null || pending.speakerIds[pending.nextIndex] !== bridge.speakerInstanceId) {
          setError(issue ?? '网页版桥接进度与当前发言人不一致，请重新发送这一句。');
          return;
        }
      }

      const speaker = instances.find((item) => item.id === bridge.speakerInstanceId);
      if (
        speaker === undefined ||
        !scene.cast.includes(speaker.id) ||
        speaker.presence !== 'onstage' ||
        speaker.deletedAt !== null
      ) {
        setError('找不到这一轮该说话的角色（也许它已经离开了这个世界）。');
        return;
      }

      const text = cleanPastedReply(raw);
      if (text === '') {
        setError('贴回来的内容是空的。');
        return;
      }
      if (bridgeRequestRef.current !== null) return;
      const request = Symbol('bridge-reply');
      bridgeRequestRef.current = request;
      const owner = bridgeOwnerRef.current;
      const isCurrent = () => owner !== null && bridgeOwnerRef.current === owner && activeDbName() === accountKey;
      setBusy(true);
      let committed = false;
      try {
        const line = makeCharacterLine(speaker, text, bridge.turnId, scene);
        if (line.content.trim() === '') throw new Error('贴回来的内容没有可显示的角色回复。');
        const contentIssue = validateBridgeReplyContent(pending, line.content);
        if (contentIssue !== null) throw new Error(contentIssue);
        const batch = bridgeReplyBatch(pending, line, world.playerName);
        await session.appendMessages(batch);
        committed = true;
        if (!isCurrent()) return;
        sync.requestAutoSync();
        const turnMessages = [...savedTurn, ...batch];

        if (pending) {
          const prepared = await recoverPendingBridgeState({
            pending,
            committed: pending.nextIndex + 1,
            history: [...session.messages.filter((message) => message.turnId !== bridge.turnId), ...turnMessages],
            speakers: instances,
            preparePrompt: async (state, history) => prepareBridgeReply({ pendingTurn: state, history }),
            prepareAnalysis: () =>
              prepareBridgeAnalysis(
                db.repository,
                {
                  roomId: pending.roomId,
                  conversationId: pending.conversationId,
                  sceneId: pending.sceneId,
                  turnId: pending.turnId,
                },
                accountKey,
              ),
          });
          if (isCurrent()) setBridge(prepared);
          return;
        }

        const prepared = await prepareBridgeAnalysis(
          db.repository,
          { roomId: world.id, conversationId: conversation.id, sceneId: scene.id, turnId: bridge.turnId },
          accountKey,
        );
        if (isCurrent()) setBridge(prepared);
      } catch (bridgeError) {
        if (!isCurrent()) return;
        const detail = bridgeError instanceof Error ? bridgeError.message : String(bridgeError);
        setError(
          committed ? `已保存贴回的回复，但下一步未完成：${detail}。桥接进度会按已保存消息恢复；刷新可重试。` : detail,
        );
      } finally {
        if (bridgeRequestRef.current === request) {
          bridgeRequestRef.current = null;
          setBusy(false);
        }
      }
    },
    [
      bridge,
      accountKey,
      conversation,
      db,
      instances,
      makeCharacterLine,
      prepareBridgeReply,
      scene,
      session,
      sync,
      world,
      setBridge,
      setError,
    ],
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
      if (bridgeRequestRef.current !== null) return;
      const request = Symbol('bridge-analysis');
      bridgeRequestRef.current = request;
      const isCurrent = () => {
        const owner = bridgeOwnerRef.current;
        return (
          owner?.db === db &&
          owner.bridge === bridge &&
          owner.roomId === world.id &&
          owner.conversationId === conversation.id &&
          owner.sceneId === scene.id &&
          owner.accountKey === accountKey &&
          activeDbName() === accountKey
        );
      };
      setBusy(true);
      try {
        const result = await applyBridgeAnalysis({
          repository: db.repository,
          bridge,
          current: { roomId: world.id, sceneId: scene.id, conversationId: conversation.id },
          accountKey,
          raw,
          isCurrent,
        });
        if (!isCurrent()) return;
        await session.reloadWorld();
        if (!isCurrent()) return;
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
        if (isCurrent()) setError(bridgeError instanceof Error ? bridgeError.message : String(bridgeError));
      } finally {
        if (bridgeRequestRef.current === request) {
          bridgeRequestRef.current = null;
          setBusy(false);
        }
      }
    },
    [bridge, accountKey, conversation, db, scene, session, sync, world, setWarnings, setError, setBridge],
  );

  /** 放弃这一次转接：第一步放弃等于这一轮没有回复，第二步放弃等于这一轮没写记忆。 */
  const handleBridgeSkip = useCallback(() => {
    const stage = bridge?.stage ?? null;
    const nextIndex = bridge?.pendingTurn?.nextIndex ?? 0;
    setBridge(null);
    if (stage === 'reply' && nextIndex > 0) {
      setWarnings([
        {
          code: 'bridge.skip-remainder',
          message: '已保存前面角色的回复；剩余角色本轮不再接话，记忆与情绪推演也已跳过。',
        },
      ]);
    }
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

  /*
   * 桥接状态存在 sessionStorage，而首份消息写在 IndexedDB：两份存储不能跨库做同一个
   * 事务。刷新恰落在“首人已保存、下一份提示词尚未持久化”之间时，以消息前缀为准
   * 恢复到下一位，绝不让旧面板把首人的回复再贴一遍。
   */
  useEffect(() => {
    const pending = bridge?.pendingTurn;
    if (
      busy ||
      bridge?.stage !== 'reply' ||
      !pending ||
      !db ||
      !world ||
      !conversation ||
      !scene ||
      pending.roomId !== world.id ||
      pending.conversationId !== conversation.id ||
      pending.sceneId !== scene.id
    ) {
      return;
    }
    if (pending.accountKey !== accountKey) {
      setError('这份桥接进度缺少当前账户来源，请回到原账户，或放弃后重新准备。');
      return;
    }
    const turnMessages = session.messages.filter((message) => message.turnId === pending.turnId);
    const progress = readPendingBridgeProgress(
      pending,
      { roomId: world.id, conversationId: conversation.id, sceneId: scene.id },
      turnMessages,
    );
    if ('error' in progress) {
      setError(progress.error);
      return;
    }
    if (progress.committed === pending.nextIndex) return;
    if (progress.committed < pending.nextIndex) {
      setError('网页版桥接进度领先于已保存消息，请刷新并检查原对话后再继续。');
      return;
    }
    let cancelled = false;
    const recover = async () => {
      const next = await recoverPendingBridgeState({
        pending,
        committed: progress.committed,
        history: session.messages,
        speakers: instances,
        preparePrompt: async (state, history) => prepareBridgeReply({ pendingTurn: state, history }),
        prepareAnalysis: () =>
          prepareBridgeAnalysis(
            db.repository,
            {
              roomId: pending.roomId,
              conversationId: pending.conversationId,
              sceneId: pending.sceneId,
              turnId: pending.turnId,
            },
            accountKey,
          ),
      });
      if (cancelled) return;
      setBridge(next);
    };
    void recover().catch((error: unknown) => {
      if (!cancelled) {
        setError(`网页版桥接恢复失败：${error instanceof Error ? error.message : String(error)}；刷新可重试。`);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    bridge,
    accountKey,
    busy,
    conversation,
    db,
    instances,
    prepareBridgeReply,
    scene,
    session.messages,
    setBridge,
    setError,
    world,
  ]);

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

  const handleSendText = useCallback(
    (text: string) =>
      new Promise<SubmitOutcome>((resolve) => {
        void handleSend(text, resolve)
          .then(resolve)
          .catch((error) =>
            resolve({ status: 'uncertain', reason: error instanceof Error ? error.message : String(error) }),
          );
      }),
    [handleSend],
  );
  const handleRegenerateId = useCallback((id: MessageId) => void regenerateRef.current(id), []);
  const handleEditMessage = useCallback(async (id: MessageId, content: string) => {
    await sessionRef.current.updateMessage(id, { content });
  }, []);
  const handleDeleteId = useCallback((id: MessageId) => void deleteMessageRef.current(id), []);
  const handleOpenScene = useCallback(() => {
    void beforeNavigate().then((ok) => {
      if (ok) setSceneOpen(true);
    });
  }, [beforeNavigate]);
  const handleOpenDetail = useCallback(
    (id: InstanceId) => {
      void beforeNavigate().then((ok) => {
        if (ok) setDetailId(id);
      });
    },
    [beforeNavigate],
  );
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
    (id: RoomId) => void openWorld(id, cancelPendingFocus),
    [cancelPendingFocus, openWorld],
  );
  const handleNewConversationInWorld = useCallback(
    (id: RoomId) =>
      openWorld(id, () => {
        cancelPendingFocus();
        setNewConversationMode({ kind: 'in-world', worldId: id });
        closeRailOnNarrow();
      }),
    [cancelPendingFocus, closeRailOnNarrow, openWorld],
  );
  const handleOpenConversation = useCallback(
    (id: ConversationId) => {
      cancelPendingFocus();
      void openConversation(id);
    },
    [cancelPendingFocus, openConversation],
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
  const handleAdminSend = useCallback(
    (text: string, targetConversationId?: ConversationId) =>
      new Promise<SubmitOutcome>((resolve) => {
        void admin
          .send(text, targetConversationId, resolve)
          .then(resolve)
          .catch((error) =>
            resolve({ status: 'uncertain', reason: error instanceof Error ? error.message : String(error) }),
          );
      }),
    [admin],
  );
  const handleAdminBridgeCommit = useCallback((text: string) => void admin.commitBridge(text), [admin]);
  const artifactOperationsRef = useRef(new Map<string, Promise<void>>());
  const runArtifactAction = useCallback(
    (id: MessageId, artifact: AdminArtifact, action: () => Promise<void>): Promise<void> => {
      const key = JSON.stringify([world?.id, id, artifact.id]);
      const existing = artifactOperationsRef.current.get(key);
      if (existing) return existing;
      const operation = action().finally(() => {
        artifactOperationsRef.current.delete(key);
      });
      artifactOperationsRef.current.set(key, operation);
      return operation;
    },
    [world?.id],
  );
  const handleAdoptArtifact = useCallback(
    (id: MessageId, artifact: AdminArtifact) =>
      runArtifactAction(id, artifact, () => session.adoptArtifact(id, artifact.id)),
    [session, runArtifactAction],
  );
  const handleDiscardArtifact = useCallback(
    (id: MessageId, artifact: AdminArtifact) =>
      runArtifactAction(id, artifact, () => session.discardArtifact(id, artifact.id)),
    [session, runArtifactAction],
  );
  const handleRevokeArtifact = useCallback(
    (id: MessageId, artifact: AdminArtifact) =>
      runArtifactAction(id, artifact, () => session.revokeArtifact(id, artifact.id)),
    [session, runArtifactAction],
  );
  const handleReverseArtifact = useCallback(
    (id: MessageId, artifact: AdminArtifact) =>
      runArtifactAction(id, artifact, () => session.reverseArtifact(id, artifact.id)),
    [session, runArtifactAction],
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

  const disabled = busy || admin.busy || !session.ready;
  const keySetup = useDeepSeekSetup({
    accountKey,
    providers,
    blocked:
      disabled ||
      bridge !== null ||
      admin.bridge != null ||
      accountOpen ||
      settingsCategory !== null ||
      newConversationMode !== null ||
      sceneOpen ||
      detailId !== null ||
      libraryOccupied,
  });
  const configureDeepSeek = useCallback(() => {
    dialogReturnFocus.current =
      typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    keySetup.requestOpen();
  }, [keySetup.requestOpen]);
  const { libraryCounts, librarySurface } = useLibrarySurface(session, disabled, handleImport);
  const detail = detailId === null ? null : (instances.find((instance) => instance.id === detailId) ?? null);
  const worldId = world?.id ?? null;

  // 换世界时把选中态清掉，避免看到上一个世界的角色详情
  useEffect(() => {
    if (worldId === null) return;
    setDetailId(null);
  }, [worldId]);

  return (
    // 外观变量供聊天固定背景使用；素材状态由局部 Provider 持有。
    <ChatDraftProvider key={accountKey}>
      <LibraryWorkspaceProvider
        navigationRef={libraryNavigation}
        onEnter={enterLibrary}
        onReturn={returnFromLibrary}
        onOccupancyChange={setLibraryOccupied}
      >
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

          <ImportRecoveryNotice
            recoveredImports={boot?.recoveredImports ?? 0}
            warnings={boot?.importRecoveryWarnings ?? []}
          />

          <div className={collapsed ? 'app-body collapsed' : 'app-body'}>
            {/*
          手机上左栏**始终挂着**（收起时用位移推到屏幕外）：不挂就没法播「滑出来」的动效，
          而打开时主对话是靠 CSS 平移让位的。桌面保持原样——收起就是不渲染那一列。
        */}
            {collapsed && !narrow ? null : (
              <LeftRail
                counts={libraryCounts}
                onNewConversation={() => {
                  void libraryNavigation.current?.requestAction(() => {
                    setNewConversationMode({ kind: 'new-world' });
                    closeRailOnNarrow();
                  });
                }}
                onCreateWithAi={() => void navigateSide(handleCreateWithAi)}
                onImportFile={(file) => void navigateImported(() => handleImport(file))}
                onOpenSettings={() => openSettings('model')}
                onOpenAccount={openAccount}
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
              />
            )}

            <LibraryWorkspace surfaceProps={librarySurface} hasConversation={conversation !== null}>
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
                      尚未配置 Key ·{' '}
                      <button type="button" className="ghost" onClick={configureDeepSeek}>
                        配置 DeepSeek Key
                      </button>
                    </p>
                  ) : null}
                </section>
              ) : (
                <div className="workspace-body">
                  {isSide ? (
                    <LazyPanel
                      load={loadSideChat}
                      label="世界管理员"
                      panelProps={{
                        draftScope: `${accountKey}:${conversation.id}`,
                        conversation: conversation,
                        messages: messages,
                        busy: admin.busy,
                        ready: ready,
                        archived: archived,
                        bridge: admin.bridge,
                        manualMode: needsWebBridge(providers.apiKey),
                        error: admin.error,
                        onBridgeCommit: handleAdminBridgeCommit,
                        onBridgeCancel: admin.cancelBridge,
                        onSend: handleAdminSend,
                        onStop: admin.stop,
                        onAdopt: handleAdoptArtifact,
                        onDiscard: handleDiscardArtifact,
                        onRevoke: handleRevokeArtifact,
                        onReverse: handleReverseArtifact,
                        conversations: session.conversations,
                        worldBooks: session.library.worldBooks,
                        existingIds: adminExistingIds,
                      }}
                    />
                  ) : (
                    <MainChat
                      draftScope={`${accountKey}:${conversation.id}`}
                      conversation={conversation}
                      scene={scene}
                      messages={messages}
                      cast={cast}
                      avatars={avatars}
                      busy={busy}
                      ready={ready}
                      archived={archived}
                      focus={focus}
                      onFocusConsumed={consumeFocus}
                      showIntent={appearance.value.showIntent}
                      bridge={bridge}
                      manualMode={bridge !== null || needsWebBridge(providers.apiKey)}
                      onConfigureDeepSeekKey={configureDeepSeek}
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
                      signatures={signatures}
                    />
                  )}

                  {/*
                手机上运行时面板也是一张从右侧滑出来的卡片（CSS ≤640px）：
                打开时主对话向左让位，不再铺一层黑遮罩盖住它。
              */}
                  <div className={panelOpen ? 'runtime-drawer open' : 'runtime-drawer'}>
                    {panelOpen || narrow ? (
                      <LazyPanel
                        load={loadRuntimePanel}
                        label="运行时内容"
                        panelProps={{
                          onOpenDetail: handleOpenDetail,
                          budgetDrafts: budgetDraftOwnerRef.current.store,
                          open: panelOpen,
                          focusOnOpen: narrow,
                          onClose: closeRuntime,
                          onRegisterFlush: registerRuntimeFlush,
                          scene: scene,
                          instances: instances,
                          memories: session.memories,
                          conversations: session.conversations,
                          activeConversationId: conversation?.id ?? null,
                          personas: session.personas,
                          personaId: conversation?.personaId ?? null,
                          playerName: conversation?.playerName ?? world?.playerName ?? '',
                          chapters: session.chapters,
                          attachedWorldBooks: session.worldBooks,
                          libraryCards: session.library.cards,
                          worldCards: session.cards,
                          prompt: currentPrompt?.prompt ?? null,
                          promptSourceLabel: currentPrompt?.label,
                          promptPreparedAt: currentPrompt?.preparedAt,
                          pending: worker.pending,
                          extraCalls: extraCalls(usage.world),
                          usage: { world: usage.world, conversation: usage.conversation, latestTurn: usage.latestTurn },
                          usageError: usage.error ?? null,
                          onRetryUsage: usage.reload,
                          budget: budget,
                          budgetLimits: world?.budget ?? null,
                          worldId: world?.id ?? null,
                          onSaveBudget: async (limits) => {
                            if (!world) throw new Error('没有当前世界，预算未保存。');
                            await session.setBudget(limits, {
                              roomId: world.id,
                              expectedVersion: budgetWriteVersion(world.budget),
                            });
                          },
                          conversationTitle: conversation?.title ?? '',
                          workerError: worker.lastError,
                          failedTasks: worker.failed,
                          onRetryFailed: () => void worker.retryFailed(),
                          disabled: disabled,
                          onSceneChange: handleSceneSave,
                          onStartNewScene: async (title) => {
                            const result = await handleStartNewScene({ title, location: '', worldTime: '' });
                            if (result.status !== 'complete') throw new Error(result.message);
                          },
                          onSetPresence: (id, presence) => session.setPresence(id, presence),
                          onSelectPersona: (persona) => session.setPersona(persona),
                          onRenameInstance: (id, name) => session.updateInstance(id, { displayName: name }),
                          onRemoveInstance: (id) => session.removeInstance(id),
                          onAddInstance: async (card) => {
                            await session.addInstance(card);
                          },
                          onDetachWorldBook: (id) => session.detachWorldBook(id),
                          onUpdateMemory: (id, patch) => void session.updateMemory(id, patch),
                          onDeleteMemory: (id) => void session.deleteMemory(id),
                          onLocateMemory: handleLocateMemory,
                        }}
                      />
                    ) : null}
                  </div>
                </div>
              )}

              {!isSide && world !== null && conversation !== null ? (
                <CastRail
                  instances={instances}
                  scene={scene}
                  cards={session.library.cards}
                  disabled={disabled}
                  onOpenDetail={handleOpenDetail}
                  availableCards={availableCards}
                  onAddInstance={handleAddInstance}
                />
              ) : null}
            </LibraryWorkspace>
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

          {keySetup.open ? (
            <DeepSeekKeyDialog
              providers={providers}
              onClose={keySetup.dismiss}
              returnFocus={dialogReturnFocus.current}
              onRecover={() => {
                keySetup.requestOpen();
                openSettings('model');
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
              defaultCardIds={
                newConversationMode.kind === 'new-world' ? [] : instances.map((instance) => instance.cardId)
              }
              attachedBookIds={newConversationMode.kind === 'new-world' ? [] : (world?.worldBookIds ?? [])}
              disabled={disabled}
              onClose={() => setNewConversationMode(null)}
              onSubmit={async (input) => {
                if (!(await navigateCreated(() => handleNewConversation(input))))
                  throw new Error('对话尚未创建，请核对提示后重试。');
              }}
            />
          ) : null}

          {sceneOpen ? (
            <SceneDialog
              key={JSON.stringify([world?.id, conversation?.id])}
              scene={scene}
              instances={instances}
              disabled={disabled}
              onClose={() => setSceneOpen(false)}
              onSave={handleSceneSave}
              onStartNewScene={(input) => handleStartNewScene(input)}
            />
          ) : null}

          {detail === null ? null : (
            <CastDetail
              key={JSON.stringify([detail.roomId, detail.id])}
              instance={detail}
              card={session.library.cards.find((card) => card.id === detail.cardId) ?? null}
              memories={session.memories}
              disabled={disabled}
              onClose={() => setDetailId(null)}
              onRename={(id, name) => session.updateInstance(id, { displayName: name })}
              onSetPresence={(id, presence) => session.setPresence(id, presence)}
              onSetRelationship={(id, field, value) => session.setRelationship(id, field, value)}
              onRemove={async (id) => {
                await session.removeInstance(id);
                setDetailId((current) => (current === id ? null : current));
              }}
              onRevertChange={(id, changeId) => session.revertAffectChange(id, changeId)}
            />
          )}

          {accountOpen ? (
            <DialogShell
              label="账户"
              className="account-dialog"
              returnFocus={dialogReturnFocus.current}
              onClose={() => setAccountOpen(false)}
            >
              <LazyPanel load={loadAccountDialog} label="账户" panelProps={{ sync, disabled }} />
            </DialogShell>
          ) : null}

          {settingsCategory === null ? null : (
            <DialogShell
              label="设置"
              className="settings-dialog"
              returnFocus={dialogReturnFocus.current}
              onClose={() => setSettingsCategory(null)}
            >
              <LazyPanel
                load={loadSettingsDialog}
                label="设置"
                panelProps={{
                  category: settingsCategory,
                  worldTitle: world?.title ?? null,
                  onCategoryChange: setSettingsCategory,
                  providers,
                  appearance,
                  archivedConversations: session.archivedConversations,
                  activeConversationId: conversation?.id ?? null,
                  disabled,
                  onOpenArchived: (id: ConversationId) => {
                    // Close the settings focus trap before a possible library discard dialog.
                    setSettingsCategory(null);
                    requestAnimationFrame(() => {
                      void openConversation(id);
                    });
                  },
                  onDeleteArchived: (target: Conversation) => session.deleteArchivedConversation(target.id),
                  onExportArchive: () => (world === null ? Promise.resolve(null) : archive.exportWorld(world.id)),
                  onImportArchive: async () => {
                    setSettingsCategory(null);
                    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                    return navigateImported(archive.importArchive);
                  },
                  onExportTranscript: (id: ConversationId) =>
                    archive.exportTranscript(session.bundleOf(id), world?.title ?? ''),
                  storage,
                  backendKind: boot?.backendKind ?? '',
                }}
              />
            </DialogShell>
          )}
        </div>
      </LibraryWorkspaceProvider>
    </ChatDraftProvider>
  );
}
