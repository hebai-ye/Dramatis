import type { ChapterSummary } from '../memory/summary.js';
import type { Card, WorldBook } from '../model/card.js';
import { type Conversation, defaultConversationModes, restoreInstancesFromSnapshot } from '../model/conversation.js';
import {
  conversationId as asConversationId,
  roomId as asRoomId,
  sceneId as asSceneId,
  type CardId,
  type ConversationId,
  type EventId,
  type MessageId,
  newId,
  nowIso,
  type RoomId,
  type SceneId,
  type WorldBookId,
} from '../model/ids.js';
import type { AffectChange, CharacterInstance, RelationshipChange } from '../model/instance.js';
import { aliveOnly, isAlive } from '../model/lifecycle.js';
import { type AdminArtifact, localSeqOf, type MemoryEvent, type Message } from '../model/message.js';
import { createPersona, type Persona } from '../model/persona.js';
import type { ProviderCredential, ProviderProfile } from '../model/provider.js';
import type { Room, Scene } from '../model/room.js';
import type { EntityQuery, EntityStore } from '../platform/entity-store.js';
import {
  EMPTY_SYNC_STATE,
  type LocalSyncRecord,
  SYNC_COLLECTIONS,
  type SyncCollection,
  type SyncState,
} from '../sync/types.js';
import { USAGE_COLLECTION } from './usage.js';

/**
 * 当前 schema 版本。
 *
 * 任何会改变已落盘数据结构的改动都要 +1，并补一条 `Migration`。
 * 这是「从第一天就留好升级路径」的具体做法（ROADMAP P0-1）。
 */
export const SCHEMA_VERSION = 10;

export const COLLECTIONS = {
  meta: 'meta',
  rooms: 'rooms',
  conversations: 'conversations',
  scenes: 'scenes',
  cards: 'cards',
  instances: 'instances',
  worldBooks: 'worldBooks',
  messages: 'messages',
  memories: 'memories',
  personas: 'personas',
  providerProfiles: 'providerProfiles',
  backgroundTasks: 'backgroundTasks',
  usageRecords: USAGE_COLLECTION,
  chapterSummaries: 'chapterSummaries',
  providerCredentials: 'providerCredentials',
} as const;

export const META_KEYS = {
  schemaVersion: 'schema.version',
  lastRoomId: 'session.lastRoomId',
  /**
   * 本机设备号（P2-6）。
   *
   * 消息顺序是 `(deviceId, localSeq)`：两台设备各排各的号，没有设备号
   * 就分不清「这条 1 号」是谁的。它存在 meta 里而不是设置里——用户不该
   * 也不需要看见它，换台设备就是新的设备号。
   */
  deviceId: 'device.id',
  /**
   * 同步状态（P2-6 第三步）：拉取游标与推送点。
   *
   * 存 meta 而不是实体：它是**这台设备**和服务端之间的账，不该被同步出去
   * （同步它只会让两台设备抢同一个游标）。
   */
  syncState: 'sync.state',
  /**
   * 本机逻辑时钟（P2-6 第四步）：最后一次盖章的时间。
   *
   * 有了它，`updatedAt` 才是**全库单调**的，而不只是每条记录自己递增。
   * 这解决一个真会丢数据的问题：推送水位线是「这一毫秒推过了」，若新写入
   * 恰好落在同一毫秒，`updatedAt > 水位线` 就不成立——那条消息永远推不出去。
   */
  clock: 'clock.lastStamped',
} as const;

export interface Migration {
  version: number;
  describe: string;
  run(store: EntityStore): Promise<void>;
}

export interface MigrationReport {
  from: number;
  to: number;
  applied: Migration[];
}

export interface RoomSummary {
  id: RoomId;
  title: string;
  updatedAt: string;
  messageCount: number;
  instanceCount: number;
  conversationCount: number;
}

export interface RoomSnapshot {
  room: Room;
  /** 世界下的所有对话，含已归档的（界面默认只显示未归档的）。 */
  conversations: Conversation[];
  scenes: Scene[];
  instances: CharacterInstance[];
  cards: Card[];
  worldBooks: WorldBook[];
  messages: Message[];
  /** 房间内的记忆条目，含客观条目与各角色视角条目。 */
  memories: MemoryEvent[];
  /** 已经滚成章节的前情（P1-5），按时间正序。 */
  chapters: ChapterSummary[];
  /** persona 是跨房间共用的身份表，一并返回方便 UI 直接切换。 */
  personas: Persona[];
}

/**
 * 把「没变的那些集合」的数组引用沿用上一份（顺序 62）。
 *
 * 为什么需要它：一次仓储写入（记忆、情绪、章节、账单）都会让 `loadRoom` 重新读出
 * 整份快照并造一批新数组，于是 React 那边 `messages` 的引用变了、`MessageList`
 * 的 memo 立刻失效——**一轮收尾会把 600 条消息整体重画 7–10 次**（EVAL 第四十八节实测）。
 * 其实这一轮收尾并没有改动消息本身。
 *
 * 判据是逐条比 `updatedAt`（所有实体都有它，而且每次写入都会盖新的）加长度相等：
 * 便宜、无副作用、也不会漏掉「内容改了但时间戳没动」的情况——那种写入不存在。
 * 只要有一条对不上就整条换新数组，绝不冒「显示旧数据」的风险。
 */
export function reuseUnchangedCollections(previous: RoomSnapshot | null, next: RoomSnapshot): RoomSnapshot {
  if (previous === null || previous.room.id !== next.room.id) return next;

  const sameArray = <T>(before: readonly T[] | undefined, after: T[]): T[] => {
    if (before === undefined || before.length !== after.length) return after;
    for (let index = 0; index < after.length; index += 1) {
      const left = (before[index] as { id?: unknown; updatedAt?: unknown } | undefined) ?? {};
      const right = (after[index] as { id?: unknown; updatedAt?: unknown } | undefined) ?? {};
      if (left.id !== right.id || left.updatedAt !== right.updatedAt) return after;
    }
    return before as T[];
  };

  return {
    ...next,
    conversations: sameArray(previous.conversations, next.conversations),
    scenes: sameArray(previous.scenes, next.scenes),
    instances: sameArray(previous.instances, next.instances),
    cards: sameArray(previous.cards, next.cards),
    worldBooks: sameArray(previous.worldBooks, next.worldBooks),
    messages: sameArray(previous.messages, next.messages),
    memories: sameArray(previous.memories, next.memories),
    chapters: sameArray(previous.chapters, next.chapters),
    personas: sameArray(previous.personas, next.personas),
  };
}

/** 归档一条对话的实际影响，供界面如实提示「回滚了什么」。 */
export interface ArchiveReport {
  conversationId: ConversationId;
  restoredInstances: number;
  removedMemories: number;
  /** 一起收走的章节摘要条数（P1-5）。 */
  removedChapters: number;
  nextConversationId: ConversationId | null;
}

