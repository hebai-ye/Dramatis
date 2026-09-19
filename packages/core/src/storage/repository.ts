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
import type { CharacterInstance } from '../model/instance.js';
import type { AdminArtifact, MemoryEvent, Message } from '../model/message.js';
import { createPersona, type Persona } from '../model/persona.js';
import type { ProviderProfile } from '../model/provider.js';
import type { Room, Scene } from '../model/room.js';
import type { EntityStore } from '../platform/entity-store.js';
import { USAGE_COLLECTION } from './usage.js';

/**
 * 当前 schema 版本。
 *
 * 任何会改变已落盘数据结构的改动都要 +1，并补一条 `Migration`。
 * 这是「从第一天就留好升级路径」的具体做法（ROADMAP P0-1）。
 */
export const SCHEMA_VERSION = 3;

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
} as const;

export const META_KEYS = {
  schemaVersion: 'schema.version',
  lastRoomId: 'session.lastRoomId',
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
  /** persona 是跨房间共用的身份表，一并返回方便 UI 直接切换。 */
  personas: Persona[];
}

/** 归档一条对话的实际影响，供界面如实提示「回滚了什么」。 */
export interface ArchiveReport {
  conversationId: ConversationId;
  restoredInstances: number;
  removedMemories: number;
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
          archivedAt: null,
          // 旧数据没有「对话开始之前」的概念：整条线就是这个世界本身，
          // 所以快照留空，归档这样的对话不会回滚任何状态。
          stateSnapshot: [],
          createdAt: typeof room.createdAt === 'string' ? room.createdAt : now,
          updatedAt: now,
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
];

interface MetaRecord {
  id: string;
  value: unknown;
  updatedAt: string;
}

/**
 * 仓储层（ROADMAP P0-1）。
 *
 * 所有落盘都经过这里，UI 不直接接触 `EntityStore`。这样换存储后端
 * （IndexedDB → SQLite）时，只有适配层需要改动。
 */
export class Repository {
  constructor(
    private readonly store: EntityStore,
    private readonly migrations: readonly Migration[] = MIGRATIONS,
  ) {}

  get backendKind(): string {
    return this.store.kind;
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
    await this.store.put(COLLECTIONS.rooms, { ...room, updatedAt: nowIso() });
  }

  async getRoom(id: RoomId): Promise<Room | null> {
    return this.store.get<Room>(COLLECTIONS.rooms, id);
  }

  async listRooms(): Promise<RoomSummary[]> {
    const rooms = await this.store.list<Room>(COLLECTIONS.rooms, {
      orderBy: 'updatedAt',
      direction: 'desc',
    });

    const summaries: RoomSummary[] = [];
    for (const room of rooms) {
      summaries.push({
        id: room.id,
        title: room.title,
        updatedAt: room.updatedAt,
        messageCount: await this.store.count(COLLECTIONS.messages, { roomId: room.id }),
        instanceCount: await this.store.count(COLLECTIONS.instances, { roomId: room.id }),
        conversationCount: await this.store.count(COLLECTIONS.conversations, { roomId: room.id }),
      });
    }
    return summaries;
  }

  /**
   * 删除房间，并级联删除它的场景、角色实例与消息。
   *
   * 角色卡与世界书**不删**——它们是可被多个房间共用的资产，
   * 删掉一个房间不应该连带毁掉用户导入的素材。
   */
  async deleteRoom(id: RoomId): Promise<void> {
    const conversations = await this.store.list<Conversation>(COLLECTIONS.conversations, { where: { roomId: id } });
    const scenes = await this.store.list<Scene>(COLLECTIONS.scenes, { where: { roomId: id } });
    const instances = await this.store.list<CharacterInstance>(COLLECTIONS.instances, { where: { roomId: id } });
    const messages = await this.store.list<Message>(COLLECTIONS.messages, { where: { roomId: id } });
    const memories = await this.store.list<MemoryEvent>(COLLECTIONS.memories, { where: { roomId: id } });
    // 后台任务也要清掉：留下指向已删除房间的任务，只会在下次启动时反复失败
    const tasks = await this.store.list<{ id: string }>(COLLECTIONS.backgroundTasks, { where: { roomId: id } });
    // 账单跟着世界走：世界没了，账也就没有归属了。归档对话则**不**回滚账单——
    // 时间线可以当作没发生过，钱不行
    const usage = await this.store.list<{ id: string }>(COLLECTIONS.usageRecords, { where: { roomId: id } });

    for (const conversation of conversations) await this.store.remove(COLLECTIONS.conversations, conversation.id);
    for (const scene of scenes) await this.store.remove(COLLECTIONS.scenes, scene.id);
    for (const instance of instances) await this.store.remove(COLLECTIONS.instances, instance.id);
    for (const message of messages) await this.store.remove(COLLECTIONS.messages, message.id);
    for (const memory of memories) await this.store.remove(COLLECTIONS.memories, memory.id);
    for (const task of tasks) await this.store.remove(COLLECTIONS.backgroundTasks, task.id);
    for (const record of usage) await this.store.remove(COLLECTIONS.usageRecords, record.id);
    await this.store.remove(COLLECTIONS.rooms, id);
  }

