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
  createPersona,
  defaultTravelCast,
  type EventId,
  type InstanceId,
  isCompleteWorldBook,
  isModifiedWorldBookArtifact,
  META_KEYS,
  type MemoryEvent,
  type Message,
  type MessageId,
  newId,
  nowIso,
  type Persona,
  type Presence,
  planNewConversation,
  type RelationshipField,
  type Room,
  type RoomId,
  type RoomSnapshot,
  type RoomSummary,
  recoverInterruptedImports,
  reuseUnchangedCollections,
  reverseWorldBookDraft,
  revertAffectChange as revertAffectChangeForInstance,
  type Scene,
  setRelationshipField as setRelationshipFieldForInstance,
  syncPresenceForScene,
  type WorldBook,
  type WorldBookId,
  worldBookArtifactConflict,
} from '@dramatis/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type DramatisDb, openDramatisDb, pendingAccountDeletionCount } from './db';
import { type DeletionFeedback, deleteWithFeedback } from './deletion-feedback';
import { revertTurnWrites, rewriteTurnWrites } from './turn-write';
import { createInstanceFor, createSceneFor } from './world';

export interface ImportRecoveryWarning {
  code: string;
  message: string;
  markerId?: string;
}

/** Optional structured core result; counts remain the core's actual completed rollbacks. */
export function importRecoveryWarnings(result: { warnings?: unknown }): ImportRecoveryWarning[] {
  if (result.warnings === undefined) return [];
  if (!Array.isArray(result.warnings))
    return [
      {
        code: 'invalid-recovery-report',
        message: '导入恢复检查返回的信息不完整，请检查现有世界。',
      },
    ];
  return result.warnings.map((warning: unknown): ImportRecoveryWarning => {
    if (
      warning === null ||
      typeof warning !== 'object' ||
      !('code' in warning) ||
      typeof warning.code !== 'string' ||
      !('message' in warning) ||
      typeof warning.message !== 'string'
    )
      return {
        code: 'invalid-recovery-report',
        message: '导入恢复检查返回的信息不完整，请检查现有世界。',
      };
    return {
      code: warning.code,
      message: warning.message,
      ...('markerId' in warning && typeof warning.markerId === 'string' ? { markerId: warning.markerId } : {}),
    };
  });
}

export interface BootReport {
  backendKind: string;
  degraded: boolean;
  recoveredTasks: number;
  /** Core-reported completed rollbacks; skipped or failed markers are never included. */
  recoveredImports: number;
  importRecoveryWarnings: ImportRecoveryWarning[];
  migrationsApplied: number;
  pendingAccountDeletions: number;
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
        /*
         * 上次导入崩在半路（页面被关、崩溃）：把那半个世界撤掉（审计 C7）。
         * 太新的标记不动——可能另一个标签页正在导入，撤掉等于删掉人家正在写的东西。
         */
        let recoveredImports = 0;
        let recoveryWarnings: ImportRecoveryWarning[] = [];
        try {
          const interrupted = await recoverInterruptedImports(opened.repository);
          recoveredImports = interrupted.rooms.length;
          // Current core has no warnings; consume only an actually returned structured field.
          recoveryWarnings = importRecoveryWarnings(interrupted as typeof interrupted & { warnings?: unknown });
          if (interrupted.rooms.length > 0 || interrupted.stillPending > 0) {
            console.warn(
              `[dramatis] 未完成的导入：撤掉 ${interrupted.rooms.length} 个世界，另有 ${interrupted.stillPending} 个标记还太新没动`,
            );
          }
        } catch {
          // The legacy recovery may already have modified storage before throwing. Do not retry or claim preservation.
          recoveryWarnings = [
            {
              code: 'import-recovery-failed',
              message: '导入恢复检查未完成。已继续加载可读取的本机数据，请检查现有世界和导入记录。',
            },
          ];
        }
        if (cancelled) return;