/**
 * 内建迁移。
 *
 * v2 把原本内联在房间上的玩家身份抽成独立的 persona 实体。
 * 这是第一次真正用到迁移机制——也说明它不是空架子。
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 2,
    describe: '把房间内联的玩家身份抽出为独立的 persona 实体',
    run: async (store) => {
      const rooms = await store.list<Record<string, unknown>>(COLLECTIONS.rooms);
      for (const room of rooms) {
        const roomId = typeof room.id === 'string' ? room.id : '';
        if (roomId === '') continue;
        if (typeof room.personaId === 'string' && room.personaId !== '') continue;

        const name = typeof room.playerName === 'string' ? room.playerName.trim() : '';
        if (name === '') continue;

        const persona = createPersona({
          name,
          description: typeof room.playerPersona === 'string' ? room.playerPersona : '',
        });
        await store.put(COLLECTIONS.personas, persona);
        await store.put(COLLECTIONS.rooms, { ...room, id: roomId, personaId: persona.id });
      }
    },
  },
  {
    version: 3,
    describe: '把房间拆成「世界 + 多条对话」：为每个世界补一条主线对话，并给场景、消息、记忆标明归属',
    run: async (store) => {
      const rooms = await store.list<Record<string, unknown>>(COLLECTIONS.rooms);

      for (const room of rooms) {
        const id = typeof room.id === 'string' ? room.id : '';
        if (id === '') continue;

        const now = typeof room.updatedAt === 'string' ? room.updatedAt : nowIso();
        const activeScene = typeof room.activeSceneId === 'string' ? asSceneId(room.activeSceneId) : null;

        const conversation: Conversation = {
          id: asConversationId(newId()),
          roomId: asRoomId(id),
          kind: 'main',
          title: '主线',
          activeSceneId: activeScene,
          modes: defaultConversationModes(),
          personaId: typeof room.personaId === 'string' ? room.personaId : null,
          playerName: typeof room.playerName === 'string' ? room.playerName : '玩家',
          playerPersona: typeof room.playerPersona === 'string' ? room.playerPersona : '',
          archivedAt: null,
          // 旧数据没有「对话开始之前」的概念：整条线就是这个世界本身，
          // 所以快照留空，归档这样的对话不会回滚任何状态。
          stateSnapshot: [],
          createdAt: typeof room.createdAt === 'string' ? room.createdAt : now,
          updatedAt: now,
          deletedAt: null,
        };
        await store.put(COLLECTIONS.conversations, conversation);

        const assign = async (collection: string): Promise<void> => {
          const records = await store.list<Record<string, unknown> & { id: string }>(collection, {
            where: { roomId: id },
          });
          for (const record of records) {
            if (typeof record.conversationId === 'string') continue;
            await store.put(collection, { ...record, id: record.id, conversationId: conversation.id });
          }
        };

        await assign(COLLECTIONS.scenes);
        await assign(COLLECTIONS.messages);
        await assign(COLLECTIONS.memories);

        const { activeSceneId: _dropped, ...rest } = room;
        await store.put(COLLECTIONS.rooms, { ...rest, id, activeConversationId: conversation.id });
      }
    },
  },
  {
    version: 4,
    describe: '补齐 Scene / Message / MemoryEvent / ChapterSummary 的 updatedAt（P2-6 数据层前置）',
    run: async (store) => {
      // 这四类实体此前只有 createdAt。抄一个旧的 `updatedAt` 出来是不对的（那会让
      // 老数据看起来「刚刚被改过」而抢走 LWW），所以回填成它们各自的 createdAt。
      const collections = [
        COLLECTIONS.scenes,
        COLLECTIONS.messages,
        COLLECTIONS.memories,
        COLLECTIONS.chapterSummaries,
      ];
      for (const collection of collections) {
        const records = await store.list<Record<string, unknown> & { id: string }>(collection);
        for (const record of records) {
          if (typeof record.updatedAt === 'string' && record.updatedAt !== '') continue;
          const fallback = typeof record.createdAt === 'string' ? record.createdAt : nowIso();
          await store.put(collection, { ...record, id: record.id, updatedAt: fallback });
        }
      }
    },
  },
  {
    version: 5,
    describe: '给参与同步的实体补 deletedAt = null（P2-6 软删除）：老记录一律视为「还在」',
    run: async (store) => {
      // 只补字段、不改语义：老库里所有记录都是硬删的，没有墓碑可言，
      // 所以它们全都应该是「活着」。字段补上之后 isAlive 的判据才一致。
      const collections = [
        COLLECTIONS.rooms,
        COLLECTIONS.conversations,
        COLLECTIONS.scenes,
        COLLECTIONS.instances,
        COLLECTIONS.cards,
        COLLECTIONS.worldBooks,
        COLLECTIONS.messages,
        COLLECTIONS.memories,
        COLLECTIONS.chapterSummaries,
        COLLECTIONS.personas,
      ];
      for (const collection of collections) {
        const records = await store.list<Record<string, unknown> & { id: string }>(collection);
        for (const record of records) {
          if (record.deletedAt !== undefined) continue;
          await store.put(collection, { ...record, id: record.id, deletedAt: null });
        }
      }
    },
  },
  {
    version: 6,
    describe: '本机 deviceId 落进 meta，消息的 seq 改名 localSeq 并补 deviceId（P2-6）',
    run: async (store) => {
      // 1) 本机设备号。迁移跑在任何写入之前，所以这里就得把它造出来——
      //    否则应用启动后第一批消息会没有设备号。
      const metaKey = META_KEYS.deviceId;
      const existing = await store.get<{ id: string; value: unknown }>(COLLECTIONS.meta, metaKey);
      let deviceId = typeof existing?.value === 'string' && existing.value !== '' ? existing.value : '';
      if (deviceId === '') {
        deviceId = newId();
        await store.put(COLLECTIONS.meta, { id: metaKey, value: deviceId, updatedAt: nowIso() });
      }

      // 2) 消息：`seq` → `localSeq`。老消息都是**这台设备**写下的（本地库是唯一
      //    真相源，别处不会凭空出现记录），所以设备号直接补本机的。
      const messages = await store.list<Record<string, unknown> & { id: string }>(COLLECTIONS.messages);
      for (const message of messages) {
        const { seq: legacySeq, ...rest } = message;
        const localSeq =
          typeof rest.localSeq === 'number' ? rest.localSeq : typeof legacySeq === 'number' ? legacySeq : 0;
        const messageDevice = typeof rest.deviceId === 'string' && rest.deviceId !== '' ? rest.deviceId : deviceId;
        await store.put(COLLECTIONS.messages, { ...rest, id: message.id, localSeq, deviceId: messageDevice });
      }

      // 3) 房间级计数器一起改名，否则老库会从 1 重新发号（号码会撞）
      const rooms = await store.list<{ id: string }>(COLLECTIONS.rooms);
      for (const room of rooms) {
        const legacyKey = `seq:${room.id}`;
        const legacy = await store.get<{ id: string; value: unknown }>(COLLECTIONS.meta, legacyKey);
        if (legacy === null) continue;

        const nextKey = `localSeq:${room.id}`;
        const current = await store.get<{ id: string; value: unknown }>(COLLECTIONS.meta, nextKey);
        const legacyValue = typeof legacy.value === 'number' ? legacy.value : 0;
        const currentValue = typeof current?.value === 'number' ? current.value : 0;
        await store.put(COLLECTIONS.meta, {
          id: nextKey,
          value: Math.max(legacyValue, currentValue),
          updatedAt: nowIso(),
        });
        await store.remove(COLLECTIONS.meta, legacyKey);
      }
    },
  },
  {
    version: 7,
    /*
     * 模型配置的窗口与回复预留（2026-09-21：按「800 条用户输入」定新默认值）。
     *
     * 只动**还是老默认值**（16384 / 1024）的那份配置：用户自己调过的数字不动——
     * 迁移改用户的显式选择是最讨人厌的那种「帮你优化」。
     */
    describe: '模型配置里还是老默认值的窗口/回复预留，提到 65536 / 4096（够 800 条用户输入）',
    run: async (store) => {
      const profiles = await store.list<ProviderProfile>(COLLECTIONS.providerProfiles);
      for (const profile of profiles) {
        if (profile.maxTokens !== 16384 || profile.reserveForReply !== 1024) continue;
        await store.put(COLLECTIONS.providerProfiles, {
          ...profile,
          maxTokens: 65536,
          reserveForReply: 4096,
          updatedAt: nowIso(),
        });
      }
    },
  },
  {
    version: 8,
    /*
     * 记忆合并的三个字段（顺序 27a）：`supersededBy` / `supersedes` / `consolidatedAt`。
     *
     * 老记录补 null（`supersedes` 补空数组），这样合并的判定不必到处写 undefined 分支。
     * 语义上是「谁都还没被合并过」，与事实一致。
     */
    describe: '记忆补上合并相关的三个字段（supersededBy / supersedes / consolidatedAt）',
    run: async (store) => {
      const memories = await store.list<MemoryEvent>(COLLECTIONS.memories);
      for (const memory of memories) {
        if (
          memory.supersededBy !== undefined &&
          memory.supersedes !== undefined &&
          memory.consolidatedAt !== undefined
        ) {
          continue;
        }
        await store.put(COLLECTIONS.memories, {
          ...memory,
          supersededBy: memory.supersededBy ?? null,
          supersedes: memory.supersedes ?? [],
          consolidatedAt: memory.consolidatedAt ?? null,
        });
      }
    },
  },
  {
    version: 9,
    describe: '状态变化补 id / before / after / 来源记忆 / 撤销关联',
    run: async (store) => {
      const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
      const legacyId = (scope: string, index: number, at: string, turnId: string): string =>
        `legacy:${scope}:${String(index)}:${at}:${turnId}`;
      const instances = await store.list<CharacterInstance>(COLLECTIONS.instances);
      for (const instance of instances) {
        let changed = false;

        let valence = instance.affect.valence;
        let arousal = instance.affect.arousal;
        const affectHistory = [...instance.affect.history] as Array<Partial<AffectChange>>;
        for (let index = affectHistory.length - 1; index >= 0; index -= 1) {
          const change = affectHistory[index];
          if (change === undefined) continue;
          const afterValence = change.afterValence ?? valence;
          const afterArousal = change.afterArousal ?? arousal;
          const beforeValence = change.beforeValence ?? afterValence - (change.deltaValence ?? 0);
          const beforeArousal = change.beforeArousal ?? afterArousal - (change.deltaArousal ?? 0);
          const id = change.id ?? legacyId(instance.id, index, String(change.at ?? ''), String(change.turnId ?? ''));
          const sourceMemoryIds = change.sourceMemoryIds ?? [];
          const reversionOf = change.reversionOf ?? null;
          if (
            change.id === undefined ||
            change.beforeValence === undefined ||
            change.afterValence === undefined ||
            change.beforeArousal === undefined ||
            change.afterArousal === undefined ||
            change.sourceMemoryIds === undefined ||
            change.reversionOf === undefined
          ) {
            changed = true;
            affectHistory[index] = {
              ...(change as AffectChange),
              id,
              beforeValence,
              afterValence,
              beforeArousal,
              afterArousal,
              sourceMemoryIds,
              reversionOf,
            };
          }
          valence = beforeValence;
          arousal = beforeArousal;
        }

        const relationships = instance.relationships.map((edge) => {
          const values: Record<RelationshipChange['field'], number> = {
            trust: edge.trust,
            affinity: edge.affinity,
            fear: edge.fear,
            respect: edge.respect,
            tension: edge.tension,
          };
          const history = [...edge.history] as Array<Partial<RelationshipChange>>;
          for (let index = history.length - 1; index >= 0; index -= 1) {
            const change = history[index];
            if (change === undefined || change.field === undefined) continue;
            const after = change.after ?? values[change.field];
            const before = change.before ?? after - (change.delta ?? 0);
            const id =
              change.id ??
              legacyId(`${instance.id}:${edge.target}`, index, String(change.at ?? ''), String(change.turnId ?? ''));
            const sourceMemoryIds = change.sourceMemoryIds ?? [];
            const reversionOf = change.reversionOf ?? null;
            if (
              change.id === undefined ||
              change.before === undefined ||
              change.after === undefined ||
              change.sourceMemoryIds === undefined ||
              change.reversionOf === undefined
            ) {
              changed = true;
              history[index] = {
                ...(change as RelationshipChange),
                id,
                before,
                after,
                sourceMemoryIds,
                reversionOf,
              };
            }
            values[change.field] = clamp(before, change.field === 'tension' || change.field === 'fear' ? 0 : -1, 1);
          }
          return changed ? { ...edge, history: history as RelationshipChange[] } : edge;
        });

        if (changed) {
          await store.put(COLLECTIONS.instances, {
            ...instance,
            affect: { ...instance.affect, history: affectHistory as AffectChange[] },
            relationships,
          });
        }
      }
    },
  },
  {
    version: 10,
    /* 账户重构 A4：玩家身份从世界级迁移到对话级。 */
    describe: '对话补上 personaId / playerName / playerPersona，旧对话继承原世界身份',
    run: async (store) => {
      const rooms = await store.list<Room>(COLLECTIONS.rooms);
      const roomsById = new Map(rooms.map((room) => [room.id, room]));
      const conversations = await store.list<Conversation>(COLLECTIONS.conversations);
      for (const conversation of conversations) {
        if (
          conversation.personaId !== undefined &&
          conversation.playerName !== undefined &&
          conversation.playerPersona !== undefined
        ) {
          continue;
        }
        const room = roomsById.get(conversation.roomId);
        await store.put(COLLECTIONS.conversations, {
          ...conversation,
          personaId: conversation.personaId ?? room?.personaId ?? null,
          playerName: conversation.playerName ?? room?.playerName ?? '玩家',
          playerPersona: conversation.playerPersona ?? room?.playerPersona ?? '',
        });
      }
    },
  },
];