  // ---- 对话（LAYOUT：世界 = 项目，一个世界下可以开多个对话） ----

  async saveConversation(conversation: Conversation): Promise<void> {
    await this.store.put(COLLECTIONS.conversations, { ...conversation, updatedAt: nowIso() });
  }

  async getConversation(id: ConversationId): Promise<Conversation | null> {
    return this.store.get<Conversation>(COLLECTIONS.conversations, id);
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
    return options.includeArchived === true ? all : all.filter((conversation) => conversation.archivedAt === null);
  }

  /** 删掉一条对话：场景、消息、记忆一起走，角色与世界书保留。 */
  async deleteConversation(id: ConversationId): Promise<void> {
    const conversation = await this.getConversation(id);
    if (!conversation) return;

    const scenes = await this.store.list<Scene>(COLLECTIONS.scenes, { where: { conversationId: id } });
    const messages = await this.store.list<Message>(COLLECTIONS.messages, { where: { conversationId: id } });
    const memories = await this.store.list<MemoryEvent>(COLLECTIONS.memories, { where: { conversationId: id } });

    for (const scene of scenes) await this.store.remove(COLLECTIONS.scenes, scene.id);
    for (const message of messages) await this.store.remove(COLLECTIONS.messages, message.id);
    for (const memory of memories) await this.store.remove(COLLECTIONS.memories, memory.id);
    await this.store.remove(COLLECTIONS.conversations, id);

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
    await this.store.put(COLLECTIONS.conversations, { ...conversation, archivedAt: at, updatedAt: at });

    const room = await this.getRoom(conversation.roomId);
    let nextConversationId = room?.activeConversationId ?? null;
    if (room && room.activeConversationId === conversation.id) {
      const remaining = await this.listConversations(conversation.roomId);
      nextConversationId = remaining[0]?.id ?? null;
      await this.saveRoom({ ...room, activeConversationId: nextConversationId, updatedAt: at });
    }

    return { conversationId: conversation.id, restoredInstances, removedMemories, nextConversationId };
  }

  // ---- 场景 ----

  async saveScene(scene: Scene): Promise<void> {
    await this.store.put(COLLECTIONS.scenes, scene);
  }

  async getScene(id: SceneId): Promise<Scene | null> {
    return this.store.get<Scene>(COLLECTIONS.scenes, id);
  }

  async listScenes(roomId: RoomId): Promise<Scene[]> {
    return this.store.list<Scene>(COLLECTIONS.scenes, {
      where: { roomId },
      orderBy: 'createdAt',
      direction: 'asc',
    });
  }

  // ---- 角色实例 ----

  async saveInstance(instance: CharacterInstance): Promise<void> {
    await this.store.put(COLLECTIONS.instances, { ...instance, updatedAt: nowIso() });
  }

  async listInstances(roomId: RoomId): Promise<CharacterInstance[]> {
    return this.store.list<CharacterInstance>(COLLECTIONS.instances, { where: { roomId } });
  }

  /** 删除角色实例。角色卡是共用资产，不跟着删。 */
  async deleteInstance(id: string): Promise<void> {
    await this.store.remove(COLLECTIONS.instances, id);
  }

  // ---- 角色卡与世界书（跨房间共用） ----