        setDb(opened);
        setBoot({
          backendKind: opened.backendKind,
          degraded: opened.backendKind === 'memory',
          recoveredTasks,
          recoveredImports,
          importRecoveryWarnings: recoveryWarnings,
          migrationsApplied: migration.applied.length,
          pendingAccountDeletions: pendingAccountDeletionCount(),
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
  /** 当前对话的全部场景（含已结束的），按开始时间正序；装配历史时判断场记覆盖要用（顺序 58）。 */
  scenes: Scene[];
  /** 当前对话的消息；副对话用它渲染管理员工作流。 */
  messages: Message[];
  instances: CharacterInstance[];
  cards: Card[];
  worldBooks: WorldBook[];
  memories: MemoryEvent[];
  /** 已滚成章节的前情（P1-5），按时间正序；界面只展示当前对话。 */
  chapters: ChapterSummary[];
  /** 世界内全部章节；跨对话记忆附件展开正文时要用。 */
  allChapters: ChapterSummary[];
  personas: Persona[];
  library: { cards: Card[]; worldBooks: WorldBook[] };

  openWorld: (id: RoomId) => Promise<void>;
  createWorld: (input: {
    title: string;
    persona: Persona | null;
    cards: Card[];
    worldBookIds?: WorldBookId[];
    conversationTitle?: string;
    sceneTitle?: string;
    location?: string;
    worldTime?: string;
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
  /**
   * 改**指定**对话的名字（可以不是当前这条）。
   *
   * 为什么单独来一个：`updateConversation` 只作用于当前对话，而手机端左栏的列表里
   * 要能直接给任意一条改名（用户 2026-09-24：删掉标题栏之后，改名搬到这里）。
   * 靠「先切换过去再改」会打断正在读的那条对话，不能接受。
   */
  renameConversation: (id: ConversationId, title: string) => Promise<void>;
  archiveConversation: (id: ConversationId) => Promise<ArchiveReport | null>;
  deleteConversation: (id: ConversationId) => Promise<void>;
  deleteArchivedConversation: (id: ConversationId) => Promise<DeletionFeedback>;

  addInstance: (card: Card) => Promise<CharacterInstance | null>;
  removeInstance: (id: InstanceId) => Promise<void>;
  updateInstance: (id: InstanceId, patch: Partial<CharacterInstance>) => Promise<void>;
  /**
   * 手动调整角色对玩家的关系维度（顺序 89：好感滑杆）。
   *
   * 走 core 的 `setRelationshipField`，所以值域夹紧与「状态变化的可撤销记录」
   * 与模型推演出来的变化完全同路；不受单轮上限约束。
   */
  setRelationship: (id: InstanceId, field: RelationshipField, value: number) => Promise<void>;
  /** 按一条状态历史 id 撤销影响；原记录保留，只追加反向量。 */
  revertAffectChange: (id: InstanceId, changeId: string) => Promise<void>;
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
  setWorldScene: (
    patch: Partial<Scene>,
    targetConversationId: ConversationId | undefined,
    expectedRoomId?: RoomId,
  ) => Promise<Scene | null>;

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
  /**
   * 顺序 77：原地改写一条回复，并把这一轮的写入（任务键、记忆、情绪）一起撤掉。
   *
   * 一个事务里落地（要么都成、要么都不成），界面状态在提交后对齐。返回 `null`
   * 表示这条回复已经不在库里。usage 记账与模型调用仍在调用方。
   */
  rewriteTurn: (input: { messageId: MessageId; patch: Partial<Message>; turnId: string }) => Promise<Message | null>;
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
  reverseArtifact: (messageId: MessageId, artifactId: string) => Promise<void>;
  /**
   * 切换**当前对话**使用的玩家身份，并把它同步为这个世界的默认值。
   *
   * 其它已有对话不会被连带改写；它们各自保留自己的 `personaId` 与身份快照。
   */
  setPersona: (persona: Persona) => Promise<void>;
  savePersona: (persona: Persona) => Promise<void>;
  /** 删除身份；引用它的世界会退回内联字段，不会被连带删除。 */
  deletePersona: (id: string) => Promise<void>;
  listPersonas: () => Promise<Persona[]>;
  appendMessages: (messages: readonly Message[]) => Promise<void>;
}

interface SnapshotScope {
  epoch: number;
  revision: number;
  roomId: RoomId | null;
}

type ConversationReadPolicy =
  | { kind: 'latest'; excludedConversationId?: ConversationId }
  | { kind: 'target'; id: ConversationId };

/** Apply only this write's changed fields to the latest entity. This is UI merging, not repository CAS. */
function mergeChangedFields<T extends object>(before: T, next: T, latest: T): T {
  const merged = { ...latest };
  for (const key of Object.keys(next) as (keyof T)[]) {
    if (Object.is(before[key], next[key])) continue;
    const oldValue = before[key];
    const nextValue = next[key];
    const latestValue = latest[key];
    // Room references and scene casts are sets: preserve unrelated additions while applying this write's delta.
    if (
      Array.isArray(oldValue) &&
      Array.isArray(nextValue) &&
      Array.isArray(latestValue) &&
      [...oldValue, ...nextValue, ...latestValue].every((item) => typeof item === 'string')
    ) {
      const removed = new Set(oldValue.filter((item) => !nextValue.includes(item)));
      merged[key] = [
        ...new Set([
          ...latestValue.filter((item) => !removed.has(item)),
          ...nextValue.filter((item) => !oldValue.includes(item)),
        ]),
      ] as unknown as T[keyof T];
    } else {
      merged[key] = next[key];
    }
  }
  return merged;
}

function mergeChangedCollection<T extends { id: string }>(before: T[], next: T[] | undefined, latest: T[]): T[] {
  if (next === undefined || next === before) return latest;
  const previous = new Map(before.map((item) => [item.id, item]));
  const changes = new Map(next.map((item) => [item.id, item]));
  const merged = latest
    .filter((item) => !previous.has(item.id) || changes.has(item.id))
    .map((item) => {
      const old = previous.get(item.id);
      const changed = changes.get(item.id);
      return old && changed && changed !== old ? mergeChangedFields(old, changed, item) : item;
    });
  const visible = new Set(merged.map((item) => item.id));
  for (const item of next) {
    // A concurrently deleted entity stays deleted; only newly created entities are appended.
    if (!previous.has(item.id) && !visible.has(item.id)) {
      merged.push(item);
      visible.add(item.id);
    }
  }
  return merged;
}

export function useSession(db: DramatisDb | null): SessionApi {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [worlds, setWorlds] = useState<RoomSummary[]>([]);
  const [library, setLibrary] = useState<{ cards: Card[]; worldBooks: WorldBook[] }>({
    cards: [],
    worldBooks: [],
  });
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [snapshot, setSnapshotState] = useState<RoomSnapshot | null>(null);

  // 用一个 ref 跟随快照，避免每个回调都依赖 snapshot 而频繁重建
  const snapshotRef = useRef<RoomSnapshot | null>(null);
  // 仓储的 localSeq 是「读计数器 → 写消息 → 写计数器」；同一 session 内追加必须串行。
  const appendQueueRef = useRef<Promise<void>>(Promise.resolve());
  const selectionEpochRef = useRef(0);
  const snapshotRevisionRef = useRef(0);
  const lastRoomQueueRef = useRef<Promise<void>>(Promise.resolve());
  const captureScope = useCallback(
    (): SnapshotScope => ({
      epoch: selectionEpochRef.current,
      revision: snapshotRevisionRef.current,
      roomId: snapshotRef.current?.room.id ?? null,
    }),
    [],
  );
  const beginSelection = useCallback(
    (roomId: RoomId | null): SnapshotScope => ({
      epoch: ++selectionEpochRef.current,
      revision: snapshotRevisionRef.current,
      roomId,
    }),
    [],
  );
  const isScopeCurrent = useCallback(
    (scope: SnapshotScope, selection = false) =>
      scope.epoch === selectionEpochRef.current && (selection || snapshotRef.current?.room.id === scope.roomId),
    [],
  );
  const conditionalCommit = useCallback(
    (
      scope: SnapshotScope,
      update: (latest: RoomSnapshot | null) => RoomSnapshot | null,
      revision?: number,
      selection = false,
    ): boolean => {
      if (!isScopeCurrent(scope, selection) || (revision !== undefined && revision !== snapshotRevisionRef.current))
        return false;
      const next = update(snapshotRef.current);
      snapshotRef.current = next;
      snapshotRevisionRef.current += 1;
      setSnapshotState(next);
      return true;
    },
    [isScopeCurrent],
  );
  const readSnapshot = useCallback(
    async (
      scope: SnapshotScope,
      selection = false,
      retry = true,
      conversationPolicy?: ConversationReadPolicy,
    ): Promise<boolean> => {
      if (!db || scope.roomId === null) return false;
      while (isScopeCurrent(scope, selection)) {
        const revision = snapshotRevisionRef.current;
        const loaded = await db.repository.loadRoom(scope.roomId);
        if (!loaded || !isScopeCurrent(scope, selection)) return false;
        if (
          conditionalCommit(
            scope,
            (latest) => {
              if (latest?.room.id !== loaded.room.id) return loaded;
              const activeId =
                conversationPolicy?.kind === 'target'
                  ? conversationPolicy.id
                  : conversationPolicy?.kind === 'latest'
                    ? latest.room.activeConversationId === conversationPolicy.excludedConversationId
                      ? null
                      : latest.room.activeConversationId
                    : null;
              const activeStillExists = loaded.conversations.some(
                (item) => item.id === activeId && item.deletedAt === null,
              );
              // Explicit navigation keeps its requested target; ordinary mutations retain the latest committed choice.
              // Archived conversations remain valid for review; archiving this choice opts into the loaded replacement.
              // Default reads, including background reloads, use the loaded selection.
              const next = activeStillExists
                ? { ...loaded, room: { ...loaded.room, activeConversationId: activeId } }
                : loaded;
              return reuseUnchangedCollections(latest, next);
            },
            revision,
            selection,
          )
        )
          return true;
        // Persistence-completion reads retry; a background reload can discard a superseded read.
        if (!retry) return false;
      }
      return false;
    },
    [conditionalCommit, db, isScopeCurrent],
  );
  const commitPatch = useCallback(
    async (
      scope: SnapshotScope,
      before: RoomSnapshot,
      patch: Partial<RoomSnapshot>,
      targetConversationId?: ConversationId,
    ): Promise<boolean> => {
      if (!isScopeCurrent(scope)) return false;
      // A newer UI commit can represent a nested edit or a deletion absent from this old response.
      // Read the final persisted state instead of deriving additions/field changes from the stale response.
      if (scope.revision !== snapshotRevisionRef.current)
        return readSnapshot(
          scope,
          false,
          true,
          targetConversationId === undefined ? { kind: 'latest' } : { kind: 'target', id: targetConversationId },
        );
      return conditionalCommit(
        scope,
        (latest) =>
          latest === null
            ? null
            : {
                ...latest,
                room: patch.room ? mergeChangedFields(before.room, patch.room, latest.room) : latest.room,
                conversations: mergeChangedCollection(before.conversations, patch.conversations, latest.conversations),
                scenes: mergeChangedCollection(before.scenes, patch.scenes, latest.scenes),
                instances: mergeChangedCollection(before.instances, patch.instances, latest.instances),
                cards: mergeChangedCollection(before.cards, patch.cards, latest.cards),
                worldBooks: mergeChangedCollection(before.worldBooks, patch.worldBooks, latest.worldBooks),
                messages: mergeChangedCollection(before.messages, patch.messages, latest.messages),
                memories: mergeChangedCollection(before.memories, patch.memories, latest.memories),
                chapters: mergeChangedCollection(before.chapters, patch.chapters, latest.chapters),
                personas: mergeChangedCollection(before.personas, patch.personas, latest.personas),
              },
        scope.revision,
      );
    },
    [conditionalCommit, isScopeCurrent, readSnapshot],
  );
  const rememberRoom = useCallback(
    (scope: SnapshotScope): Promise<void> => {
      const task = lastRoomQueueRef.current.then(async () => {
        if (db && isScopeCurrent(scope, true)) await db.repository.setMeta(META_KEYS.lastRoomId, scope.roomId);
      });
      lastRoomQueueRef.current = task.catch(() => {});
      return task;
    },
    [db, isScopeCurrent],
  );

  const refreshWorlds = useCallback(async () => {
    if (!db) return;
    setWorlds(await db.repository.listRooms());
  }, [db]);

  const refreshLibrary = useCallback(async () => {
    if (!db) return;
    const [cards, worldBooks] = await Promise.all([db.repository.listCards(), db.repository.listWorldBooks()]);
    setLibrary({ cards, worldBooks });
  }, [db]);

  const refreshPersonas = useCallback(async () => {
    if (!db) return;
    setPersonas(await db.repository.listPersonas());
  }, [db]);

  const reloadWorld = useCallback(async () => {
    await readSnapshot(captureScope(), false, false);
  }, [captureScope, readSnapshot]);

  const refreshAll = useCallback(async () => {
    if (!db) return;
    const scope = captureScope();
    await refreshWorlds();
    await refreshLibrary();
    await refreshPersonas();
    await readSnapshot(scope, false, false);
  }, [captureScope, db, readSnapshot, refreshLibrary, refreshPersonas, refreshWorlds]);

  useEffect(() => {
    if (!db) return;
    let cancelled = false;
    const restoreScope = captureScope();
    const restoreRevision = snapshotRevisionRef.current;

    void (async () => {
      try {
        const lastRoomId = await db.repository.getMeta<RoomId>(META_KEYS.lastRoomId);
        if (lastRoomId !== null && !cancelled && isScopeCurrent(restoreScope, true)) {
          const loaded = await db.repository.loadRoom(lastRoomId);
          if (loaded && !cancelled)
            conditionalCommit({ ...restoreScope, roomId: lastRoomId }, () => loaded, restoreRevision, true);
        }
        await refreshWorlds();
        await refreshLibrary();
        await refreshPersonas();
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
  }, [captureScope, conditionalCommit, db, isScopeCurrent, refreshLibrary, refreshPersonas, refreshWorlds]);

  // 没有身份就先造一个，否则新世界无从创建
  useEffect(() => {
    if (!db || !ready) return;
    void (async () => {
      const list = await db.repository.listPersonas();
      if (list.length > 0) {
        setPersonas(list);
        return;
      }
      await db.repository.savePersona(createPersona({ name: '玩家' }));
      setPersonas(await db.repository.listPersonas());
      await reloadWorld();
    })();
  }, [db, ready, reloadWorld]);

  const openWorld = useCallback(
    async (id: RoomId) => {
      if (!db) return;
      const scope = beginSelection(id);
      if (!(await readSnapshot(scope, true))) {
        if (isScopeCurrent(scope, true)) setError('这个世界已经不存在了');
        return;
      }
      await rememberRoom(scope);
      await refreshWorlds();
    },
    [beginSelection, db, isScopeCurrent, readSnapshot, refreshWorlds, rememberRoom],
  );

  const createWorld = useCallback(
    async (input: {
      title: string;
      persona: Persona | null;
      cards: Card[];
      worldBookIds?: WorldBookId[];
      conversationTitle?: string;
      sceneTitle?: string;
      location?: string;
      worldTime?: string;
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
        title: input.conversationTitle?.trim() || '开场',
        cards,
        sceneTitle: input.sceneTitle?.trim() || '开场',
        // 顺序 90：卡上的「场景设定」已删，新对话的场景摘要留空由用户自己写
        sceneSummary: '',
        location: input.location ?? '',
        worldTime: input.worldTime ?? '',
      });

      const scope = beginSelection(plan.room.id);
      await db.repository.saveSnapshot({
        room: plan.room,
        conversations: [plan.conversation],
        scenes: [plan.scene],
        instances: plan.createdInstances,
        cards,
      });
      if (await readSnapshot(scope, true)) await rememberRoom(scope);
      await refreshWorlds();
      await refreshLibrary();
      return plan.room.id;
    },
    [beginSelection, db, readSnapshot, refreshLibrary, refreshWorlds, rememberRoom],
  );

  const deleteWorld = useCallback(
    async (id: RoomId) => {
      if (!db) return;
      const scope = captureScope();
      await db.repository.deleteRoom(id);

      if (scope.roomId === id && isScopeCurrent(scope)) {
        const cleared = beginSelection(null);
        conditionalCommit(cleared, () => null, undefined, true);
        await rememberRoom(cleared);
      }
      await refreshWorlds();
    },
    [beginSelection, captureScope, conditionalCommit, db, isScopeCurrent, refreshWorlds, rememberRoom],
  );

  const renameWorld = useCallback(
    async (title: string) => {
      const current = snapshotRef.current;
      const scope = captureScope();
      if (!db || !current) return;

      const room = { ...current.room, title };
      await db.repository.saveRoom(room);
      await commitPatch(scope, current, { room });
      await refreshWorlds();
    },
    [db, refreshWorlds, captureScope, commitPatch],
  );

  const setBudget = useCallback(
    async (limits: BudgetLimits | null) => {
      const current = snapshotRef.current;
      const scope = captureScope();
      if (!db || !current) return;

      const room = { ...current.room, budget: limits };
      await db.repository.saveRoom(room);
      await commitPatch(scope, current, { room });
    },
    [db, captureScope, commitPatch],
  );

  const openConversation = useCallback(
    async (id: ConversationId) => {
      const current = snapshotRef.current;
      if (!db || !current) return;
      // Re-selecting the visible conversation cancels a pending different choice and persists the last choice.
      const selection = beginSelection(current.room.id);

      const room: Room = { ...current.room, activeConversationId: id, updatedAt: nowIso() };
      await db.repository.saveRoom(room);

      // 换了对话就换了一条场景线，存在状态要跟着对齐（T10）：
      // 否则会出现「右栏说在场、这条线的名单里却没有他」的角色
      const target = current.conversations.find((item) => item.id === id) ?? null;
      const scene = current.scenes.find((item) => item.id === target?.activeSceneId) ?? null;
      const synced = scene === null ? [] : syncPresenceForScene(current.instances, scene);
      for (const instance of synced) await db.repository.saveInstance(instance);

      const committed = await commitPatch(
        selection,
        current,
        {
          room,
          instances: current.instances.map((item) => synced.find((next) => next.id === item.id) ?? item),
        },
        id,
      );
      if (committed) await rememberRoom(selection);
    },
    [beginSelection, commitPatch, db, rememberRoom],
  );

  const startConversation = useCallback(
    async (input: StartConversationInput): Promise<StartConversationResult | null> => {
      const current = snapshotRef.current;
      if (!db || !current) return null;

      const selection = beginSelection(current.room.id);
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
      await rememberRoom(selection);

      // 新对话只带一部分人上台，其余人应当转为「在幕后」：
      // 名单是权威，presence 跟着名单走（T10）
      for (const instance of syncPresenceForScene([...current.instances, ...plan.createdInstances], plan.scene)) {
        await db.repository.saveInstance(instance);
      }

      // 顺序 90：开场白已从卡上删掉，新对话不再自动生成角色开场消息

      await readSnapshot(selection, false, true, { kind: 'target', id: plan.conversation.id });
      await refreshWorlds();
      await refreshLibrary();
      return { conversation: plan.conversation, attachments };
    },
    [beginSelection, db, readSnapshot, refreshLibrary, refreshWorlds, rememberRoom],
  );

  const openSideConversation = useCallback(async (): Promise<Conversation | null> => {
    const current = snapshotRef.current;
    if (!db || !current) return null;

    const existing = current.conversations.find((item) => item.kind === 'side' && item.archivedAt === null);
    if (existing) {
      await openConversation(existing.id);
      return existing;
    }

    const selection = beginSelection(current.room.id);
    const now = nowIso();
    const conversation: Conversation = {
      id: asConversationId(newId()),
      roomId: current.room.id,
      kind: 'side',
      title: '世界管理',
      activeSceneId: null,
      modes: { playerFirst: false, silent: false },
      personaId: null,
      playerName: '玩家',
      playerPersona: '',
      archivedAt: null,
      stateSnapshot: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const room: Room = { ...current.room, activeConversationId: conversation.id, updatedAt: now };

    await db.repository.saveConversation(conversation);
    await db.repository.saveRoom(room);
    const committed = await commitPatch(
      selection,
      current,
      {
        room,
        conversations: [...current.conversations, conversation],
      },
      conversation.id,
    );
    if (committed) await rememberRoom(selection);
    return conversation;
  }, [beginSelection, commitPatch, db, openConversation, rememberRoom]);

  const updateConversation = useCallback(
    async (patch: Partial<Conversation>) => {
      const current = snapshotRef.current;
      const scope = captureScope();
      if (!db || !current) return;
      const target = current.conversations.find((item) => item.id === current.room.activeConversationId);
      if (!target) return;

      const next: Conversation = { ...target, ...patch, id: target.id, roomId: target.roomId, updatedAt: nowIso() };
      await db.repository.saveConversation(next);
      await commitPatch(scope, current, {
        conversations: current.conversations.map((item) => (item.id === next.id ? next : item)),
      });
    },
    [db, captureScope, commitPatch],
  );

  /** 按 id 改名（左栏列表用）：不动「当前是哪条对话」，所以不会打断对话。 */
  const renameConversation = useCallback(
    async (id: ConversationId, title: string) => {
      const current = snapshotRef.current;
      const scope = captureScope();
      if (!db || !current) return;
      const target = current.conversations.find((item) => item.id === id);
      if (!target) return;
      const next = title.trim();
      if (next === '' || next === target.title) return;

      const renamed: Conversation = { ...target, title: next, updatedAt: nowIso() };
      await db.repository.saveConversation(renamed);
      await commitPatch(scope, current, {
        conversations: current.conversations.map((item) => (item.id === renamed.id ? renamed : item)),
      });
    },
    [db, captureScope, commitPatch],
  );

  const archiveConversation = useCallback(
    async (id: ConversationId): Promise<ArchiveReport | null> => {
      const current = snapshotRef.current;
      const scope = captureScope();
      if (!db || !current) return null;

      const report = await db.repository.archiveConversation(id);
      await readSnapshot(scope, false, true, { kind: 'latest', excludedConversationId: id });
      await refreshWorlds();
      return report;
    },
    [db, refreshWorlds, captureScope, readSnapshot],
  );

  const deleteConversation = useCallback(
    async (id: ConversationId) => {
      const current = snapshotRef.current;
      const scope = captureScope();
      if (!db || !current) return;

      await db.repository.deleteConversation(id);
      await readSnapshot(scope, false, true, { kind: 'latest' });
      await refreshWorlds();
    },
    [db, refreshWorlds, captureScope, readSnapshot],
  );

  const deleteArchivedConversation = useCallback(
    async (id: ConversationId): Promise<DeletionFeedback> => {
      const current = snapshotRef.current;
      const scope = captureScope();
      if (!db || !current) return { ok: false, applied: false, message: '本机数据尚未就绪，请稍后再试。' };
      return deleteWithFeedback(
        () => db.repository.deleteConversation(id),
        async () => {
          if (
            isScopeCurrent(scope) &&
            !(await readSnapshot(scope, false, true, { kind: 'latest' })) &&
            isScopeCurrent(scope)
          )
            throw new Error('当前世界无法重新读取');
          await refreshWorlds();
        },
      );
    },
    [db, refreshWorlds, captureScope, isScopeCurrent, readSnapshot],
  );

  const appendMessages = useCallback(
    (messages: readonly Message[]): Promise<void> => {
      const batch = [...messages];
      const scope = captureScope();
      const run = async (): Promise<void> => {
        // 等前一笔真正写完后再读最新快照；两个调用不能并发读到相同的 localSeq。
        const current = snapshotRef.current;
        if (!db || batch.length === 0) return;
        const roomId = batch[0]?.roomId;
        if (roomId === undefined || batch.some((message) => message.roomId !== roomId)) {
          throw new Error('一次只能向同一个世界追加消息');
        }

        const stamped = await db.repository.appendMessages(roomId, batch);
        // 写库期间同步可能已更新快照；按最新快照合并，不能覆盖它。
        const latest = snapshotRef.current;
        if (!isScopeCurrent(scope) || latest === null || latest.room.id !== roomId) {
          // 用户恰好切换了世界：旧世界的消息已落库，不要塞进新世界快照。
          await refreshWorlds();
          return;
        }
        // 常规追加是 O(1)；同步恰在写库时换过快照，才从仓储重读它定义的总序
        // （createdAt → deviceId → localSeq），不能把这笔消息直接排在同步消息后面。
        let nextMessages: Message[];
        if (latest === current) {
          nextMessages = [...latest.messages, ...stamped];
          conditionalCommit(scope, (fresh) => (fresh === null ? null : { ...fresh, messages: nextMessages }));
        } else {
          const revision = snapshotRevisionRef.current;
          nextMessages = await db.repository.listMessages(roomId);
          const fresh = snapshotRef.current;
          if (!isScopeCurrent(scope) || fresh === null || fresh.room.id !== roomId) {
            await refreshWorlds();
            return;
          }
          if (
            !conditionalCommit(
              scope,
              (visible) => (visible === null ? null : { ...visible, messages: nextMessages }),
              revision,
            )
          ) {
            await readSnapshot(scope, false, true, { kind: 'latest' });
            if (!isScopeCurrent(scope)) {
              await refreshWorlds();
              return;
            }
            nextMessages = snapshotRef.current?.messages ?? nextMessages;
          }
        }
        // 与快照更新同批提交；并发全量刷新若已经读到这批消息，不重复加数。
        setWorlds((previous) => {
          let changed = false;
          const next = previous.map((world) => {
            if (world.id !== roomId || world.messageCount >= nextMessages.length) return world;
            changed = true;
            return { ...world, messageCount: nextMessages.length };
          });
          return changed ? next : previous;
        });
      };

      const task = appendQueueRef.current.then(run);
      // 调用方仍收到原始错误；队列尾巴吞掉它，让下一笔照常开始。
      appendQueueRef.current = task.catch(() => {});
      return task;
    },
    [captureScope, conditionalCommit, db, isScopeCurrent, readSnapshot, refreshWorlds],
  );

  const updateMessage = useCallback(
    async (id: MessageId, patch: Partial<Message>): Promise<Message | null> => {
      const current = snapshotRef.current;
      const scope = captureScope();
      if (!db || !current) return null;
      const updated = await db.repository.updateMessage(id, patch);
      if (!updated) return null;
      await commitPatch(scope, current, {
        messages: current.messages.map((message) => (message.id === id ? updated : message)),
      });
      return updated;
    },
    [db, captureScope, commitPatch],
  );

  const updateScene = useCallback(
    async (patch: Partial<Scene>) => {
      const current = snapshotRef.current;
      const scope = captureScope();
      if (!db || !current) return;

      const conversation = current.conversations.find((item) => item.id === current.room.activeConversationId);
      const scene = current.scenes.find((item) => item.id === conversation?.activeSceneId);
      if (!scene) return;

      const next: Scene = { ...scene, ...patch, id: scene.id, roomId: scene.roomId };
      await db.repository.saveScene(next);
      await commitPatch(scope, current, {
        scenes: current.scenes.map((item) => (item.id === next.id ? next : item)),
      });
    },
    [db, captureScope, commitPatch],
  );

  const setWorldScene = useCallback(
    async (
      patch: Partial<Scene>,
      targetConversationId: ConversationId | undefined,
      expectedRoomId?: RoomId,
    ): Promise<Scene | null> => {
      const current = snapshotRef.current;
      const scope = captureScope();
      if (
        !db ||
        !current ||
        !targetConversationId ||
        (expectedRoomId !== undefined && current.room.id !== expectedRoomId)
      )
        return null;
      const roomId = current.room.id;
      const target = await db.repository.getConversation(targetConversationId);
      if (
        !target ||
        target.roomId !== roomId ||
        target.kind !== 'main' ||
        target.archivedAt !== null ||
        target.deletedAt !== null
      )
        return null;
      const existing = target.activeSceneId === null ? null : await db.repository.getScene(target.activeSceneId);
      if (
        target.activeSceneId !== null &&
        (!existing || existing.roomId !== roomId || existing.conversationId !== target.id)
      )
        return null;
      // The explicit target still belongs to the captured room; a selection change only blocks its UI commit.
      const fields = {
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.location === undefined ? {} : { location: patch.location }),
        ...(patch.worldTime === undefined ? {} : { worldTime: patch.worldTime }),
        ...(patch.summary === undefined ? {} : { summary: patch.summary }),
        ...(patch.castPolicy === undefined ? {} : { castPolicy: patch.castPolicy }),
      };
      const next: Scene =
        existing === null
          ? {
              ...createSceneFor(
                roomId,
                target.id,
                target.stateSnapshot.map((item) => item.instanceId),
                {
                  title: fields.title ?? '开场',
                  summary: fields.summary ?? '',
                  location: fields.location ?? '',
                  worldTime: fields.worldTime ?? '',
                },
              ),
              ...fields,
            }
          : { ...existing, ...fields };
      await db.repository.saveScene(next);
      if (existing === null)
        await db.repository.saveConversation({ ...target, activeSceneId: next.id, updatedAt: nowIso() });
      const latest = snapshotRef.current;
      if (latest && isScopeCurrent(scope))
        await commitPatch(scope, current, {
          scenes: current.scenes.some((item) => item.id === next.id)
            ? current.scenes.map((item) => (item.id === next.id ? next : item))
            : [...current.scenes, next],
          conversations:
            existing === null
              ? current.conversations.map((item) =>
                  item.id === target.id ? { ...item, activeSceneId: next.id } : item,
                )
              : current.conversations,
        });
      return next;
    },
    [db, captureScope, commitPatch, isScopeCurrent],
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
      const scope = captureScope();
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

      await commitPatch(scope, current, {
        scenes: [
          ...current.scenes.map((scene) => (closedScene && scene.id === closedScene.id ? closedScene : scene)),
          nextScene,
        ],
        conversations: current.conversations.map((item) => (item.id === conversation.id ? conversation : item)),
        instances: current.instances.map((item) => synced.find((next) => next.id === item.id) ?? item),
      });
      return nextScene;
    },
    [db, captureScope, commitPatch],
  );

  const addInstance = useCallback(
    async (card: Card): Promise<CharacterInstance | null> => {
      const current = snapshotRef.current;
      const scope = captureScope();
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

      await commitPatch(scope, current, {
        room,
        scenes,
        instances: existing ? current.instances : [...current.instances, instance],
        cards: current.cards.some((item) => item.id === card.id) ? current.cards : [...current.cards, card],
      });
      await refreshWorlds();
      return instance;
    },
    [db, refreshWorlds, captureScope, commitPatch],
  );

  const removeInstance = useCallback(
    async (id: InstanceId) => {
      const current = snapshotRef.current;
      const scope = captureScope();
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

      await commitPatch(scope, current, {
        room,
        scenes,
        instances: current.instances.filter((item) => item.id !== id),
      });
      await refreshWorlds();
    },
    [db, refreshWorlds, captureScope, commitPatch],
  );

  const updateInstance = useCallback(
    async (id: InstanceId, patch: Partial<CharacterInstance>) => {
      const current = snapshotRef.current;
      const scope = captureScope();
      if (!db || !current) return;
      const instance = current.instances.find((item) => item.id === id);
      if (!instance) return;

      const next: CharacterInstance = { ...instance, ...patch, updatedAt: nowIso() };
      await db.repository.saveInstance(next);
      await commitPatch(scope, current, {
        instances: current.instances.map((item) => (item.id === id ? next : item)),
      });
    },
    [db, captureScope, commitPatch],
  );

  const setRelationship = useCallback(
    async (id: InstanceId, field: RelationshipField, value: number) => {
      const current = snapshotRef.current;
      const scope = captureScope();
      if (!db || !current) return;
      const instance = current.instances.find((item) => item.id === id);
      if (!instance) return;

      const next = setRelationshipFieldForInstance(instance, field, value, { at: nowIso() });
      if (next === instance) return; // 值没变：不写库、不重建快照
      await db.repository.saveInstance(next);
      await commitPatch(scope, current, {
        instances: current.instances.map((item) => (item.id === id ? next : item)),
      });
    },
    [db, captureScope, commitPatch],
  );

  const revertAffectChange = useCallback(
    async (id: InstanceId, changeId: string) => {
      const current = snapshotRef.current;
      const scope = captureScope();
      if (!db || !current) return;
      const instance = current.instances.find((item) => item.id === id);
      if (!instance) return;

      const next = revertAffectChangeForInstance(instance, changeId);
      if (next === instance) return;
      await db.repository.saveInstance(next);
      await commitPatch(scope, current, {
        instances: current.instances.map((item) => (item.id === id ? next : item)),
      });
    },
    [db, captureScope, commitPatch],
  );
  const setPresence = useCallback(
    async (id: InstanceId, presence: Presence) => {
      const current = snapshotRef.current;
      const scope = captureScope();
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

      await commitPatch(scope, current, {
        scenes,
        instances: current.instances.map((item) => (item.id === id ? next : item)),
      });
    },
    [db, captureScope, commitPatch],
  );

  const deleteMessage = useCallback(
    async (id: MessageId) => {
      const current = snapshotRef.current;
      const scope = captureScope();
      if (!db || !current) return;
      await db.repository.deleteMessage(id);
      await commitPatch(scope, current, {
        messages: current.messages.filter((message) => message.id !== id),
      });
      await refreshWorlds();
    },
    [db, refreshWorlds, captureScope, commitPatch],
  );

  const setPersona = useCallback(
    async (persona: Persona) => {
      const current = snapshotRef.current;
      const scope = captureScope();
      if (!db || !current) return;
      const conversation = current.conversations.find((item) => item.id === current.room.activeConversationId);
      if (!conversation) return;

      const nextConversation: Conversation = {
        ...conversation,
        personaId: persona.id,
        playerName: persona.name,
        playerPersona: persona.description,
        updatedAt: nowIso(),
      };
      const room: Room = {
        ...current.room,
        personaId: persona.id,
        playerName: persona.name,
        playerPersona: persona.description,
        updatedAt: nowIso(),
      };
      await db.repository.saveConversation(nextConversation);
      await db.repository.saveRoom(room);
      await commitPatch(scope, current, {
        room,
        conversations: current.conversations.map((item) => (item.id === nextConversation.id ? nextConversation : item)),
      });
    },
    [db, captureScope, commitPatch],
  );

  const savePersona = useCallback(
    async (persona: Persona) => {
      const current = snapshotRef.current;
      const scope = captureScope();
      if (!db) return;
      await db.repository.savePersona(persona);
      setPersonas((previous) =>
        previous.some((item) => item.id === persona.id)
          ? previous.map((item) => (item.id === persona.id ? persona : item))
          : [...previous, persona],
      );
      if (!current) return;

      const personas = current.personas.some((item) => item.id === persona.id)
        ? current.personas.map((item) => (item.id === persona.id ? persona : item))
        : [...current.personas, persona];

      const conversations = current.conversations.map((conversation) =>
        conversation.personaId === persona.id
          ? {
              ...conversation,
              playerName: persona.name,
              playerPersona: persona.description,
              updatedAt: nowIso(),
            }
          : conversation,
      );
      for (const conversation of conversations) {
        if (conversation.personaId !== persona.id) continue;
        await db.repository.saveConversation(conversation);
      }

      // 世界上的副本继续当「新对话的默认身份」，但不代表所有旧对话都被改写。
      const room =
        current.room.personaId === persona.id
          ? { ...current.room, playerName: persona.name, playerPersona: persona.description }
          : current.room;

      await commitPatch(scope, current, { personas, room, conversations });
    },
    [db, captureScope, commitPatch],
  );

  const listPersonas = useCallback(async (): Promise<Persona[]> => {
    if (!db) return [];
    const list = await db.repository.listPersonas();
    setPersonas(list);
    return list;
  }, [db]);

  const deletePersona = useCallback(
    async (id: string) => {
      const current = snapshotRef.current;
      const scope = captureScope();
      if (!db) return;
      await db.repository.deletePersona(id);
      setPersonas((previous) => previous.filter((persona) => persona.id !== id));
      if (!current) return;
      await readSnapshot(scope, false, true, { kind: 'latest' });
    },
    [db, captureScope, readSnapshot],
  );

  const revertTurn = useCallback(
    async (turnId: string) => {
      const current = snapshotRef.current;
      const scope = captureScope();
      if (!db || !current) return;

      // 顺序 77：记忆与情绪在一个事务里撤（见 turn-write.ts），撤完再对齐界面状态。
      const { revertedInstances } = await revertTurnWrites(db.store, current.room.id, turnId);

      await commitPatch(scope, current, {
        memories: current.memories.filter((memory) => !memory.sourceTurnIds.includes(turnId)),
        instances: current.instances.map(
          (instance) => revertedInstances.find((item) => item.id === instance.id) ?? instance,
        ),
      });
    },
    [db, captureScope, commitPatch],
  );

  /**
   * 顺序 77：原地改写一条已存在的回复，并把这一轮的后台写入（任务键、记忆、情绪）
   * 一起撤掉——**全在一个事务里**，要么都成、要么一条都不落。
   *
   * 之前这四步各写各的，中间失败会留下「回复换了、上一轮的情绪还在」这种半截状态。
   * 返回 `null` 表示这条回复已经不在库里（被删掉或被同步覆盖）；界面状态在事务提交
   * 之后才对，模型调用与用量账单仍由调用方（`useTurnRunner.ts`）负责。
   */
  const rewriteTurn = useCallback(
    async (input: { messageId: MessageId; patch: Partial<Message>; turnId: string }): Promise<Message | null> => {
      const current = snapshotRef.current;
      const scope = captureScope();
      if (!db || !current) return null;

      const { message, reverted } = await rewriteTurnWrites(db.store, {
        messageId: input.messageId,
        patch: input.patch,
        roomId: current.room.id,
        turnId: input.turnId,
      });
      if (message === null) return null;

      await commitPatch(scope, current, {
        messages: current.messages.map((item) => (item.id === message.id ? message : item)),
        memories: current.memories.filter((memory) => !memory.sourceTurnIds.includes(input.turnId)),
        instances: current.instances.map(
          (instance) => reverted.revertedInstances.find((item) => item.id === instance.id) ?? instance,
        ),
      });

      return message;
    },
    [db, captureScope, commitPatch],
  );

  const updateMemory = useCallback(
    async (id: EventId, patch: Partial<MemoryEvent>) => {
      const current = snapshotRef.current;
      const scope = captureScope();
      if (!db || !current) return;
      const updated = await db.repository.updateMemory(id, patch);
      if (!updated) return;
      await commitPatch(scope, current, {
        memories: current.memories.map((memory) => (memory.id === id ? updated : memory)),
      });
    },
    [db, captureScope, commitPatch],
  );

  const deleteMemory = useCallback(
    async (id: EventId) => {
      const current = snapshotRef.current;
      const scope = captureScope();
      if (!db || !current) return;
      await db.repository.deleteMemory(id);
      await commitPatch(scope, current, {
        memories: current.memories.filter((memory) => memory.id !== id),
      });
    },
    [db, captureScope, commitPatch],
  );

  /** 被回想过的记忆累计次数，「越想越牢」参与后续评分。 */
  const markRecalled = useCallback(
    async (events: readonly MemoryEvent[], now: string) => {
      const current = snapshotRef.current;
      const scope = captureScope();
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
      await commitPatch(scope, current, {
        memories: current.memories.map((memory) => touched.find((item) => item.id === memory.id) ?? memory),
      });
    },
    [db, captureScope, commitPatch],
  );

  const attachWorldBook = useCallback(
    async (book: WorldBook) => {
      const current = snapshotRef.current;
      const scope = captureScope();
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
      await commitPatch(scope, current, { room, worldBooks: [...current.worldBooks, book] });
    },
    [db, refreshLibrary, captureScope, commitPatch],
  );

  const detachWorldBook = useCallback(
    async (id: WorldBookId) => {
      const current = snapshotRef.current;
      const scope = captureScope();
      if (!db || !current) return;

      const room: Room = {
        ...current.room,
        worldBookIds: current.room.worldBookIds.filter((item) => item !== id),
        updatedAt: nowIso(),
      };
      await db.repository.saveRoom(room);
      await commitPatch(scope, current, { room, worldBooks: current.worldBooks.filter((book) => book.id !== id) });
    },
    [db, captureScope, commitPatch],
  );

  const saveCard = useCallback(
    async (card: Card) => {
      const current = snapshotRef.current;
      const scope = captureScope();
      if (!db) return;
      await db.repository.saveCard(card);
      await refreshLibrary();

      // 世界快照里的卡也要跟着更新，否则界面上还是旧的
      if (current?.cards.some((item) => item.id === card.id)) {
        await commitPatch(scope, current, {
          cards: current.cards.map((item) => (item.id === card.id ? card : item)),
        });
      }
    },
    [db, refreshLibrary, captureScope, commitPatch],
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
      const current = snapshotRef.current;
      const scope = captureScope();
      if (!db) return;
      await db.repository.saveWorldBook(book);
      await refreshLibrary();

      // 挂在这个世界上的世界书改了内容，prompt 里用的也得是新版本
      if (current?.worldBooks.some((item) => item.id === book.id)) {
        await commitPatch(scope, current, {
          worldBooks: current.worldBooks.map((item) => (item.id === book.id ? book : item)),
        });
      }
    },
    [db, refreshLibrary, captureScope, commitPatch],
  );

  const deleteWorldBook = useCallback(
    async (id: WorldBookId) => {
      const current = snapshotRef.current;
      const scope = captureScope();
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
        await commitPatch(scope, current, {
          room,
          worldBooks: current.worldBooks.filter((book) => book.id !== id),
        });
      }
      await refreshLibrary();
    },
    [db, refreshLibrary, captureScope, commitPatch],
  );

  const adoptArtifact = useCallback(
    async (messageId: MessageId, artifactId: string) => {
      const current = snapshotRef.current;
      const scope = captureScope();
      if (!db || !current) return;
      const message = current.messages.find((item) => item.id === messageId);
      const artifact = message?.artifacts?.find((item) => item.id === artifactId);
      if (!message || message.roomId !== current.room.id || !artifact || artifact.status !== 'pending') return;
      if (artifact.kind === 'world-book') {
        const book = isCompleteWorldBook(artifact.payload)
          ? await db.repository.getWorldBook(artifact.payload.id)
          : null;
        const conflict = worldBookArtifactConflict(artifact, book);
        if (conflict) {
          const updated = await db.repository.updateMessage(messageId, {
            artifacts: message.artifacts?.map((item) => (item.id === artifactId ? { ...item, conflict } : item)),
          });
          const latest = snapshotRef.current;
          if (updated && latest && isScopeCurrent(scope))
            await commitPatch(scope, current, {
              messages: current.messages.map((item) => (item.id === messageId ? updated : item)),
            });
          return;
        }
      }
      const result = await db.repository.adoptAdminArtifact(messageId, artifactId);
      if (!result) return;
      const latest = snapshotRef.current;
      if (latest && isScopeCurrent(scope))
        await commitPatch(scope, current, {
          messages: current.messages.map((message) => (message.id === messageId ? result.message : message)),
        });
      await refreshLibrary();
      await refreshPersonas();
    },
    [db, refreshLibrary, refreshPersonas, captureScope, commitPatch, isScopeCurrent],
  );

  const discardArtifact = useCallback(
    async (messageId: MessageId, artifactId: string) => {
      const current = snapshotRef.current;
      const scope = captureScope();
      if (!db || !current) return;
      const updated = await db.repository.discardAdminArtifact(messageId, artifactId);
      if (!updated) return;
      await commitPatch(scope, current, {
        messages: current.messages.map((message) => (message.id === messageId ? updated : message)),
      });
    },
    [db, captureScope, commitPatch],
  );

  const revokeArtifact = useCallback(
    async (messageId: MessageId, artifactId: string) => {
      const current = snapshotRef.current;
      const scope = captureScope();
      if (!db || !current) return;
      const message = current.messages.find((item) => item.id === messageId);
      const artifact = message?.artifacts?.find((item) => item.id === artifactId);
      if (!message || message.roomId !== current.room.id || !artifact) return;
      if (isModifiedWorldBookArtifact(artifact)) {
        setError('修改世界书不能直接撤回，请起草反向修改');
        return;
      }
      const result = await db.repository.revokeAdminArtifact(messageId, artifactId);
      if (!result) return;
      const latest = snapshotRef.current;
      if (latest && isScopeCurrent(scope))
        await commitPatch(scope, current, {
          messages: current.messages.map((message) => (message.id === messageId ? result.message : message)),
        });
      // 素材库跟着变（刚删掉的那份要消失）
      await refreshLibrary();
      await refreshPersonas();
    },
    [db, refreshLibrary, refreshPersonas, captureScope, commitPatch, isScopeCurrent],
  );

  const reverseArtifact = useCallback(
    async (messageId: MessageId, artifactId: string) => {
      const current = snapshotRef.current;
      const scope = captureScope();
      if (!db || !current) return;
      const message = current.messages.find((item) => item.id === messageId && item.roomId === current.room.id);
      const artifact = message?.artifacts?.find((item) => item.id === artifactId);
      if (!message || !artifact || !isCompleteWorldBook(artifact.payload)) return;
      try {
        const book = await db.repository.getWorldBook(artifact.payload.id);
        if (!book) throw Error('原世界书已不存在，不能反向修改');
        const draft = reverseWorldBookDraft(artifact, book);
        if (!isScopeCurrent(scope)) return;
        const pending = {
          id: newId(),
          kind: 'world-book' as const,
          title: draft.book.name,
          summary: draft.summary,
          status: 'pending' as const,
          targetId: null,
          payload: draft.book,
          previousPayload: draft.previous,
          baseUpdatedAt: draft.baseUpdatedAt,
          createdAt: nowIso(),
        };
        // Use the session append queue, and omit the original model usage from this local draft.
        const { usage: _usage, ...source } = message;
        await appendMessages([
          {
            ...source,
            id: newId() as MessageId,
            role: 'admin',
            speakerName: '世界管理员',
            turnId: newId(),
            content: '已起草反向修改；请核对具体差异后采纳。',
            artifacts: [pending],
            localSeq: 0,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          },
        ]);
      } catch (error) {
        if (isScopeCurrent(scope)) setError(error instanceof Error ? error.message : String(error));
      }
    },
    [appendMessages, captureScope, db, isScopeCurrent],
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

  const clearError = useCallback(() => setError(null), []);

  /*
   * 返回对象要稳定（顺序 59）：App 里二十多个 useCallback 拿 `session` 当依赖，
   * 每次渲染新造一个字面量就等于把所有 memo 都作废。派生的几个数组（当前对话的消息、
   * 场景线、章节）也一起算在这里，只在快照或当前对话变了才重算。
   */
  return useMemo(() => {
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

    // 这条对话的场景线（含已结束的）：历史按场记覆盖收起、「前几场」场记都要看它
    const scenes =
      snapshot === null || conversation === null
        ? []
        : snapshot.scenes
            .filter((item) => item.conversationId === conversation.id)
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    return {
      ready,
      error,
      clearError,
      worlds,
      world: snapshot?.room ?? null,
      conversations: snapshot === null ? [] : snapshot.conversations.filter((item) => item.archivedAt === null),
      archivedConversations: snapshot === null ? [] : snapshot.conversations.filter((item) => item.archivedAt !== null),
      conversation,
      scene,
      scenes,
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
      allChapters: snapshot?.chapters ?? [],
      personas,
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
      renameConversation,
      archiveConversation,
      deleteConversation,
      deleteArchivedConversation,
      addInstance,
      removeInstance,
      updateInstance,
      setRelationship,
      revertAffectChange,
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
      rewriteTurn,
      attachWorldBook,
      detachWorldBook,
      saveCard,
      deleteCard,
      saveWorldBook,
      deleteWorldBook,
      adoptArtifact,
      discardArtifact,
      revokeArtifact,
      reverseArtifact,
      setPersona,
      savePersona,
      deletePersona,
      listPersonas,
      appendMessages,
    };
  }, [
    addInstance,
    adoptArtifact,
    appendMessages,
    archiveConversation,
    attachWorldBook,
    bundleOf,
    clearError,
    conversation,
    createWorld,
    deleteCard,
    deleteConversation,
    deleteArchivedConversation,
    deleteMemory,
    deleteMessage,
    deletePersona,
    deleteWorld,
    deleteWorldBook,
    detachWorldBook,
    discardArtifact,
    error,
    library,
    listPersonas,
    locateTurn,
    markRecalled,
    openConversation,
    openSideConversation,
    openWorld,
    personas,
    ready,
    refreshAll,
    reloadWorld,
    removeInstance,
    renameWorld,
    revertAffectChange,
    revertTurn,
    rewriteTurn,
    revokeArtifact,
    reverseArtifact,
    saveCard,
    savePersona,
    saveWorldBook,
    setBudget,
    setPersona,
    setPresence,
    setRelationship,
    setWorldScene,
    snapshot,
    startConversation,
    startNewScene,
    updateConversation,
    renameConversation,
    updateInstance,
    updateMemory,
    updateMessage,
    updateScene,
    worlds,
  ]);
}