interface MetaRecord {
  id: string;
  value: unknown;
  updatedAt: string;
}

/**
 * 落盘的消息记录。
 *
 * 比 `Message` 多一个可选的 `seq`：P2-6 之前写下的老消息只有那个字段，
 * 读到内存里之后一律走 `reviveMessage` 归一，别处不该再看见它。
 */
type StoredMessage = Message & { seq?: number; localSeq?: number; deviceId?: string };

/** 老消息补上新字段：`seq` → `localSeq`，缺设备号时按本机算。 */
function reviveMessage(raw: StoredMessage, fallbackDeviceId: string): Message {
  const { seq: _legacySeq, ...rest } = raw;
  return {
    ...rest,
    localSeq: raw.localSeq ?? raw.seq ?? 0,
    deviceId: raw.deviceId ?? fallbackDeviceId,
    updatedAt: raw.updatedAt ?? raw.createdAt,
    deletedAt: raw.deletedAt ?? null,
  };
}

/**
 * 仓储层（ROADMAP P0-1）。
 *
 * 所有落盘都经过这里，UI 不直接接触 `EntityStore`。这样换存储后端
 * （IndexedDB → SQLite）时，只有适配层需要改动。
 */
export class Repository {
  /**
   * 本机设备号的内存缓存。
   *
   * 消息落盘时每条都要填它，而它只在 meta 里存一份——不缓存的话每次
   * 追加消息都要多读一次库。
   */
  private deviceIdCache: string | null = null;

  /**
   * `stampUpdatedAt` 要用的两个下界的内存缓存（顺序 62）。
   *
   * 每次写入消息/记忆/场景都要判断「新时间戳要比哪些旧值更大」：本机逻辑时钟（meta）
   * 与同步推送水位线（sync state）。以前这两样**每次写入都各读一次库**——
   * 一轮对话里几十次写入就是几十次多余的读。
   *
   * 缓存只在两处会失效：自己写下新时钟（`stampUpdatedAt` 里）、以及同步写完状态
   * （`writeSyncState`）。两处都在这一类里，所以不需要额外的失效钩子。
   */
  private stampCache: { clock: string; watermark: string } | null = null;

  constructor(
    private readonly store: EntityStore,
    private readonly migrations: readonly Migration[] = MIGRATIONS,
  ) {}

  get backendKind(): string {
    return this.store.kind;
  }

  // ---- 本机设备（P2-6） ----

  /**
   * 本机设备号，第一次访问时生成并落进 meta。
   *
   * 为什么要有它：两台设备离线各聊一段，合并后消息的顺序靠
   * `(deviceId, localSeq)` 才稳定——时间戳会被设备时钟搞乱，而房间内
   * 序号两边会各自从 1 开始。
   *
   * 不放进设置面板：用户不需要看见它，也不该被允许改（改了等于换设备）。
   */
  async deviceId(): Promise<string> {
    if (this.deviceIdCache !== null) return this.deviceIdCache;

    const existing = await this.getMeta<string>(META_KEYS.deviceId);
    if (typeof existing === 'string' && existing !== '') {
      this.deviceIdCache = existing;
      return existing;
    }

    const created = newId();
    await this.setMeta(META_KEYS.deviceId, created);
    this.deviceIdCache = created;
    return created;
  }

  // ---- 同步的读口与写口（P2-6 第三步） ----

  /**
   * 同步状态：拉取游标 + 推送点。
   *
   * 换了一个空间就作废重来（`spaceHandle` 对不上时返回空状态）——否则上一个空间的
   * 游标会把这个空间的记录当成「已经拉过了」，用户会看到一片空白。
   */
  async readSyncState(): Promise<SyncState> {
    const stored = await this.getMeta<SyncState>(META_KEYS.syncState);
    return stored ?? EMPTY_SYNC_STATE;
  }

  async writeSyncState(state: SyncState): Promise<void> {
    await this.setMeta(META_KEYS.syncState, state);
    // 水位线变了：下一次盖时间戳必须重新读（顺序 62）
    this.stampCache = null;
  }

