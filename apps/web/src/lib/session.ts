import {
  type ArchiveReport,
  conversationId as asConversationId,
  roomId as asRoomId,
  type BudgetLimits,
  buildCardMemoryAttachment,
  type Card,
  type CardId,
  type ChapterSummary,
  type CharacterInstance,
  type Conversation,
  type ConversationId,
  createGreetingMessage,
  createPersona,
  defaultTravelCast,
  type EventId,
  type InstanceId,
  META_KEYS,
  type MemoryEvent,
  type Message,
  type MessageId,
  newId,
  nowIso,
  type Persona,
  type Presence,
  planNewConversation,
  type Room,
  type RoomId,
  type RoomSnapshot,
  type RoomSummary,
  revertAffectForTurn,
  type Scene,
  syncPresenceForScene,
  type WorldBook,
  type WorldBookId,
} from '@dramatis/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type DramatisDb, openDramatisDb } from './db';
import { createInstanceFor, createSceneFor } from './world';

export interface BootReport {
  backendKind: string;
  degraded: boolean;
  recoveredTasks: number;
  migrationsApplied: number;
}

/** 一条对话的只读素材包：导出正文、抓原句都用它。 */
export interface ConversationBundle {
  conversation: Conversation;
  scenes: Scene[];
  messages: Message[];
  instances: CharacterInstance[];
}

/**
 * 打开数据库（ROADMAP P0-1 / P0-2）。
 *
 * IndexedDB 在隐私模式或部分企业策略下不可用。这种情况下退回内存实现，
 * 让应用还能用，但必须把「本次数据不会保存」明确告诉用户，
 * 而不是静默地让他以为一切正常。
 */