  async saveCard(card: Card): Promise<void> {
    await this.store.put(COLLECTIONS.cards, card);
  }

  async getCard(id: CardId): Promise<Card | null> {
    return this.store.get<Card>(COLLECTIONS.cards, id);
  }

  async listCards(): Promise<Card[]> {
    return this.store.list<Card>(COLLECTIONS.cards, { orderBy: 'name' });
  }

  async deleteCard(id: CardId): Promise<void> {
    await this.store.remove(COLLECTIONS.cards, id);
  }

  async saveWorldBook(book: WorldBook): Promise<void> {
    await this.store.put(COLLECTIONS.worldBooks, book);
  }

  async getWorldBook(id: WorldBookId): Promise<WorldBook | null> {
    return this.store.get<WorldBook>(COLLECTIONS.worldBooks, id);
  }

  async listWorldBooks(): Promise<WorldBook[]> {
    return this.store.list<WorldBook>(COLLECTIONS.worldBooks, { orderBy: 'name' });
  }

  async deleteWorldBook(id: WorldBookId): Promise<void> {
    await this.store.remove(COLLECTIONS.worldBooks, id);
  }

  // ---- 消息 ----

  /**
   * 追加消息并分配房间内单调递增的 `seq`。
   *
   * 不依赖时间戳排序：同一毫秒内落盘的多条消息必须仍有稳定顺序，
   * 这是 P2-6 跨设备合并的前提。
   */
  async appendMessages(roomId: RoomId, messages: readonly Message[]): Promise<Message[]> {
    const counterKey = `seq:${roomId}`;
    let next = (await this.getMeta<number>(counterKey)) ?? 0;

    const stamped: Message[] = [];
    for (const message of messages) {
      next += 1;
      stamped.push({ ...message, roomId, seq: next });
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
   */
  async listMessages(
    roomId: RoomId,
    options: { limit?: number; conversationId?: ConversationId } = {},
  ): Promise<Message[]> {
    const where: Record<string, unknown> = { roomId };
    if (options.conversationId !== undefined) where.conversationId = options.conversationId;

    if (options.limit === undefined) {
      return this.store.list<Message>(COLLECTIONS.messages, {
        where,
        orderBy: 'seq',
        direction: 'asc',
      });
    }

    const recent = await this.store.list<Message>(COLLECTIONS.messages, {
      where,
      orderBy: 'seq',
      direction: 'desc',
      limit: options.limit,
    });
    return recent.reverse();
  }

  async updateMessage(id: MessageId, patch: Partial<Message>): Promise<Message | null> {
    const existing = await this.store.get<Message>(COLLECTIONS.messages, id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, id: existing.id, roomId: existing.roomId, seq: existing.seq };
    await this.store.put(COLLECTIONS.messages, updated);
    return updated;
  }

  /** 删除单条消息，用于消息编辑与重抽（P0-7）。 */
  async deleteMessage(id: MessageId): Promise<void> {
    await this.store.remove(COLLECTIONS.messages, id);
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
    const message = await this.store.get<Message>(COLLECTIONS.messages, messageId);
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
    } else {
      targetId = target.targetId;
    }

    const adopted: AdminArtifact = { ...target, status: 'adopted', targetId };
    const updated: Message = {
      ...message,
      artifacts: message.artifacts.map((item) => (item.id === artifactId ? adopted : item)),
    };
    await this.store.put(COLLECTIONS.messages, updated);
    return { message: updated, artifact: adopted };
  }

  /** 丢弃一条草稿：只改状态，不删记录——用户可能过一会儿又想要它。 */
  async discardAdminArtifact(messageId: MessageId, artifactId: string): Promise<Message | null> {
    const message = await this.store.get<Message>(COLLECTIONS.messages, messageId);
    if (!message || message.artifacts === undefined) return null;

    const updated: Message = {
      ...message,
      artifacts: message.artifacts.map((item) =>
        item.id === artifactId && item.status === 'pending' ? { ...item, status: 'discarded' } : item,
      ),
    };
    await this.store.put(COLLECTIONS.messages, updated);
    return updated;
  }

  /** 删除某个回合产生的全部消息，用于重抽（P0-7）。返回删除数量。 */
  async removeMessagesByTurn(roomId: RoomId, turnId: string): Promise<number> {
    const messages = await this.store.list<Message>(COLLECTIONS.messages, {
      where: { roomId, turnId },
    });
    for (const message of messages) {
      await this.store.remove(COLLECTIONS.messages, message.id);
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
    const messages = await this.store.list<Message>(COLLECTIONS.messages, {
      where: { roomId },
      orderBy: 'seq',
      direction: 'asc',
    });

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
    return { room, conversations, scenes, instances, cards, worldBooks, messages, memories, personas };
  }

  // ---- 玩家身份（P0-3） ----

  // ---- 记忆（P1） ----

  async listMemories(roomId: RoomId, options: { conversationId?: ConversationId } = {}): Promise<MemoryEvent[]> {
    const where: Record<string, unknown> = { roomId };
    if (options.conversationId !== undefined) where.conversationId = options.conversationId;

    return this.store.list<MemoryEvent>(COLLECTIONS.memories, {
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
    const events = await this.store.list<MemoryEvent>(COLLECTIONS.memories, { where: { conversationId: id } });
    for (const event of events) {
      await this.store.remove(COLLECTIONS.memories, event.id);
    }
    return events.length;
  }

  async saveMemories(events: readonly MemoryEvent[]): Promise<void> {
    await this.store.bulkPut(COLLECTIONS.memories, events);
  }

  async updateMemory(id: EventId, patch: Partial<MemoryEvent>): Promise<MemoryEvent | null> {
    const existing = await this.store.get<MemoryEvent>(COLLECTIONS.memories, id);
    if (!existing) return null;

    const updated: MemoryEvent = {
      ...existing,
      ...patch,
      id: existing.id,
      roomId: existing.roomId,
      sourceTurnIds: existing.sourceTurnIds,
    };
    await this.store.put(COLLECTIONS.memories, updated);
    return updated;
  }

  async deleteMemory(id: EventId): Promise<void> {
    await this.store.remove(COLLECTIONS.memories, id);
  }

  /**
   * 删除某个回合产生的全部记忆，用于重抽与消息删除（P0-7 的回滚）。
   *
   * 按 `sourceTurnIds` 判断而不是按时间——一条记忆可能由多轮对话共同产生，
   * 只要它引用了被撤销的回合，就该跟着作废。
   */
  async deleteMemoriesByTurn(roomId: RoomId, turnId: string): Promise<number> {
    const events = await this.store.list<MemoryEvent>(COLLECTIONS.memories, { where: { roomId } });
    const affected = events.filter((event) => event.sourceTurnIds.includes(turnId));
    for (const event of affected) {
      await this.store.remove(COLLECTIONS.memories, event.id);
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
    return this.store.list<Persona>(COLLECTIONS.personas, { orderBy: 'createdAt' });
  }

  async getPersona(id: string): Promise<Persona | null> {
    return this.store.get<Persona>(COLLECTIONS.personas, id);
  }

  async savePersona(persona: Persona): Promise<void> {
    await this.store.put(COLLECTIONS.personas, { ...persona, updatedAt: nowIso() });
  }

  /**
   * 删除 persona，并把引用它的房间退回内联字段。
   *
   * 不做级联删除房间：房间里的对话与角色状态比一份身份描述贵重得多。
   * 返回受影响的房间数，便于 UI 提示。
   */
  async deletePersona(id: string): Promise<number> {
    await this.store.remove(COLLECTIONS.personas, id);
    const rooms = await this.store.list<Room>(COLLECTIONS.rooms, { where: { personaId: id } });
    for (const room of rooms) {
      await this.store.put(COLLECTIONS.rooms, { ...room, personaId: null });
    }
    return rooms.length;
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
    return this.store.list<ProviderProfile>(COLLECTIONS.providerProfiles, { orderBy: 'createdAt' });
  }

  async saveProviderProfile(profile: ProviderProfile): Promise<void> {
    await this.store.put(COLLECTIONS.providerProfiles, { ...profile, updatedAt: nowIso() });
  }

  async deleteProviderProfile(id: string): Promise<void> {
    await this.store.remove(COLLECTIONS.providerProfiles, id);
  }
}