  /**
   * 同步读口：白名单里所有集合的记录，**含墓碑**。
   *
   * 与 UI 用的那些 `listX` 不同：这里不过滤删除（墓碑要推给别的设备，
   * 否则对方会把删掉的东西推回来）、不排序（排序是合并之后的事）、
   * 不做业务判断。`since` 是增量：只要 `updatedAt > since` 的。
   */
  async listSyncRecords(options: { since?: string | null } = {}): Promise<LocalSyncRecord[]> {
    const deviceId = await this.deviceId();
    const since = options.since ?? null;
    const out: LocalSyncRecord[] = [];

    for (const collection of SYNC_COLLECTIONS) {
      /*
       * 增量读（顺序 62）：`since` 给了又有索引实现时，只把新写的那几条拿出来；
       * 否则退回整表（语义一致，只是慢）。下面那行 `updatedAt <= since` 的过滤
       * 两种路径都要留着——它是正确性的最后一道，不依赖存储实现是否听话。
       */
      const rows: Array<Record<string, unknown> & { id: string }> =
        since !== null && this.store.listSince !== undefined
          ? await this.store.listSince<Record<string, unknown> & { id: string }>(COLLECTIONS[collection], since)
          : await this.store.list<Record<string, unknown> & { id: string }>(COLLECTIONS[collection]);
      for (const row of rows) {
        const value = collection === 'messages' ? reviveMessage(row as unknown as StoredMessage, deviceId) : row;
        const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : '';
        // 没有时间戳的记录先不参与同步：迁移会补上，硬推出去反而会让对面写进坏数据
        if (updatedAt === '') continue;
        if (since !== null && updatedAt <= since) continue;
        out.push({
          collection,
          id: row.id,
          updatedAt,
          deletedAt: typeof value.deletedAt === 'string' ? value.deletedAt : null,
          value,
        });
      }
    }

    return out.sort((left, right) =>
      left.updatedAt < right.updatedAt ? -1 : left.updatedAt > right.updatedAt ? 1 : 0,
    );
  }

  /** 同步读口：单条（含墓碑）。合并时拿它比 `updatedAt`。 */
  async getSyncRecord(collection: SyncCollection, id: string): Promise<LocalSyncRecord | null> {
    const row = await this.store.get<Record<string, unknown> & { id: string }>(COLLECTIONS[collection], id);
    if (row === null) return null;
    const value =
      collection === 'messages' ? reviveMessage(row as unknown as StoredMessage, await this.deviceId()) : row;
    return {
      collection,
      id,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
      deletedAt: typeof value.deletedAt === 'string' ? value.deletedAt : null,
      value,
    };
  }