export function useDatabase(): {
  db: DramatisDb | null;
  boot: BootReport | null;
  error: string | null;
} {
  const [db, setDb] = useState<DramatisDb | null>(null);
  const [boot, setBoot] = useState<BootReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const opened = await openDramatisDb();
        if (cancelled) return;

        const migration = await opened.repository.migrate();
        const recoveredTasks = await opened.queue.recoverInterrupted();

        setDb(opened);
        setBoot({
          backendKind: opened.backendKind,
          degraded: opened.backendKind === 'memory',
          recoveredTasks,
          migrationsApplied: migration.applied.length,
        });
      } catch (openError) {
        if (!cancelled) {
          setError(openError instanceof Error ? openError.message : String(openError));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { db, boot, error };
}

export interface StartConversationInput {
  title: string;
  /** 这条线开始时投入的角色卡；已有实例的卡不会被重复派生。 */
  cards: Card[];
  worldBookIds?: WorldBookId[];
  sceneTitle?: string;
  sceneSummary?: string;
  location?: string;
  worldTime?: string;
}

/** 界面如实说明新对话从原对话带了什么、丢了什么（顺序 27b 第二步）。 */
export interface ConversationAttachmentReport {
  cardId: CardId;
  cardName: string;
  sourceConversationId: ConversationId;
  sourceConversationTitle: string;
  impressions: number;
  chapters: number;
  dropped: { impressions: number; chapters: number };
}

export interface StartConversationResult {
  conversation: Conversation;
  attachments: ConversationAttachmentReport[];
}

export interface SessionApi {
  ready: boolean;
  error: string | null;
  clearError: () => void;

  /** 世界列表（左栏中部）。 */
  worlds: RoomSummary[];
  world: Room | null;
  /** 当前世界的对话，已归档的单独一份。 */
  conversations: Conversation[];
  archivedConversations: Conversation[];
  /** 当前打开的对话。 */
  conversation: Conversation | null;
  scene: Scene | null;
  /** 当前对话的消息；副对话用它渲染管理员工作流。 */
  messages: Message[];
  instances: CharacterInstance[];
  cards: Card[];
  worldBooks: WorldBook[];
  memories: MemoryEvent[];
  /** 已滚成章节的前情（P1-5），按时间正序。 */
  chapters: ChapterSummary[];
  personas: Persona[];
  library: { cards: Card[]; worldBooks: WorldBook[] };

  openWorld: (id: RoomId) => Promise<void>;
  createWorld: (input: {
    title: string;
    persona: Persona | null;
    cards: Card[];
    worldBookIds?: WorldBookId[];
  }) => Promise<RoomId | null>;
  deleteWorld: (id: RoomId) => Promise<void>;
  renameWorld: (title: string) => Promise<void>;
  /**
   * 设置本局的调用预算（P1-9 熔断）。
   *
   * 存在世界（房间）上：花销是按世界算的，一条线跑疯了不该牵连另一个世界。
   */
  setBudget: (limits: BudgetLimits | null) => Promise<void>;

  openConversation: (id: ConversationId) => Promise<void>;
  /**
   * 这条记忆是哪条对话里的哪一句（T11「点回当时的对话」）。
   *
   * 记忆里存的是 `sourceTurnIds`，而界面要的是「哪条对话 + 哪条消息」：
   * 前者只有内核认识，后者才能拿来切对话、滚动、高亮。找不到就返回 null
   * （原句被删过），界面负责说人话而不是静默什么都不做。
   */
  locateTurn: (turnId: string) => { conversationId: ConversationId; messageId: MessageId } | null;
  /**
   * 一条对话的完整素材（T12 导出归档对话的正文）。
   *
   * 已归档的对话不在主列表里，但它的消息仍然在快照里——导出正文要的正是
   * 「这条线当时到底聊了什么」，所以这里按 conversationId 取一份只读的打包。
   */
  bundleOf: (id: ConversationId) => ConversationBundle | null;
  startConversation: (input: StartConversationInput) => Promise<StartConversationResult | null>;
  /** 打开（或新建）这个世界的副对话。 */
  openSideConversation: () => Promise<Conversation | null>;
  updateConversation: (patch: Partial<Conversation>) => Promise<void>;
  archiveConversation: (id: ConversationId) => Promise<ArchiveReport | null>;
  deleteConversation: (id: ConversationId) => Promise<void>;

  addInstance: (card: Card) => Promise<CharacterInstance | null>;
  removeInstance: (id: InstanceId) => Promise<void>;
  updateInstance: (id: InstanceId, patch: Partial<CharacterInstance>) => Promise<void>;
  setPresence: (id: InstanceId, presence: Presence) => Promise<void>;

  /** 结束当前场景并开一个新的；返回新场景，便于接着写换场旁白。 */
  startNewScene: (input: {
    title: string;
    location?: string;
    worldTime?: string;
    summary?: string;
    /**
     * 这次带谁走（T17）。
     * 留空时按「此刻在场上的人」默认，界面上可以逐个取消勾选。
     */
    cast?: readonly InstanceId[];
  }) => Promise<Scene | null>;
  updateScene: (patch: Partial<Scene>) => Promise<void>;
  /**
   * 在世界层面设置当前场景，作用于这个世界最近的主对话。
   *
   * 副对话自己没有场景线（管理员不参与剧情），所以它的 `set_scene` 工具
   * 必须落到主对话上——否则「设置当前场景」会写进一条没有场景的对话里，
   * 用户什么也看不到。
   */
  setWorldScene: (patch: Partial<Scene>) => Promise<Scene | null>;

  deleteMessage: (id: MessageId) => Promise<void>;
  updateMessage: (id: MessageId, patch: Partial<Message>) => Promise<Message | null>;
  /** 重新从存储载入当前世界；后台任务写入记忆后调用。 */
  reloadWorld: () => Promise<void>;
  /**
   * 把左栏的世界列表、素材库、当前世界的快照全部重读一遍。
   *
   * 同步（P2-6）写完库之后要调它：另一台设备推过来的世界不在当前状态里，
   * 只 reloadWorld 的话用户会以为"同步成功但什么都没来"。
   */
  refreshAll: () => Promise<void>;
  updateMemory: (id: EventId, patch: Partial<MemoryEvent>) => Promise<void>;
  deleteMemory: (id: EventId) => Promise<void>;
  markRecalled: (events: readonly MemoryEvent[], now: string) => Promise<void>;
  /**
   * 撤销一个回合的全部后台写入：记忆条目与情绪关系变化。
   *
   * 只删记忆是不够的——重抽五次而每次都叠加情绪，关系会单向漂移。
   */
  revertTurn: (turnId: string) => Promise<void>;
  /** 把一本世界书挂到当前世界。core 早就实现了匹配，这里补上入口。 */
  attachWorldBook: (book: WorldBook) => Promise<void>;
  /** 只解绑，不删库——世界书可能被别的世界共用。 */
  detachWorldBook: (id: WorldBookId) => Promise<void>;
  saveCard: (card: Card) => Promise<void>;
  deleteCard: (id: CardId) => Promise<void>;
  saveWorldBook: (book: WorldBook) => Promise<void>;
  deleteWorldBook: (id: WorldBookId) => Promise<void>;
  /** 采纳 / 丢弃管理员起草的素材（副对话）。 */
  adoptArtifact: (messageId: MessageId, artifactId: string) => Promise<void>;
  discardArtifact: (messageId: MessageId, artifactId: string) => Promise<void>;
  /** 撤回一条已采纳的草稿（顺序 26）：删掉刚进素材库的那份，草稿退回「待采纳」。 */
  revokeArtifact: (messageId: MessageId, artifactId: string) => Promise<void>;
  /**
   * 切换这个世界使用的玩家身份（P0-3）。
   *
   * 刻意不叫 `usePersona`：以 `use` 开头的名字会被 lint 当成 React Hook，
   * 于是每次在事件回调里调用都会报「Hook 不能在非顶层调用」。
   */
  setPersona: (persona: Persona) => Promise<void>;
  savePersona: (persona: Persona) => Promise<void>;
  /** 删除身份；引用它的世界会退回内联字段，不会被连带删除。 */
  deletePersona: (id: string) => Promise<void>;
  listPersonas: () => Promise<Persona[]>;
  appendMessages: (messages: readonly Message[]) => Promise<void>;
}

export function useSession(db: DramatisDb | null): SessionApi {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [worlds, setWorlds] = useState<RoomSummary[]>([]);
  const [library, setLibrary] = useState<{ cards: Card[]; worldBooks: WorldBook[] }>({
    cards: [],
    worldBooks: [],
  });
  const [snapshot, setSnapshotState] = useState<RoomSnapshot | null>(null);

  // 用一个 ref 跟随快照，避免每个回调都依赖 snapshot 而频繁重建
  const snapshotRef = useRef<RoomSnapshot | null>(null);
  const setSnapshot = useCallback((next: RoomSnapshot | null) => {
    snapshotRef.current = next;
    setSnapshotState(next);
  }, []);

  const refreshWorlds = useCallback(async () => {
    if (!db) return;
    setWorlds(await db.repository.listRooms());
  }, [db]);

  const refreshLibrary = useCallback(async () => {
    if (!db) return;
    const [cards, worldBooks] = await Promise.all([db.repository.listCards(), db.repository.listWorldBooks()]);
    setLibrary({ cards, worldBooks });
  }, [db]);

  /**
   * 开一条新对话时，让场上的角色先开口。
   *
   * 卡从仓储层现取而不是从 React 状态取：刚导入的卡可能还没进 state，
   * 而开场白写不写得起取决于能不能拿到那张卡。
   */
  const buildGreetings = useCallback(
    async (room: Room, scene: Scene | null, instances: readonly CharacterInstance[]): Promise<Message[]> => {
      if (!db) return [];

      const greetings: Message[] = [];
      for (const instance of instances) {
        const card = await db.repository.getCard(instance.cardId);
        if (!card) continue;
        const greeting = createGreetingMessage({
          card,
          instance,
          room,
          scene,
          audience: scene?.cast ?? [instance.id],
        });
        if (greeting) greetings.push(greeting);
      }
      return greetings;
    },
    [db],
  );

  const reloadWorld = useCallback(async () => {
    const current = snapshotRef.current;
    if (!db || !current) return;
    const loaded = await db.repository.loadRoom(current.room.id);
    if (loaded) setSnapshot(loaded);
  }, [db, setSnapshot]);

  const refreshAll = useCallback(async () => {
    if (!db) return;
    await refreshWorlds();
    await refreshLibrary();
    await reloadWorld();
  }, [db, refreshLibrary, refreshWorlds, reloadWorld]);

  useEffect(() => {
    if (!db) return;
    let cancelled = false;

    void (async () => {
      try {
        const lastRoomId = await db.repository.getMeta<RoomId>(META_KEYS.lastRoomId);
        if (lastRoomId !== null) {
          const loaded = await db.repository.loadRoom(lastRoomId);
          if (loaded && !cancelled) setSnapshot(loaded);
        }
        await refreshWorlds();
        await refreshLibrary();
      } catch (sessionError) {
        if (!cancelled) {
          setError(sessionError instanceof Error ? sessionError.message : String(sessionError));
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [db, refreshLibrary, refreshWorlds, setSnapshot]);

  // 没有身份就先造一个，否则新世界无从创建
  useEffect(() => {
    if (!db || !ready) return;
    void (async () => {
      const list = await db.repository.listPersonas();
      if (list.length > 0) return;
      await db.repository.savePersona(createPersona({ name: '玩家' }));
      await reloadWorld();
    })();
  }, [db, ready, reloadWorld]);

  const openWorld = useCallback(
    async (id: RoomId) => {
      if (!db) return;
      const loaded = await db.repository.loadRoom(id);
      if (!loaded) {
        setError('这个世界已经不存在了');
        return;
      }
      setSnapshot(loaded);
      await db.repository.setMeta(META_KEYS.lastRoomId, id);
      await refreshWorlds();
    },
    [db, refreshWorlds, setSnapshot],
  );

  const createWorld = useCallback(
    async (input: {
      title: string;
      persona: Persona | null;
      cards: Card[];
      worldBookIds?: WorldBookId[];
    }): Promise<RoomId | null> => {
      if (!db) return null;
      const now = nowIso();
      const cards = input.cards;
      const persona = input.persona;

      const emptyRoom: Room = {
        id: asRoomId(newId()),
        title: input.title.trim() === '' ? '新世界' : input.title.trim(),
        personaId: persona?.id ?? null,
        playerName: persona?.name ?? '玩家',
        playerPersona: persona?.description ?? '',
        cardIds: [],
        instanceIds: [],
        worldBookIds: input.worldBookIds ?? [],
        activeConversationId: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };

      // 空白世界也要有一条对话线，否则用户进来看到的是一个无处落脚的壳
      const plan = planNewConversation({
        room: emptyRoom,
        existingInstances: [],
        title: '开场',
        cards,
        sceneTitle: '开场',
        sceneSummary: cards[0]?.scenario.trim() ?? '',
      });

      await db.repository.saveSnapshot({
        room: plan.room,
        conversations: [plan.conversation],
        scenes: [plan.scene],
        instances: plan.createdInstances,
        cards,
      });
      await db.repository.setMeta(META_KEYS.lastRoomId, plan.room.id);

      for (const greeting of await buildGreetings(plan.room, plan.scene, plan.createdInstances)) {
        await db.repository.appendMessages(plan.room.id, [greeting]);
      }

      const loaded = await db.repository.loadRoom(plan.room.id);
      setSnapshot(loaded);
      await refreshWorlds();
      await refreshLibrary();
      return plan.room.id;
    },
    [buildGreetings, db, refreshLibrary, refreshWorlds, setSnapshot],
  );

  const deleteWorld = useCallback(
    async (id: RoomId) => {
      if (!db) return;
      await db.repository.deleteRoom(id);

      const current = snapshotRef.current;
      if (current?.room.id === id) {
        setSnapshot(null);
        await db.repository.setMeta(META_KEYS.lastRoomId, null);
      }
      await refreshWorlds();
    },
    [db, refreshWorlds, setSnapshot],
  );

  const renameWorld = useCallback(
    async (title: string) => {
      const current = snapshotRef.current;
      if (!db || !current) return;

      const room = { ...current.room, title };
      await db.repository.saveRoom(room);
      setSnapshot({ ...current, room });
      await refreshWorlds();
    },
    [db, refreshWorlds, setSnapshot],
  );

  const setBudget = useCallback(
    async (limits: BudgetLimits | null) => {
      const current = snapshotRef.current;
      if (!db || !current) return;

      const room = { ...current.room, budget: limits };
      await db.repository.saveRoom(room);
      setSnapshot({ ...current, room });
    },
    [db, setSnapshot],
  );

  const openConversation = useCallback(
    async (id: ConversationId) => {
      const current = snapshotRef.current;
      if (!db || !current) return;
      if (current.room.activeConversationId === id) return;

      const room: Room = { ...current.room, activeConversationId: id, updatedAt: nowIso() };
      await db.repository.saveRoom(room);

      // 换了对话就换了一条场景线，存在状态要跟着对齐（T10）：
      // 否则会出现「右栏说在场、这条线的名单里却没有他」的角色
      const target = current.conversations.find((item) => item.id === id) ?? null;
      const scene = current.scenes.find((item) => item.id === target?.activeSceneId) ?? null;
      const synced = scene === null ? [] : syncPresenceForScene(current.instances, scene);
      for (const instance of synced) await db.repository.saveInstance(instance);

      setSnapshot({
        ...current,
        room,
        instances: current.instances.map((item) => synced.find((next) => next.id === item.id) ?? item),
      });
    },
    [db, setSnapshot],
  );

  const startConversation = useCallback(
    async (input: StartConversationInput): Promise<StartConversationResult | null> => {
      const current = snapshotRef.current;
      if (!db || !current) return null;

      const sourceConversation =
        current.conversations.find((item) => item.id === current.room.activeConversationId) ?? null;
      const extraKeywords = [
        ...new Set([current.room.playerName, ...current.instances.map((instance) => instance.displayName)]),
      ].filter((word) => word.trim() !== '');
      const attachments: ConversationAttachmentReport[] = [];
      const cards = input.cards.map((card) => {
        if (sourceConversation === null) return card;

        const instance = current.instances.find((item) => item.cardId === card.id) ?? null;
        const built = buildCardMemoryAttachment({
          card,
          sourceConversation: { id: sourceConversation.id, title: sourceConversation.title },
          instance,
          chapters: current.chapters,
          memories: current.memories,
          extraKeywords,
        });
        if (built === null) return card;

        attachments.push({
          cardId: card.id,
          cardName: card.name,
          sourceConversationId: sourceConversation.id,
          sourceConversationTitle: sourceConversation.title,
          impressions: built.attachment.stats.impressions,
          chapters: built.attachment.stats.chapters,
          dropped: {
            impressions: built.attachment.stats.dropped.memories,
            chapters: built.attachment.stats.dropped.timeline,
          },
        });
        return built.card;
      });

      const plan = planNewConversation({
        room: current.room,
        existingInstances: current.instances,
        title: input.title,
        cards,
        sceneTitle: input.sceneTitle,
        sceneSummary: input.sceneSummary,
        location: input.location,
        worldTime: input.worldTime,
      });

      const worldBookIds = [...new Set([...plan.room.worldBookIds, ...(input.worldBookIds ?? [])])];
      const room: Room = { ...plan.room, worldBookIds, updatedAt: nowIso() };

      await db.repository.saveSnapshot({
        room,
        conversations: [plan.conversation],
        scenes: [plan.scene],
        instances: plan.createdInstances,
        cards,
      });
      await db.repository.setMeta(META_KEYS.lastRoomId, room.id);

      // 新对话只带一部分人上台，其余人应当转为「在幕后」：
      // 名单是权威，presence 跟着名单走（T10）
      for (const instance of syncPresenceForScene([...current.instances, ...plan.createdInstances], plan.scene)) {
        await db.repository.saveInstance(instance);
      }

      // 开幕由场上的角色开场：新对话是一片空白的白纸，什么都不摆会更让人无措
      const openingCast = [...current.instances, ...plan.createdInstances].filter((instance) =>
        plan.scene.cast.includes(instance.id),
      );
      const greetings = await buildGreetings(room, plan.scene, openingCast);
      for (const greeting of greetings) {
        await db.repository.appendMessages(room.id, [greeting]);
      }

      const loaded = await db.repository.loadRoom(room.id);
      setSnapshot(loaded);
      await refreshWorlds();
      await refreshLibrary();
      return { conversation: plan.conversation, attachments };
    },
    [buildGreetings, db, refreshLibrary, refreshWorlds, setSnapshot],
  );

  const openSideConversation = useCallback(async (): Promise<Conversation | null> => {
    const current = snapshotRef.current;
    if (!db || !current) return null;

    const existing = current.conversations.find((item) => item.kind === 'side' && item.archivedAt === null);
    if (existing) {
      await openConversation(existing.id);
      return existing;
    }

    const now = nowIso();
    const conversation: Conversation = {
      id: asConversationId(newId()),
      roomId: current.room.id,
      kind: 'side',
      title: '世界管理',
      activeSceneId: null,
      modes: { playerFirst: false, silent: false },
      archivedAt: null,
      stateSnapshot: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const room: Room = { ...current.room, activeConversationId: conversation.id, updatedAt: now };

    await db.repository.saveConversation(conversation);
    await db.repository.saveRoom(room);
    setSnapshot({ ...current, room, conversations: [...current.conversations, conversation] });
    return conversation;
  }, [db, openConversation, setSnapshot]);

  const updateConversation = useCallback(
    async (patch: Partial<Conversation>) => {
      const current = snapshotRef.current;
      if (!db || !current) return;
      const target = current.conversations.find((item) => item.id === current.room.activeConversationId);
      if (!target) return;

      const next: Conversation = { ...target, ...patch, id: target.id, roomId: target.roomId, updatedAt: nowIso() };
      await db.repository.saveConversation(next);
      setSnapshot({
        ...current,
        conversations: current.conversations.map((item) => (item.id === next.id ? next : item)),
      });
    },
    [db, setSnapshot],
  );

  const archiveConversation = useCallback(
    async (id: ConversationId): Promise<ArchiveReport | null> => {
      const current = snapshotRef.current;
      if (!db || !current) return null;

      const report = await db.repository.archiveConversation(id);
      const loaded = await db.repository.loadRoom(current.room.id);
      if (loaded) setSnapshot(loaded);
      await refreshWorlds();
      return report;
    },
    [db, refreshWorlds, setSnapshot],
  );

  const deleteConversation = useCallback(
    async (id: ConversationId) => {
      const current = snapshotRef.current;
      if (!db || !current) return;

      await db.repository.deleteConversation(id);
      const loaded = await db.repository.loadRoom(current.room.id);
      if (loaded) setSnapshot(loaded);
      await refreshWorlds();
    },
    [db, refreshWorlds, setSnapshot],
  );

  const appendMessages = useCallback(
    async (messages: readonly Message[]) => {
      const current = snapshotRef.current;
      if (!db || !current || messages.length === 0) return;

      const stamped = await db.repository.appendMessages(current.room.id, messages);
      setSnapshot({ ...current, messages: [...current.messages, ...stamped] });
      await refreshWorlds();
    },
    [db, refreshWorlds, setSnapshot],
  );

  const updateMessage = useCallback(
    async (id: MessageId, patch: Partial<Message>): Promise<Message | null> => {
      const current = snapshotRef.current;
      if (!db || !current) return null;
      const updated = await db.repository.updateMessage(id, patch);
      if (!updated) return null;
      setSnapshot({
        ...current,
        messages: current.messages.map((message) => (message.id === id ? updated : message)),
      });
      return updated;
    },
    [db, setSnapshot],
  );

  const updateScene = useCallback(
    async (patch: Partial<Scene>) => {
      const current = snapshotRef.current;
      if (!db || !current) return;

      const conversation = current.conversations.find((item) => item.id === current.room.activeConversationId);
      const scene = current.scenes.find((item) => item.id === conversation?.activeSceneId);
      if (!scene) return;

      const next: Scene = { ...scene, ...patch, id: scene.id, roomId: scene.roomId };
      await db.repository.saveScene(next);
      setSnapshot({
        ...current,
        scenes: current.scenes.map((item) => (item.id === next.id ? next : item)),
      });
    },
    [db, setSnapshot],
  );

  const setWorldScene = useCallback(
    async (patch: Partial<Scene>): Promise<Scene | null> => {
      const current = snapshotRef.current;
      if (!db || !current) return null;

      const mains = current.conversations
        .filter((item) => item.kind === 'main' && item.archivedAt === null)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const target =
        current.conversations.find((item) => item.id === current.room.activeConversationId && item.kind === 'main') ??
        mains[0] ??
        null;
      if (!target) return null;

      const existing = current.scenes.find((item) => item.id === target.activeSceneId) ?? null;
      const now = nowIso();

      // 主对话还没有场景时顺手开一个：管理员说「把地点设成酒馆」，
      // 用户应该马上看到场景存在，而不是收到一句「没有场景可改」
      const next: Scene =
        existing === null
          ? createSceneFor(
              current.room.id,
              target.id,
              target.stateSnapshot.map((item) => item.instanceId),
              {
                title: patch.title ?? '开场',
                summary: patch.summary ?? '',
                location: patch.location ?? '',
                worldTime: patch.worldTime ?? '',
              },
            )
          : {
              ...existing,
              ...patch,
              id: existing.id,
              roomId: existing.roomId,
              conversationId: existing.conversationId,
            };

      await db.repository.saveScene(next);
      if (existing === null) {
        await db.repository.saveConversation({ ...target, activeSceneId: next.id, updatedAt: now });
      }

      setSnapshot({
        ...current,
        scenes:
          existing === null
            ? [...current.scenes, next]
            : current.scenes.map((item) => (item.id === next.id ? next : item)),
        conversations:
          existing === null
            ? current.conversations.map((item) => (item.id === target.id ? { ...item, activeSceneId: next.id } : item))
            : current.conversations,
      });
      return next;
    },
    [db, setSnapshot],
  );

  const startNewScene = useCallback(
    async (input: {
      title: string;
      location?: string;
      worldTime?: string;
      summary?: string;
      cast?: readonly InstanceId[];
    }): Promise<Scene | null> => {
      const current = snapshotRef.current;
      if (!db || !current) return null;

      const active = current.conversations.find((item) => item.id === current.room.activeConversationId);
      if (!active) return null;

      const previous = current.scenes.find((item) => item.id === active.activeSceneId) ?? null;
      // 默认带走此刻在场上的人；调用方（换场对话框）可以逐个取消
      const cast = [...(input.cast ?? defaultTravelCast(previous, current.instances))];

      const now = nowIso();
      const nextScene = createSceneFor(current.room.id, active.id, cast, {
        title: input.title,
        // 没填的地点与时间沿用上一场：换场通常只是换一段剧情，不是换掉整个世界
        summary: input.summary ?? previous?.summary ?? '',
        location: (input.location ?? '').trim() === '' ? (previous?.location ?? '') : (input.location ?? ''),
        worldTime: (input.worldTime ?? '').trim() === '' ? (previous?.worldTime ?? '') : (input.worldTime ?? ''),
      });
      const closedScene: Scene | null = previous ? { ...previous, endedAt: now } : null;
      const conversation: Conversation = { ...active, activeSceneId: nextScene.id, updatedAt: now };

      if (closedScene) await db.repository.saveScene(closedScene);
      await db.repository.saveScene(nextScene);
      await db.repository.saveConversation(conversation);

      // 留下的人转「在幕后」：名单是权威，presence 跟着名单走（T10）
      const synced = syncPresenceForScene(current.instances, nextScene, now);
      for (const instance of synced) await db.repository.saveInstance(instance);

      setSnapshot({
        ...current,
        scenes: [
          ...current.scenes.map((scene) => (closedScene && scene.id === closedScene.id ? closedScene : scene)),
          nextScene,
        ],
        conversations: current.conversations.map((item) => (item.id === conversation.id ? conversation : item)),
        instances: current.instances.map((item) => synced.find((next) => next.id === item.id) ?? item),
      });
      return nextScene;
    },
    [db, setSnapshot],
  );

  const addInstance = useCallback(
    async (card: Card): Promise<CharacterInstance | null> => {
      const current = snapshotRef.current;
      if (!db || !current) return null;

      // 世界里已经有过这个角色的实例就复用：同一个角色在世界里只应该存在一份
      const existing = current.instances.find((instance) => instance.cardId === card.id) ?? null;
      const instance = existing ?? createInstanceFor(card, current.room.id);

      const room: Room = {
        ...current.room,
        cardIds: current.room.cardIds.includes(card.id) ? current.room.cardIds : [...current.room.cardIds, card.id],
        instanceIds: current.room.instanceIds.includes(instance.id)
          ? current.room.instanceIds
          : [...current.room.instanceIds, instance.id],
        updatedAt: nowIso(),
      };

      const active = current.conversations.find((item) => item.id === room.activeConversationId);
      const activeScene = current.scenes.find((item) => item.id === active?.activeSceneId);
      let scenes = current.scenes;
      if (activeScene && !activeScene.cast.includes(instance.id)) {
        const nextScene: Scene = { ...activeScene, cast: [...activeScene.cast, instance.id] };
        await db.repository.saveScene(nextScene);
        scenes = current.scenes.map((scene) => (scene.id === nextScene.id ? nextScene : scene));
      }

      await db.repository.saveCard(card);
      if (!existing) await db.repository.saveInstance(instance);
      await db.repository.saveRoom(room);

      setSnapshot({
        ...current,
        room,
        scenes,
        instances: existing ? current.instances : [...current.instances, instance],
        cards: current.cards.some((item) => item.id === card.id) ? current.cards : [...current.cards, card],
      });
      await refreshWorlds();
      return instance;
    },
    [db, refreshWorlds, setSnapshot],
  );

  const removeInstance = useCallback(
    async (id: InstanceId) => {
      const current = snapshotRef.current;
      if (!db || !current) return;

      const room: Room = { ...current.room, instanceIds: current.room.instanceIds.filter((item) => item !== id) };
      let scenes = current.scenes;

      // 从所有场景的名单里摘掉，而不只是当前场景：
      // 否则回到旧场景时会出现指向已删除角色的悬空引用
      for (const scene of current.scenes) {
        if (!scene.cast.includes(id)) continue;
        const nextScene: Scene = { ...scene, cast: scene.cast.filter((item) => item !== id) };
        await db.repository.saveScene(nextScene);
        scenes = scenes.map((item) => (item.id === nextScene.id ? nextScene : item));
      }

      await db.repository.saveRoom(room);
      await db.repository.deleteInstance(id);

      setSnapshot({
        ...current,
        room,
        scenes,
        instances: current.instances.filter((item) => item.id !== id),
      });
      await refreshWorlds();
    },
    [db, refreshWorlds, setSnapshot],
  );

  const updateInstance = useCallback(
    async (id: InstanceId, patch: Partial<CharacterInstance>) => {
      const current = snapshotRef.current;
      if (!db || !current) return;
      const instance = current.instances.find((item) => item.id === id);
      if (!instance) return;

      const next: CharacterInstance = { ...instance, ...patch, updatedAt: nowIso() };
      await db.repository.saveInstance(next);
      setSnapshot({
        ...current,
        instances: current.instances.map((item) => (item.id === id ? next : item)),
      });
    },
    [db, setSnapshot],
  );

  const setPresence = useCallback(
    async (id: InstanceId, presence: Presence) => {
      const current = snapshotRef.current;
      if (!db || !current) return;
      const instance = current.instances.find((item) => item.id === id);
      if (!instance) return;

      const next: CharacterInstance = { ...instance, presence, updatedAt: nowIso() };
      await db.repository.saveInstance(next);

      const active = current.conversations.find((item) => item.id === current.room.activeConversationId);
      const activeScene = current.scenes.find((item) => item.id === active?.activeSceneId);
      let scenes = current.scenes;

      if (activeScene) {
        const shouldBeInCast = presence === 'onstage' || presence === 'muted';
        if (shouldBeInCast !== activeScene.cast.includes(id)) {
          const nextScene: Scene = {
            ...activeScene,
            cast: shouldBeInCast ? [...activeScene.cast, id] : activeScene.cast.filter((item) => item !== id),
          };
          await db.repository.saveScene(nextScene);
          scenes = current.scenes.map((scene) => (scene.id === nextScene.id ? nextScene : scene));
        }
      }

      setSnapshot({
        ...current,
        scenes,
        instances: current.instances.map((item) => (item.id === id ? next : item)),
      });
    },
    [db, setSnapshot],
  );

  const deleteMessage = useCallback(
    async (id: MessageId) => {
      const current = snapshotRef.current;
      if (!db || !current) return;
      await db.repository.deleteMessage(id);
      setSnapshot({ ...current, messages: current.messages.filter((message) => message.id !== id) });
      await refreshWorlds();
    },
    [db, refreshWorlds, setSnapshot],
  );

  const setPersona = useCallback(
    async (persona: Persona) => {
      const current = snapshotRef.current;
      if (!db || !current) return;
      const room: Room = {
        ...current.room,
        personaId: persona.id,
        playerName: persona.name,
        playerPersona: persona.description,
        updatedAt: nowIso(),
      };
      await db.repository.saveRoom(room);
      setSnapshot({ ...current, room });
    },
    [db, setSnapshot],
  );

  const savePersona = useCallback(
    async (persona: Persona) => {
      const current = snapshotRef.current;
      if (!db) return;
      await db.repository.savePersona(persona);
      if (!current) return;

      const personas = current.personas.some((item) => item.id === persona.id)
        ? current.personas.map((item) => (item.id === persona.id ? persona : item))
        : [...current.personas, persona];

      // 改了当前 persona 的名字或设定，世界上的冗余副本也要跟着走
      const room =
        current.room.personaId === persona.id
          ? { ...current.room, playerName: persona.name, playerPersona: persona.description }
          : current.room;

      setSnapshot({ ...current, personas, room });
    },
    [db, setSnapshot],
  );

  const listPersonas = useCallback(async (): Promise<Persona[]> => {
    return db ? db.repository.listPersonas() : [];
  }, [db]);

  const deletePersona = useCallback(
    async (id: string) => {
      const current = snapshotRef.current;
      if (!db) return;
      await db.repository.deletePersona(id);
      if (!current) return;

      const personas = current.personas.filter((persona) => persona.id !== id);
      const room = current.room.personaId === id ? { ...current.room, personaId: null } : current.room;
      setSnapshot({ ...current, personas, room });
    },
    [db, setSnapshot],
  );

  const revertTurn = useCallback(
    async (turnId: string) => {
      const current = snapshotRef.current;
      if (!db || !current) return;

      await db.repository.deleteMemoriesByTurn(current.room.id, turnId);

      const stored = await db.repository.listInstances(current.room.id);
      const reverted = stored.map((instance) => revertAffectForTurn(instance, turnId));
      for (let index = 0; index < reverted.length; index += 1) {
        if (reverted[index] !== stored[index]) {
          const next = reverted[index];
          if (next) await db.repository.saveInstance(next);
        }
      }

      setSnapshot({
        ...current,
        memories: current.memories.filter((memory) => !memory.sourceTurnIds.includes(turnId)),
        instances: current.instances.map((instance) => reverted.find((item) => item.id === instance.id) ?? instance),
      });
    },
    [db, setSnapshot],
  );

  const updateMemory = useCallback(
    async (id: EventId, patch: Partial<MemoryEvent>) => {
      const current = snapshotRef.current;
      if (!db || !current) return;
      const updated = await db.repository.updateMemory(id, patch);
      if (!updated) return;
      setSnapshot({
        ...current,
        memories: current.memories.map((memory) => (memory.id === id ? updated : memory)),
      });
    },
    [db, setSnapshot],
  );

  const deleteMemory = useCallback(
    async (id: EventId) => {
      const current = snapshotRef.current;
      if (!db || !current) return;
      await db.repository.deleteMemory(id);
      setSnapshot({ ...current, memories: current.memories.filter((memory) => memory.id !== id) });
    },
    [db, setSnapshot],
  );

  /** 被回想过的记忆累计次数，「越想越牢」参与后续评分。 */
  const markRecalled = useCallback(
    async (events: readonly MemoryEvent[], now: string) => {
      const current = snapshotRef.current;
      if (!db || !current || events.length === 0) return;

      /*
       * 只按 id 去改那两个字段，**不写整条**：`events` 是装配提示词时读到的旧拷贝，
       * 中间隔着一次模型调用——这期间记忆合并可能给它们盖了章。
       * （顺序 27a 的演练里实测过：写整条会把 20 条盖章抹成 9 条。）
       */
      const touched = await db.repository.markMemoriesRecalled(
        events.map((event) => event.id),
        now,
      );
      setSnapshot({
        ...current,
        memories: current.memories.map((memory) => touched.find((item) => item.id === memory.id) ?? memory),
      });
    },
    [db, setSnapshot],
  );

  const attachWorldBook = useCallback(
    async (book: WorldBook) => {
      const current = snapshotRef.current;
      if (!db || !current) return;

      await db.repository.saveWorldBook(book);
      await refreshLibrary();
      if (current.room.worldBookIds.includes(book.id)) return;

      const room: Room = {
        ...current.room,
        worldBookIds: [...current.room.worldBookIds, book.id],
        updatedAt: nowIso(),
      };
      await db.repository.saveRoom(room);
      setSnapshot({ ...current, room, worldBooks: [...current.worldBooks, book] });
    },
    [db, refreshLibrary, setSnapshot],
  );

  const detachWorldBook = useCallback(
    async (id: WorldBookId) => {
      const current = snapshotRef.current;
      if (!db || !current) return;

      const room: Room = {
        ...current.room,
        worldBookIds: current.room.worldBookIds.filter((item) => item !== id),
        updatedAt: nowIso(),
      };
      await db.repository.saveRoom(room);
      setSnapshot({ ...current, room, worldBooks: current.worldBooks.filter((book) => book.id !== id) });
    },
    [db, setSnapshot],
  );

  const saveCard = useCallback(
    async (card: Card) => {
      if (!db) return;
      await db.repository.saveCard(card);
      await refreshLibrary();

      // 世界快照里的卡也要跟着更新，否则界面上还是旧的
      const current = snapshotRef.current;
      if (current?.cards.some((item) => item.id === card.id)) {
        setSnapshot({
          ...current,
          cards: current.cards.map((item) => (item.id === card.id ? card : item)),
        });
      }
    },
    [db, refreshLibrary, setSnapshot],
  );

  const deleteCard = useCallback(
    async (id: CardId) => {
      if (!db) return;
      await db.repository.deleteCard(id);
      await refreshLibrary();
    },
    [db, refreshLibrary],
  );

  const saveWorldBook = useCallback(
    async (book: WorldBook) => {
      if (!db) return;
      await db.repository.saveWorldBook(book);
      await refreshLibrary();

      // 挂在这个世界上的世界书改了内容，prompt 里用的也得是新版本
      const current = snapshotRef.current;
      if (current?.worldBooks.some((item) => item.id === book.id)) {
        setSnapshot({
          ...current,
          worldBooks: current.worldBooks.map((item) => (item.id === book.id ? book : item)),
        });
      }
    },
    [db, refreshLibrary, setSnapshot],
  );

  const deleteWorldBook = useCallback(
    async (id: WorldBookId) => {
      const current = snapshotRef.current;
      if (!db || !current) return;

      await db.repository.deleteWorldBook(id);
      // 删书顺带解绑，否则世界上会留下指向不存在世界书的引用
      if (current.room.worldBookIds.includes(id)) {
        const room: Room = {
          ...current.room,
          worldBookIds: current.room.worldBookIds.filter((item) => item !== id),
          updatedAt: nowIso(),
        };
        await db.repository.saveRoom(room);
        setSnapshot({
          ...current,
          room,
          worldBooks: current.worldBooks.filter((book) => book.id !== id),
        });
      }
      await refreshLibrary();
    },
    [db, refreshLibrary, setSnapshot],
  );

  const adoptArtifact = useCallback(
    async (messageId: MessageId, artifactId: string) => {
      const current = snapshotRef.current;
      if (!db || !current) return;
      const result = await db.repository.adoptAdminArtifact(messageId, artifactId);
      if (!result) return;
      setSnapshot({
        ...current,
        messages: current.messages.map((message) => (message.id === messageId ? result.message : message)),
      });
      await refreshLibrary();
    },
    [db, refreshLibrary, setSnapshot],
  );

  const discardArtifact = useCallback(
    async (messageId: MessageId, artifactId: string) => {
      const current = snapshotRef.current;
      if (!db || !current) return;
      const updated = await db.repository.discardAdminArtifact(messageId, artifactId);
      if (!updated) return;
      setSnapshot({
        ...current,
        messages: current.messages.map((message) => (message.id === messageId ? updated : message)),
      });
    },
    [db, setSnapshot],
  );

  const revokeArtifact = useCallback(
    async (messageId: MessageId, artifactId: string) => {
      const current = snapshotRef.current;
      if (!db || !current) return;
      const result = await db.repository.revokeAdminArtifact(messageId, artifactId);
      if (!result) return;
      setSnapshot({
        ...current,
        messages: current.messages.map((message) => (message.id === messageId ? result.message : message)),
      });
      // 素材库跟着变（刚删掉的那份要消失）
      await refreshLibrary();
    },
    [db, refreshLibrary, setSnapshot],
  );

  const conversation =
    snapshot === null
      ? null
      : (snapshot.conversations.find((item) => item.id === snapshot.room.activeConversationId) ??
        snapshot.conversations.find((item) => item.archivedAt === null) ??
        null);

  /**
   * 记忆 → 原句（T11）。
   *
   * 只在快照里找，不额外查库：快照本来就是这个世界此刻的全部消息。
   * 同一个 turnId 会有多条消息（玩家那句 + 角色那句），取第一条即可——
   * 界面要的是「跳到这一段对话」，不是「跳到某个精确的字节」。
   */
  const locateTurn = useCallback((turnId: string): { conversationId: ConversationId; messageId: MessageId } | null => {
    const current = snapshotRef.current;
    if (current === null) return null;

    const hit = current.messages.find((message) => message.turnId === turnId && message.conversationId !== null);
    if (hit === undefined || hit.conversationId === null) return null;
    return { conversationId: hit.conversationId, messageId: hit.id };
  }, []);

  /** 一条对话的素材包（归档对话的正文导出用）。 */
  const bundleOf = useCallback((id: ConversationId): ConversationBundle | null => {
    const current = snapshotRef.current;
    if (current === null) return null;

    const target = current.conversations.find((item) => item.id === id);
    if (target === undefined) return null;

    return {
      conversation: target,
      scenes: current.scenes.filter((scene) => scene.conversationId === id),
      messages: current.messages.filter((message) => message.conversationId === id),
      instances: current.instances,
    };
  }, []);

  const scene =
    snapshot === null
      ? null
      : (snapshot.scenes.find((item) => item.id === conversation?.activeSceneId && item.endedAt === null) ??
        snapshot.scenes.find((item) => item.id === conversation?.activeSceneId) ??
        null);

  // 只渲染当前对话的消息：主对话与副对话是两条独立记录
  const messages =
    snapshot === null || conversation === null
      ? []
      : snapshot.messages.filter((message) => message.conversationId === conversation.id);

  return {
    ready,
    error,
    clearError: () => setError(null),
    worlds,
    world: snapshot?.room ?? null,
    conversations: snapshot === null ? [] : snapshot.conversations.filter((item) => item.archivedAt === null),
    archivedConversations: snapshot === null ? [] : snapshot.conversations.filter((item) => item.archivedAt !== null),
    conversation,
    scene,
    messages,
    instances: snapshot?.instances ?? [],
    cards: snapshot?.cards ?? [],
    worldBooks: snapshot?.worldBooks ?? [],
    memories: snapshot?.memories ?? [],
    // 只带当前对话的章节：跨对话的前情不该串味（副对话本来也没有章节）
    chapters:
      snapshot === null || conversation === null
        ? []
        : snapshot.chapters.filter((chapter) => chapter.conversationId === conversation.id),
    personas: snapshot?.personas ?? [],
    library,
    openWorld,
    createWorld,
    deleteWorld,
    renameWorld,
    setBudget,
    openConversation,
    locateTurn,
    bundleOf,
    startConversation,
    openSideConversation,
    updateConversation,
    archiveConversation,
    deleteConversation,
    addInstance,
    removeInstance,
    updateInstance,
    setPresence,
    startNewScene,
    updateScene,
    setWorldScene,
    deleteMessage,
    updateMessage,
    reloadWorld,
    refreshAll,
    updateMemory,
    deleteMemory,
    markRecalled,
    revertTurn,
    attachWorldBook,
    detachWorldBook,
    saveCard,
    deleteCard,
    saveWorldBook,
    deleteWorldBook,
    adoptArtifact,
    discardArtifact,
    revokeArtifact,
    setPersona,
    savePersona,
    deletePersona,
    listPersonas,
    appendMessages,
  };
}
