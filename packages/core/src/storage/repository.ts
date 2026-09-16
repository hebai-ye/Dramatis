import type { Card, WorldBook } from '../model/card.js';
import type { CardId, EventId, MessageId, RoomId, SceneId, WorldBookId } from '../model/ids.js';
import { nowIso } from '../model/ids.js';
import type { CharacterInstance } from '../model/instance.js';
import type { MemoryEvent, Message } from '../model/message.js';
import { createPersona, type Persona } from '../model/persona.js';
import type { ProviderProfile } from '../model/provider.js';
import type { Room, Scene } from '../model/room.js';
import type { EntityStore } from '../platform/entity-store.js';

/**
 * 当前 schema 版本。
 *
 * 任何会改变已落盘数据结构的改动都要 +1，并补一条 `Migration`。
 * 这是「从第一天就留好升级路径」的具体做法（ROADMAP P0-1）。
 */
export const SCHEMA_VERSION = 2;

export const COLLECTIONS = {
  meta: 'meta',
  rooms: 'rooms',
  scenes: 'scenes',
  cards: 'cards',
  instances: 'instances',
  worldBooks: 'worldBooks',
  messages: 'messages',
  memories: 'memories',
  personas: 'personas',
  providerProfiles: 'providerProfiles',
  backgroundTasks: 'backgroundTasks',
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
}

export interface RoomSnapshot {
  room: Room;
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
    const scenes = await this.store.list<Scene>(COLLECTIONS.scenes, { where: { roomId: id } });
    const instances = await this.store.list<CharacterInstance>(COLLECTIONS.instances, { where: { roomId: id } });
    const messages = await this.store.list<Message>(COLLECTIONS.messages, { where: { roomId: id } });

    for (const scene of scenes) await this.store.remove(COLLECTIONS.scenes, scene.id);
    for (const instance of instances) await this.store.remove(COLLECTIONS.instances, instance.id);
    for (const message of messages) await this.store.remove(COLLECTIONS.messages, message.id);
    await this.store.remove(COLLECTIONS.rooms, id);
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

  async saveWorldBook(book: WorldBook): Promise<void> {
    await this.store.put(COLLECTIONS.worldBooks, book);
  }

  async getWorldBook(id: WorldBookId): Promise<WorldBook | null> {
    return this.store.get<WorldBook>(COLLECTIONS.worldBooks, id);
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

  /** 返回最近 `limit` 条消息，按时间正序。 */
  async listMessages(roomId: RoomId, options: { limit?: number } = {}): Promise<Message[]> {
    if (options.limit === undefined) {
      return this.store.list<Message>(COLLECTIONS.messages, {
        where: { roomId },
        orderBy: 'seq',
        direction: 'asc',
      });
    }

    const recent = await this.store.list<Message>(COLLECTIONS.messages, {
      where: { roomId },
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
    return { room, scenes, instances, cards, worldBooks, messages, memories, personas };
  }

  // ---- 玩家身份（P0-3） ----

  // ---- 记忆（P1） ----

  async listMemories(roomId: RoomId): Promise<MemoryEvent[]> {
    return this.store.list<MemoryEvent>(COLLECTIONS.memories, {
      where: { roomId },
      orderBy: 'createdAt',
      direction: 'desc',
    });
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
    scenes?: readonly Scene[];
    instances?: readonly CharacterInstance[];
    cards?: readonly Card[];
    worldBooks?: readonly WorldBook[];
  }): Promise<void> {
    if (snapshot.room) await this.saveRoom(snapshot.room);
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