  /**
   * 同步写口：把远端那条**原样**落库。
   *
   * 刻意不走 `saveX`：那些方法会重新盖 `updatedAt`（本机时间）并清空 `deletedAt`，
   * 于是「远端删掉的东西」会被我们复活、`updatedAt` 也失去可比性。同步写进来的
   * 记录必须保留原来的坐标——它表达的是**那台设备**的事实。
   */
  async putSyncRecord(record: LocalSyncRecord): Promise<void> {
    const value = record.value;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`同步记录 ${record.collection}/${record.id} 的内容不是一个对象，拒绝落库。`);
    }
    await this.store.put(COLLECTIONS[record.collection], {
      ...(value as Record<string, unknown>),
      id: record.id,
      updatedAt: record.updatedAt,
      deletedAt: record.deletedAt,
    });
  }

  // ---- 软删除与默认过滤（P2-6） ----

  /**
   * 软删除：把 `deletedAt` 与 `updatedAt` 一起盖章，记录本身留着。
   *
   * 为什么要留：同步的另一台设备手里还有这条记录，硬删之后它会当成
   * 「本地新数据」再推回来——用户会看到删掉的东西自己复活。墓碑还必须
   * 带上 `updatedAt`，否则冲突判定（LWW）分不出「删除」和「没改过」。
   *
   * 幂等：已经删过的记录不再重复盖章，免得把一个旧墓碑的时间推到当下。
   */
  private async softDelete(collection: string, id: string, at: string = nowIso()): Promise<void> {
    const record = await this.store.get<{ id: string; deletedAt?: string | null }>(collection, id);
    if (record === null || !isAlive(record)) return;
    const updatedAt = await this.stampUpdatedAt(collection, id, at);
    /*
     * 凭据类集合的墓碑**只留坐标**（顺序 61，与 `deletePersona` 一致）。
     *
     * 墓碑的用途只有一条：告诉别的设备「这条没了」。可 `softDelete` 原本把整条原样写回，
     * 于是删掉的 API Key 密文仍然躺在本地库里、并且会**随同步推到服务端**——
     * 删除之后密文还在原地多存一份，没有任何一层需要它。
     */
    if (collection === COLLECTIONS.providerCredentials) {
      const providerId = (record as { providerId?: unknown }).providerId;
      await this.store.put(collection, {
        id,
        providerId: typeof providerId === 'string' ? providerId : '',
        updatedAt,
        deletedAt: updatedAt,
      });
      return;
    }
    await this.store.put(collection, { ...record, id, deletedAt: updatedAt, updatedAt });
  }

  /**
   * 给这条记录盖一个**严格递增**的 `updatedAt`（P2-6 第三步的协议要求）。
   *
   * 为什么不能只用 `nowIso()`：同一个毫秒里改两次是常事（后台任务与界面同帧写入），
   * 而 `updatedAt` 有两个身份——LWW 的比较依据，以及记录密文 AAD 的一部分
   * （见 SYNC §4.4）。要是两次写入撞上同一个时间戳，两件事都会退化：
   * 「谁最后改的」分不出来，密文也不再能区分版本。
   *
   * 取三个下限里最大的那个，再加 1 ms（如果撞上）：
   *
   * 1. **这条记录的旧时间**：不能倒退（LWW 与 AAD 都要它往前走）；
   * 2. **本机逻辑时钟**（meta）：让全库的时间戳单调，而不是每条记录各自为政；
   * 3. **同步推送水位线**：新写入必须大于「已经推出去过的时间」，否则
   *    `updatedAt > 水位线` 筛不出来，那条数据会永远推不出去。水位线可能来自
   *    另一台时钟偏快的设备，所以这条尤其重要。
   *
   * 代价是时间戳可能明显超前于墙钟——这是逻辑时钟的常规代价，换来的是
   * 「每条写入都能被同步到」这个硬保证。
   */
  private async stampUpdatedAt(collection: string, id: string, at: string = nowIso()): Promise<string> {
    const existing = await this.store.get<{ updatedAt?: string }>(collection, id);
    const previous = typeof existing?.updatedAt === 'string' ? existing.updatedAt : '';
    /*
     * 逻辑时钟与推送水位线走内存缓存（顺序 62）：它们在一次会话里几乎不变，
     * 而每一次写入都要用。缓存没命中的时候才读库（各一次）。
     */
    let cache = this.stampCache;
    if (cache === null) {
      cache = {
        clock: (await this.getMeta<string>(META_KEYS.clock)) ?? '',
        watermark: (await this.readSyncState()).pushedAt ?? '',
      };
      this.stampCache = cache;
    }
    const localClock = cache.clock;
    const watermark = cache.watermark;

    let candidate = at;
    for (const floor of [previous, localClock, watermark]) {
      if (floor === '' || candidate > floor) continue;
      const parsed = Date.parse(floor);
      candidate = Number.isNaN(parsed) ? at : new Date(parsed + 1).toISOString();
    }

    await this.setMeta(META_KEYS.clock, candidate);
    this.stampCache = { ...cache, clock: candidate };
    return candidate;
  }

  /** 查询默认口径：软删除的记录不返回。`includeDeleted` 是给同步与诊断用的后门。 */
  private async listAlive<T extends { id: string; deletedAt?: string | null }>(
    collection: string,
    query?: EntityQuery,
  ): Promise<T[]> {
    return aliveOnly(await this.store.list<T>(collection, query));
  }

  private async getAlive<T extends { deletedAt?: string | null }>(collection: string, id: string): Promise<T | null> {
    const record = await this.store.get<T>(collection, id);
    return record !== null && isAlive(record) ? record : null;
  }

  private async countAlive(collection: string, where?: Record<string, unknown>): Promise<number> {
    /*
     * 用 `count` 而不是「`list` 全读回来再数」（顺序 62）。
     *
     * 两件事一起改：
     * 1. `count` 把 `deletedAt: null` 交给存储层——带索引的实现只需要数一数，
     *    不必把 600 条消息的对象都反序列化出来；
     * 2. `listRooms` 每个世界要数三次（消息 / 角色 / 对话），600 条消息的对话
     *    以前就是每次 600 个对象的克隆。
     *
     * 语义没变：`matchesWhere` 把 `null` 与 `undefined` 视为等价，所以没写过
     * `deletedAt` 的老记录照样算「活着」。
     */
    return this.store.count(collection, { ...(where ?? {}), deletedAt: null });
  }

  // ---- meta ----

  async getMeta<T>(key: string): Promise<T | null> {
    const record = await this.store.get<MetaRecord>(COLLECTIONS.meta, key);
    return record === null ? null : (record.value as T);
  }

  async setMeta<T>(key: string, value: T): Promise<void> {
    await this.store.put<MetaRecord>(COLLECTIONS.meta, { id: key, value, updatedAt: nowIso() });
  }

  async schemaVersion(): Promise<number> {
    return (await this.getMeta<number>(META_KEYS.schemaVersion)) ?? 0;
  }

  async migrate(): Promise<MigrationReport> {
    const from = await this.schemaVersion();
    if (from >= SCHEMA_VERSION) {
      return { from, to: from, applied: [] };
    }

    const applied: Migration[] = [];
    const ordered = [...this.migrations].sort((a, b) => a.version - b.version);
    for (const migration of ordered) {
      if (migration.version <= from) continue;
      await migration.run(this.store);
      applied.push(migration);
    }

    await this.setMeta(META_KEYS.schemaVersion, SCHEMA_VERSION);
    return { from, to: SCHEMA_VERSION, applied };
  }

  // ---- 房间 ----

  async saveRoom(room: Room): Promise<void> {
    const updatedAt = await this.stampUpdatedAt(COLLECTIONS.rooms, room.id);
    await this.store.put(COLLECTIONS.rooms, { ...room, updatedAt, deletedAt: null });
  }

  async getRoom(id: RoomId): Promise<Room | null> {
    return this.getAlive<Room>(COLLECTIONS.rooms, id);
  }

  async listRooms(): Promise<RoomSummary[]> {
    const rooms = await this.listAlive<Room>(COLLECTIONS.rooms, {
      orderBy: 'updatedAt',
      direction: 'desc',
    });

    const summaries: RoomSummary[] = [];
    for (const room of rooms) {
      summaries.push({
        id: room.id,
        title: room.title,
        updatedAt: room.updatedAt,
        messageCount: await this.countAlive(COLLECTIONS.messages, { roomId: room.id }),
        instanceCount: await this.countAlive(COLLECTIONS.instances, { roomId: room.id }),
        conversationCount: await this.countAlive(COLLECTIONS.conversations, { roomId: room.id }),
      });
    }
    return summaries;
  }

  /**
   * 删除房间，并级联删除它的场景、角色实例与消息。
   *
   * 角色卡与世界书**不删**——它们是可被多个房间共用的资产，
   * 删掉一个房间不应该连带毁掉用户导入的素材。
   *
   * 级联出去的都是**软删除**（P2-6）：世界、对话、场景、角色、消息、记忆、
   * 章节全部留墓碑，这样另一台设备同步时才知道这些东西是被删了，而不是
   * 自己这边缺了几条。例外是队列与账单——它们不参与同步，而且是本机事实，
   * 硬删掉即可。
   */
  async deleteRoom(id: RoomId): Promise<void> {
    const at = nowIso();
    const conversations = await this.listAlive<Conversation>(COLLECTIONS.conversations, { where: { roomId: id } });
    const scenes = await this.listAlive<Scene>(COLLECTIONS.scenes, { where: { roomId: id } });
    const instances = await this.listAlive<CharacterInstance>(COLLECTIONS.instances, { where: { roomId: id } });
    const messages = await this.listAlive<Message>(COLLECTIONS.messages, { where: { roomId: id } });
    const memories = await this.listAlive<MemoryEvent>(COLLECTIONS.memories, { where: { roomId: id } });
    const chapters = await this.listAlive<ChapterSummary>(COLLECTIONS.chapterSummaries, {
      where: { roomId: id },
    });
    // 后台任务也要清掉：留下指向已删除房间的任务，只会在下次启动时反复失败
    const tasks = await this.store.list<{ id: string }>(COLLECTIONS.backgroundTasks, { where: { roomId: id } });
    // 账单跟着世界走：世界没了，账也就没有归属了。归档对话则**不**回滚账单——
    // 时间线可以当作没发生过，钱不行
    const usage = await this.store.list<{ id: string }>(COLLECTIONS.usageRecords, { where: { roomId: id } });

    for (const conversation of conversations) await this.softDelete(COLLECTIONS.conversations, conversation.id, at);
    for (const scene of scenes) await this.softDelete(COLLECTIONS.scenes, scene.id, at);
    for (const instance of instances) await this.softDelete(COLLECTIONS.instances, instance.id, at);
    for (const message of messages) await this.softDelete(COLLECTIONS.messages, message.id, at);
    for (const memory of memories) await this.softDelete(COLLECTIONS.memories, memory.id, at);
    for (const chapter of chapters) await this.softDelete(COLLECTIONS.chapterSummaries, chapter.id, at);
    for (const task of tasks) await this.store.remove(COLLECTIONS.backgroundTasks, task.id);
    for (const record of usage) await this.store.remove(COLLECTIONS.usageRecords, record.id);
    await this.softDelete(COLLECTIONS.rooms, id, at);
  }

  // ---- 对话（LAYOUT：世界 = 项目，一个世界下可以开多个对话） ----

  async saveConversation(conversation: Conversation): Promise<void> {
    const updatedAt = await this.stampUpdatedAt(COLLECTIONS.conversations, conversation.id);
    await this.store.put(COLLECTIONS.conversations, { ...conversation, updatedAt, deletedAt: null });
  }

  async getConversation(id: ConversationId): Promise<Conversation | null> {
    return this.getAlive<Conversation>(COLLECTIONS.conversations, id);
  }

  /**
   * 世界下的对话，默认不含已归档的。
   *
   * 归档后的对话不在主列表里（LAYOUT），所以默认过滤掉；设置面板需要
   * 列出它们时显式传 `includeArchived`。
   */
  async listConversations(roomIdValue: RoomId, options: { includeArchived?: boolean } = {}): Promise<Conversation[]> {
    const all = await this.store.list<Conversation>(COLLECTIONS.conversations, {
      where: { roomId: roomIdValue },
      orderBy: 'createdAt',
      direction: 'asc',
    });
    const alive = aliveOnly(all);
    return options.includeArchived === true ? alive : alive.filter((conversation) => conversation.archivedAt === null);
  }

  /** 删掉一条对话：场景、消息、记忆一起走（都是软删除），角色与世界书保留。 */
  async deleteConversation(id: ConversationId): Promise<void> {
    const conversation = await this.getConversation(id);
    if (!conversation) return;

    const at = nowIso();
    const scenes = await this.listAlive<Scene>(COLLECTIONS.scenes, { where: { conversationId: id } });
    const messages = await this.listAlive<Message>(COLLECTIONS.messages, { where: { conversationId: id } });
    const memories = await this.listAlive<MemoryEvent>(COLLECTIONS.memories, { where: { conversationId: id } });
    const chapters = await this.listAlive<ChapterSummary>(COLLECTIONS.chapterSummaries, {
      where: { conversationId: id },
    });

    for (const scene of scenes) await this.softDelete(COLLECTIONS.scenes, scene.id, at);
    for (const message of messages) await this.softDelete(COLLECTIONS.messages, message.id, at);
    for (const memory of memories) await this.softDelete(COLLECTIONS.memories, memory.id, at);
    for (const chapter of chapters) await this.softDelete(COLLECTIONS.chapterSummaries, chapter.id, at);
    await this.softDelete(COLLECTIONS.conversations, id, at);

    const room = await this.getRoom(conversation.roomId);
    if (room?.activeConversationId === id) {
      const remaining = await this.listConversations(conversation.roomId);
      await this.saveRoom({ ...room, activeConversationId: remaining[0]?.id ?? null, updatedAt: nowIso() });
    }
  }

  /**
   * 归档一条对话（LAYOUT「归档对话」）。
   *
   * 语义是「这条时间线没有发生过」：情绪、关系与记忆**回滚到该对话开始之前**，
   * 但对话本身被保留，改为从设置里打开回顾。所以这里不是删除，
   * 而是「标记 + 还原 + 清掉这条线产生的记忆」。
   *
   * 幂等：重复归档不会再次回滚，也不会把已经改过的状态再擦一遍。
   */
  async archiveConversation(id: ConversationId, options: { at?: string } = {}): Promise<ArchiveReport | null> {
    const conversation = await this.getConversation(id);
    if (!conversation) return null;

    const at = options.at ?? nowIso();
    if (conversation.archivedAt !== null) {
      const room = await this.getRoom(conversation.roomId);
      return {
        conversationId: conversation.id,
        restoredInstances: 0,
        removedMemories: 0,
        removedChapters: 0,
        nextConversationId: room?.activeConversationId ?? null,
      };
    }

    const instances = await this.listInstances(conversation.roomId);
    const restored = restoreInstancesFromSnapshot(instances, conversation.stateSnapshot, at);
    let restoredInstances = 0;
    for (let index = 0; index < restored.length; index += 1) {
      const next = restored[index];
      const before = instances[index];
      if (!next || !before) continue;
      // 状态没变就不写库：归档一条从头到尾没改过任何状态的空对话，
      // 不该在实例上留下「刚刚更新过」的痕迹
      if (JSON.stringify([next.affect, next.relationships]) === JSON.stringify([before.affect, before.relationships])) {
        continue;
      }
      await this.saveInstance(next);
      restoredInstances += 1;
    }

    const removedMemories = await this.deleteMemoriesByConversation(conversation.id);
    // 章节摘要也是「这条线发生过的事」，归档一并收走
    const removedChapters = await this.deleteChapterSummariesByConversation(conversation.id);
    await this.store.put(COLLECTIONS.conversations, { ...conversation, archivedAt: at, updatedAt: at });

    const room = await this.getRoom(conversation.roomId);
    let nextConversationId = room?.activeConversationId ?? null;
    if (room && room.activeConversationId === conversation.id) {
      const remaining = await this.listConversations(conversation.roomId);
      nextConversationId = remaining[0]?.id ?? null;
      await this.saveRoom({ ...room, activeConversationId: nextConversationId, updatedAt: at });
    }

    return {
      conversationId: conversation.id,
      restoredInstances,
      removedMemories,
      removedChapters,
      nextConversationId,
    };
  }

  // ---- 场景 ----

  async saveScene(scene: Scene): Promise<void> {
    const updatedAt = await this.stampUpdatedAt(COLLECTIONS.scenes, scene.id);
    await this.store.put(COLLECTIONS.scenes, { ...scene, updatedAt, deletedAt: null });
  }

  async getScene(id: SceneId): Promise<Scene | null> {
    return this.getAlive<Scene>(COLLECTIONS.scenes, id);
  }

  async listScenes(roomId: RoomId): Promise<Scene[]> {
    return this.listAlive<Scene>(COLLECTIONS.scenes, {
      where: { roomId },
      orderBy: 'createdAt',
      direction: 'asc',
    });
  }

  // ---- 角色实例 ----

  async saveInstance(instance: CharacterInstance): Promise<void> {
    const updatedAt = await this.stampUpdatedAt(COLLECTIONS.instances, instance.id);
    await this.store.put(COLLECTIONS.instances, { ...instance, updatedAt, deletedAt: null });
  }

  async listInstances(roomId: RoomId): Promise<CharacterInstance[]> {
    return this.listAlive<CharacterInstance>(COLLECTIONS.instances, { where: { roomId } });
  }

  /** 删除角色实例。角色卡是共用资产，不跟着删。 */
  async deleteInstance(id: string): Promise<void> {
    await this.softDelete(COLLECTIONS.instances, id);
  }

  // ---- 角色卡与世界书（跨房间共用） ----

  async saveCard(card: Card): Promise<void> {
    const updatedAt = await this.stampUpdatedAt(COLLECTIONS.cards, card.id);
    await this.store.put(COLLECTIONS.cards, { ...card, updatedAt, deletedAt: null });
  }

  async getCard(id: CardId): Promise<Card | null> {
    return this.getAlive<Card>(COLLECTIONS.cards, id);
  }

  async listCards(): Promise<Card[]> {
    return this.listAlive<Card>(COLLECTIONS.cards, { orderBy: 'name' });
  }

  async deleteCard(id: CardId): Promise<void> {
    await this.softDelete(COLLECTIONS.cards, id);
  }

  async saveWorldBook(book: WorldBook): Promise<void> {
    const updatedAt = await this.stampUpdatedAt(COLLECTIONS.worldBooks, book.id);
    await this.store.put(COLLECTIONS.worldBooks, { ...book, updatedAt, deletedAt: null });
  }

  async getWorldBook(id: WorldBookId): Promise<WorldBook | null> {
    return this.getAlive<WorldBook>(COLLECTIONS.worldBooks, id);
  }

  async listWorldBooks(): Promise<WorldBook[]> {
    return this.listAlive<WorldBook>(COLLECTIONS.worldBooks, { orderBy: 'name' });
  }

  async deleteWorldBook(id: WorldBookId): Promise<void> {
    await this.softDelete(COLLECTIONS.worldBooks, id);
  }

  // ---- 消息 ----

  /**
   * 追加消息并分配房间内单调递增的 `localSeq`，同时盖上本机 `deviceId`。
   *
   * 不依赖时间戳排序：同一毫秒内落盘的多条消息必须仍有稳定顺序，
   * 这是跨设备合并的前提。
   *
   * 计数器键从 `seq:<room>` 改名成 `localSeq:<room>`；老键仍然认（迁移 v6
   * 会搬过去），另外计数器万一丢了就按库里已有的最大号续上——宁可跳号，
   * 也不能把号码发重（发重了排序就不稳定了）。
   */
  async appendMessages(roomId: RoomId, messages: readonly Message[]): Promise<Message[]> {
    const deviceId = await this.deviceId();
    const counterKey = `localSeq:${roomId}`;
    let next = await this.getMeta<number>(counterKey);
    if (next === null) next = await this.getMeta<number>(`seq:${roomId}`);
    if (next === null) {
      const existing = await this.store.list<StoredMessage>(COLLECTIONS.messages, { where: { roomId } });
      next = existing.reduce((max, item) => Math.max(max, localSeqOf(item)), 0);
    }

    const stamped: Message[] = [];
    for (const message of messages) {
      next += 1;
      // 老封存文件里可能还带着 `seq`：丢掉它，库里只留 `localSeq` 一个名字
      const { seq: _legacySeq, ...rest } = message as StoredMessage;
      const updatedAt = await this.stampUpdatedAt(COLLECTIONS.messages, message.id);
      stamped.push({ ...rest, roomId, localSeq: next, deviceId, updatedAt, deletedAt: null });
    }

    await this.store.bulkPut(COLLECTIONS.messages, stamped);
    await this.setMeta(counterKey, next);
    return stamped;
  }

  /**
   * 返回最近 `limit` 条消息，按时间正序。
   *
   * 传了 `conversationId` 就只取那条对话的消息——主对话与副对话是两条
   * 独立记录，混在一起会让管理员的草稿出现在角色的剧情里。
   *
   * 排序用 `localSeq`（P2-6 之前的记录只有 `seq`，读的时候现归一），
   * 所以这里不把排序交给存储层：老字段排不出正确的顺序。
   *
   * 合并之后一个房间里的消息来自多台设备，各自的 `localSeq` 会撞号（都从 1 开始），
   * 所以总序是 **`createdAt` → `deviceId` → `localSeq`**：时间给出人看着自然的
   * 先后，后两级保证同毫秒也有确定顺序。设备时钟不准时顺序会歪——这是 SYNC §4.2
   * 记下的已知代价（换向量时钟不值）。
   */
  async listMessages(
    roomId: RoomId,
    options: { limit?: number; conversationId?: ConversationId; includeDeleted?: boolean } = {},
  ): Promise<Message[]> {
    const where: Record<string, unknown> = { roomId };
    if (options.conversationId !== undefined) where.conversationId = options.conversationId;

    // 老记录没有设备号：按本机补，而不是漏成空串——「这条消息是谁写的」
    // 在跨设备排序里是必需信息。第一次读会顺手把本机设备号建出来。
    const deviceId = await this.deviceId();
    const stored = await this.store.list<StoredMessage>(COLLECTIONS.messages, { where });
    const ordered = stored
      .map((item) => reviveMessage(item, deviceId))
      .sort((left, right) => {
        if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
        if (left.deviceId !== right.deviceId) return left.deviceId < right.deviceId ? -1 : 1;
        return left.localSeq - right.localSeq;
      });
    // 软删除必须在**分页之前**过滤：先取 limit 条再过滤的话，被删掉的那条
    // 会白占一个名额，用户会看到历史凭空少一截
    const alive = options.includeDeleted === true ? ordered : aliveOnly(ordered);
    const limit = options.limit;
    return limit === undefined ? alive : alive.slice(Math.max(0, alive.length - limit));
  }

  /** 读一条消息（软删除的不返回），老记录在这里归一。 */
  private async getMessage(id: MessageId): Promise<Message | null> {
    const raw = await this.store.get<StoredMessage>(COLLECTIONS.messages, id);
    if (raw === null || !isAlive(raw)) return null;
    return reviveMessage(raw, this.deviceIdCache ?? '');
  }

  async updateMessage(id: MessageId, patch: Partial<Message>): Promise<Message | null> {
    const existing = await this.getMessage(id);
    if (!existing) return null;
    const updated = {
      ...existing,
      ...patch,
      id: existing.id,
      roomId: existing.roomId,
      localSeq: existing.localSeq,
      deviceId: existing.deviceId,
      updatedAt: await this.stampUpdatedAt(COLLECTIONS.messages, id),
      deletedAt: null,
    };
    await this.store.put(COLLECTIONS.messages, updated);
    return updated;
  }

  /** 删除单条消息，用于消息编辑与重抽（P0-7）。 */
  async deleteMessage(id: MessageId): Promise<void> {
    await this.softDelete(COLLECTIONS.messages, id);
  }

  /**
   * 采纳一条管理员草稿：把草稿内容真正写进素材库。
   *
   * 「采纳」是用户的动作，所以草稿在起草时只挂在消息上；只有走到这里
   * 才会出现一张新的角色卡或一本新的世界书。已经处理过的草稿不会被
   * 二次采纳——重复点击不该产生第二份一模一样的素材。
   */
  async adoptAdminArtifact(
    messageId: MessageId,
    artifactId: string,
  ): Promise<{ message: Message; artifact: AdminArtifact | null } | null> {
    const message = await this.getMessage(messageId);
    if (!message || message.artifacts === undefined) return null;

    const target = message.artifacts.find((item) => item.id === artifactId);
    if (target?.status !== 'pending') return { message, artifact: target ?? null };

    let targetId: string | null = null;
    if (target.kind === 'character-card') {
      const card = target.payload as Card;
      await this.saveCard(card);
      targetId = card.id;
    } else if (target.kind === 'world-book') {
      const book = target.payload as WorldBook;
      await this.saveWorldBook(book);
      targetId = book.id;
    } else if (target.kind === 'persona-upsert') {
      const persona = target.payload as Persona;
      await this.savePersona(persona);
      targetId = persona.id;
    } else if (target.kind === 'persona-delete') {
      const payload = target.payload as { id?: unknown };
      const id = typeof payload.id === 'string' ? payload.id : target.targetId;
      if (id !== null) {
        await this.deletePersona(id);
        targetId = id;
      }
    } else {
      targetId = target.targetId;
    }

    const adopted: AdminArtifact = { ...target, status: 'adopted', targetId };
    const updated: Message = {
      ...message,
      artifacts: message.artifacts.map((item) => (item.id === artifactId ? adopted : item)),
      updatedAt: await this.stampUpdatedAt(COLLECTIONS.messages, messageId),
      deletedAt: null,
    };
    await this.store.put(COLLECTIONS.messages, updated);
    return { message: updated, artifact: adopted };
  }

  /** 丢弃一条草稿：只改状态，不删记录——用户可能过一会儿又想要它。 */
  async discardAdminArtifact(messageId: MessageId, artifactId: string): Promise<Message | null> {
    const message = await this.getMessage(messageId);
    if (!message || message.artifacts === undefined) return null;

    const updated: Message = {
      ...message,
      artifacts: message.artifacts.map((item) =>
        item.id === artifactId && item.status === 'pending' ? { ...item, status: 'discarded' } : item,
      ),
      updatedAt: await this.stampUpdatedAt(COLLECTIONS.messages, messageId),
      deletedAt: null,
    };
    await this.store.put(COLLECTIONS.messages, updated);
    return updated;
  }

  /**
   * 撤回一条已经采纳的草稿（顺序 26）。
   *
   * 「采纳之后就只能认了」是一种很危险的错觉：管理员起草的卡/世界书有好有坏，
   * 采纳之后才发现「这条跟世界不合」是常事。所以给一条退路：**删掉刚进素材库的那份**，
   * 把草稿退回「待采纳」——不是把草稿本身删掉（那才是真的丢东西）。
   *
   * 三条约束：
   * 1. 只认 `adopted`；`applied`（场景类草稿已经落到对话上）不走这条路——
   *    场景切换有剧情后果，这一项不假装能撤。
   * 2. 删的就是这次采纳创建的那个 `targetId`。「撤回这次采纳」在语义上等于
   *    「当它没发生过」，所以用户之后改过的同一份也一并删掉。
   * 3. 幂等：已经撤回过的、或者压根没落过库的，不报错，点两次结果一样。
   */
  async revokeAdminArtifact(
    messageId: MessageId,
    artifactId: string,
  ): Promise<{ message: Message; artifact: AdminArtifact | null } | null> {
    const message = await this.getMessage(messageId);
    if (!message || message.artifacts === undefined) return null;

    const target = message.artifacts.find((item) => item.id === artifactId);
    if (target === undefined) return { message, artifact: null };
    if (target.status !== 'adopted') return { message, artifact: target };

    if (target.kind === 'character-card' && target.targetId !== null) {
      await this.deleteCard(target.targetId as CardId);
    } else if (target.kind === 'world-book' && target.targetId !== null) {
      await this.deleteWorldBook(target.targetId as WorldBookId);
    } else if (target.kind === 'persona-upsert' && target.targetId !== null) {
      if (target.previousPayload !== undefined) {
        await this.savePersona(target.previousPayload as Persona);
      } else {
        await this.deletePersona(target.targetId);
      }
    }

    const reverted: AdminArtifact = { ...target, status: 'pending', targetId: null };
    const updated: Message = {
      ...message,
      artifacts: message.artifacts.map((item) => (item.id === artifactId ? reverted : item)),
      updatedAt: await this.stampUpdatedAt(COLLECTIONS.messages, messageId),
      deletedAt: null,
    };
    await this.store.put(COLLECTIONS.messages, updated);
    return { message: updated, artifact: reverted };
  }

  /** 删除某个回合产生的全部消息，用于重抽（P0-7）。返回删除数量。 */
  async removeMessagesByTurn(roomId: RoomId, turnId: string): Promise<number> {
    const messages = await this.listAlive<Message>(COLLECTIONS.messages, {
      where: { roomId, turnId },
    });
    for (const message of messages) {
      await this.softDelete(COLLECTIONS.messages, message.id);
    }
    return messages.length;
  }

  // ---- 聚合 ----

  async loadRoom(roomId: RoomId): Promise<RoomSnapshot | null> {
    const room = await this.getRoom(roomId);
    if (!room) return null;

    const conversations = await this.listConversations(roomId, { includeArchived: true });
    const scenes = await this.listScenes(roomId);
    const instances = await this.listInstances(roomId);
    const messages = await this.listMessages(roomId);

    const cards: Card[] = [];
    for (const cardIdValue of room.cardIds) {
      const card = await this.getCard(cardIdValue);
      if (card) cards.push(card);
    }

    const worldBooks: WorldBook[] = [];
    for (const bookId of room.worldBookIds) {
      const book = await this.getWorldBook(bookId);
      if (book) worldBooks.push(book);
    }

    const personas = await this.listPersonas();
    const memories = await this.listMemories(roomId);
    const chapters = await this.listChapterSummaries(roomId);
    return { room, conversations, scenes, instances, cards, worldBooks, messages, memories, chapters, personas };
  }

  // ---- 玩家身份（P0-3） ----

  // ---- 记忆（P1） ----

  async listMemories(roomId: RoomId, options: { conversationId?: ConversationId } = {}): Promise<MemoryEvent[]> {
    const where: Record<string, unknown> = { roomId };
    if (options.conversationId !== undefined) where.conversationId = options.conversationId;

    return this.listAlive<MemoryEvent>(COLLECTIONS.memories, {
      where,
      orderBy: 'createdAt',
      direction: 'desc',
    });
  }

  /**
   * 删除一条对话产生的全部记忆，用于归档。
   *
   * 「回滚到该对话开始之前」不能靠时间戳判断：同一次重抽、跨场景、自动
   * 补做的后台任务都会让时间戳错位。归属字段是唯一可靠的依据。
   */
  async deleteMemoriesByConversation(id: ConversationId): Promise<number> {
    const events = await this.listAlive<MemoryEvent>(COLLECTIONS.memories, { where: { conversationId: id } });
    for (const event of events) {
      await this.softDelete(COLLECTIONS.memories, event.id);
    }
    return events.length;
  }

  async saveMemories(events: readonly MemoryEvent[]): Promise<void> {
    const stamped: MemoryEvent[] = [];
    for (const event of events) {
      const updatedAt = await this.stampUpdatedAt(COLLECTIONS.memories, event.id);
      stamped.push({ ...event, updatedAt, deletedAt: null });
    }
    await this.store.bulkPut(COLLECTIONS.memories, stamped);
  }

  /**
   * 只更新「这条记忆被回想过了」的两个字段（顺序 27a 演练里补的）。
   *
   * 为什么不能沿用 `saveMemories`：调用方（回想之后记账那一步）手里拿的是
   * **装配提示词时读到的那份拷贝**，而中间隔了一次模型调用——这期间可能有别的写
   * 动过同一条记忆（记忆合并给它盖了「已被取代」的章、用户改了重要度）。
   * 把整条旧拷贝写回去会**静默抹掉那些改动**：演练里 20 条盖章只剩 9 条，
   * 就是被这一步覆盖的。
   *
   * 所以这里先**读最新的**、再只改那两个字段。代价是每条多一次读——
   * 回想记账一轮只有几条，值。
   */
  async markMemoriesRecalled(ids: readonly EventId[], at: string): Promise<MemoryEvent[]> {
    const updated: MemoryEvent[] = [];
    for (const id of ids) {
      const existing = await this.getAlive<MemoryEvent>(COLLECTIONS.memories, id);
      if (existing === null) continue;
      const next: MemoryEvent = {
        ...existing,
        lastRecalledAt: at,
        recallCount: existing.recallCount + 1,
        updatedAt: await this.stampUpdatedAt(COLLECTIONS.memories, id),
      };
      await this.store.put(COLLECTIONS.memories, next);
      updated.push(next);
    }
    return updated;
  }

  // ---- 分层摘要（P1-5） ----

  /**
   * 章节摘要：几场戏滚成一条线索。
   *
   * 单独一个集合而不是挂在场景上：一章跨好几场戏，场景被换掉、被删掉时
   * 这一章仍然成立——它记录的是一段已经发生过的历史。
   */
  async listChapterSummaries(
    roomId: RoomId,
    options: { conversationId?: ConversationId } = {},
  ): Promise<ChapterSummary[]> {
    const where: Record<string, unknown> = { roomId };
    if (options.conversationId !== undefined) where.conversationId = options.conversationId;

    return this.listAlive<ChapterSummary>(COLLECTIONS.chapterSummaries, {
      where,
      orderBy: 'createdAt',
      direction: 'asc',
    });
  }

  async saveChapterSummary(chapter: ChapterSummary): Promise<void> {
    const updatedAt = await this.stampUpdatedAt(COLLECTIONS.chapterSummaries, chapter.id);
    await this.store.put(COLLECTIONS.chapterSummaries, { ...chapter, updatedAt, deletedAt: null });
  }

  /** 删除一条对话产生的章节摘要，用于归档与彻底删除。 */
  async deleteChapterSummariesByConversation(id: ConversationId): Promise<number> {
    const chapters = await this.listAlive<ChapterSummary>(COLLECTIONS.chapterSummaries, {
      where: { conversationId: id },
    });
    for (const chapter of chapters) {
      await this.softDelete(COLLECTIONS.chapterSummaries, chapter.id);
    }
    return chapters.length;
  }

  async updateMemory(id: EventId, patch: Partial<MemoryEvent>): Promise<MemoryEvent | null> {
    const existing = await this.getAlive<MemoryEvent>(COLLECTIONS.memories, id);
    if (!existing) return null;

    const updated: MemoryEvent = {
      ...existing,
      ...patch,
      id: existing.id,
      roomId: existing.roomId,
      sourceTurnIds: existing.sourceTurnIds,
      updatedAt: await this.stampUpdatedAt(COLLECTIONS.memories, id),
      deletedAt: null,
    };
    await this.store.put(COLLECTIONS.memories, updated);
    return updated;
  }

  async deleteMemory(id: EventId): Promise<void> {
    await this.softDelete(COLLECTIONS.memories, id);
  }

  /**
   * 删除某个回合产生的全部记忆，用于重抽与消息删除（P0-7 的回滚）。
   *
   * 按 `sourceTurnIds` 判断而不是按时间——一条记忆可能由多轮对话共同产生，
   * 只要它引用了被撤销的回合，就该跟着作废。
   */
  async deleteMemoriesByTurn(roomId: RoomId, turnId: string): Promise<number> {
    const events = await this.listAlive<MemoryEvent>(COLLECTIONS.memories, { where: { roomId } });
    const affected = events.filter((event) => event.sourceTurnIds.includes(turnId));
    for (const event of affected) {
      await this.softDelete(COLLECTIONS.memories, event.id);
    }
    return affected.length;
  }

  /** 房间内单调递增的记忆序号，用于时间线排序。 */
  async nextMemorySequence(roomId: RoomId): Promise<number> {
    const key = `memorySeq:${roomId}`;
    const next = ((await this.getMeta<number>(key)) ?? 0) + 1;
    await this.setMeta(key, next);
    return next;
  }

  async listPersonas(): Promise<Persona[]> {
    return this.listAlive<Persona>(COLLECTIONS.personas, { orderBy: 'createdAt' });
  }

  async getPersona(id: string): Promise<Persona | null> {
    return this.getAlive<Persona>(COLLECTIONS.personas, id);
  }

  async savePersona(persona: Persona): Promise<void> {
    const updatedAt = await this.stampUpdatedAt(COLLECTIONS.personas, persona.id);
    await this.store.put(COLLECTIONS.personas, { ...persona, updatedAt, deletedAt: null });
  }

  /**
   * 彻底删除 Persona（账户重构 A8）。
   *
   * 用户可见的数据全部清掉：房间与对话只解除 personaId 引用，保留各自已经
   * 写好的 name/description 快照，旧历史不会失去“玩家是谁”。同步层仍会
   * 保留一条只含 id / updatedAt / deletedAt 的墓碑，防止别的设备把内容推回来。
   */
  async deletePersona(id: string): Promise<number> {
    const persona = await this.getAlive<Persona>(COLLECTIONS.personas, id);
    if (persona === null) return 0;

    const rooms = await this.listAlive<Room>(COLLECTIONS.rooms, { where: { personaId: id } });
    for (const room of rooms) {
      await this.saveRoom({ ...room, personaId: null });
    }
    const conversations = await this.listAlive<Conversation>(COLLECTIONS.conversations, { where: { personaId: id } });
    for (const conversation of conversations) {
      await this.saveConversation({ ...conversation, personaId: null });
    }

    const updatedAt = await this.stampUpdatedAt(COLLECTIONS.personas, id);
    await this.store.put(COLLECTIONS.personas, { id, updatedAt, deletedAt: updatedAt });
    return 1;
  }

  async saveSnapshot(snapshot: {
    room?: Room;
    conversations?: readonly Conversation[];
    scenes?: readonly Scene[];
    instances?: readonly CharacterInstance[];
    cards?: readonly Card[];
    worldBooks?: readonly WorldBook[];
  }): Promise<void> {
    if (snapshot.room) await this.saveRoom(snapshot.room);
    if (snapshot.conversations)
      for (const conversation of snapshot.conversations) await this.saveConversation(conversation);
    if (snapshot.scenes) for (const scene of snapshot.scenes) await this.saveScene(scene);
    if (snapshot.instances) for (const instance of snapshot.instances) await this.saveInstance(instance);
    if (snapshot.cards) for (const card of snapshot.cards) await this.saveCard(card);
    if (snapshot.worldBooks) for (const book of snapshot.worldBooks) await this.saveWorldBook(book);
  }

  // ---- 模型服务配置（P0-8） ----

  async listProviderProfiles(): Promise<ProviderProfile[]> {
    return this.listAlive<ProviderProfile>(COLLECTIONS.providerProfiles, { orderBy: 'createdAt' });
  }

  async saveProviderProfile(profile: ProviderProfile): Promise<void> {
    const updatedAt = await this.stampUpdatedAt(COLLECTIONS.providerProfiles, profile.id);
    await this.store.put(COLLECTIONS.providerProfiles, { ...profile, updatedAt, deletedAt: null });
  }

  async deleteProviderProfile(id: string): Promise<void> {
    const credentials = await this.listProviderCredentials();
    for (const credential of credentials.filter((item) => item.providerId === id)) {
      await this.softDelete(COLLECTIONS.providerCredentials, credential.id);
    }
    await this.softDelete(COLLECTIONS.providerProfiles, id);
  }

  async listProviderCredentials(): Promise<ProviderCredential[]> {
    return this.listAlive<ProviderCredential>(COLLECTIONS.providerCredentials, { orderBy: 'createdAt' });
  }

  async saveProviderCredential(credential: ProviderCredential): Promise<void> {
    const updatedAt = await this.stampUpdatedAt(COLLECTIONS.providerCredentials, credential.id);
    await this.store.put(COLLECTIONS.providerCredentials, { ...credential, updatedAt, deletedAt: null });
  }

  async deleteProviderCredential(id: string): Promise<void> {
    await this.softDelete(COLLECTIONS.providerCredentials, id);
  }
}
