import type { ChapterSummary } from '../memory/summary.js';
import type { Card, WorldBook } from '../model/card.js';
import type { Conversation } from '../model/conversation.js';
import {
  cardId as asCardId,
  conversationId as asConversationId,
  eventId as asEventId,
  instanceId as asInstanceId,
  messageId as asMessageId,
  roomId as asRoomId,
  sceneId as asSceneId,
  worldBookId as asWorldBookId,
  type CardId,
  type ConversationId,
  type InstanceId,
  newId,
  nowIso,
  type RoomId,
  type SceneId,
} from '../model/ids.js';
import type { CharacterInstance } from '../model/instance.js';
import { localSeqOf, type MemoryEvent, type Message } from '../model/message.js';
import type { Persona } from '../model/persona.js';
import type { Room, Scene } from '../model/room.js';
import type { Repository } from './repository.js';
import type { UsageLedger, UsageRecord } from './usage.js';

/**
 * 封存导出 / 导入（ROADMAP P2-4）。
 *
 * 备份与搬迁：把**一个世界**（对话、场景、角色、消息、记忆、关系、章节、世界书、
 * 角色卡、身份）打成**一个文件**，换台机器导进来接着用。它同时是云同步之前的
 * 过渡方案、也是移动端的数据安全网——手机浏览器随时可能清掉本地数据。
 *
 * 两条硬规矩：
 *
 * 1. **导入永远是新建一个世界。** 不覆盖、不合并、不改动现有数据：宁可多出一个
 *    重复的世界让用户自己删，也不能悄悄动他的东西。
 * 2. **所有 id 重新分配，引用一并改写。** 同一个封存可以重复导入、和本机已有数据
 *    并存，不会撞 id；也不会出现「导入进来的消息指着一个不属于它的场景」。
 */
export const ARCHIVE_FORMAT = 'dramatis.world';
export const ARCHIVE_VERSION = 1;

/** 一个世界的完整快照（就是导出文件的内容）。 */
export interface WorldArchive {
  format: string;
  version: number;
  exportedAt: string;
  /** 世界名，用于界面提示与默认文件名。 */
  title: string;
  room: Room;
  conversations: Conversation[];
  scenes: Scene[];
  instances: CharacterInstance[];
  messages: Message[];
  memories: MemoryEvent[];
  chapters: ChapterSummary[];
  /** 这个世界的角色用到的卡（连同卡片本身一起带走，换机器才不会丢人设）。 */
  cards: Card[];
  worldBooks: WorldBook[];
  /** 玩家身份；世界里没设身份时为 null。 */
  persona: Persona | null;
  /** 这一局的账单。可有可无：导进来只是为了让花费统计连得上。 */
  usageRecords: UsageRecord[];
}

export interface ArchiveCounts {
  conversations: number;
  scenes: number;
  instances: number;
  messages: number;
  memories: number;
  chapters: number;
  cards: number;
  worldBooks: number;
  usageRecords: number;
}

export function countArchive(archive: WorldArchive): ArchiveCounts {
  return {
    conversations: archive.conversations.length,
    scenes: archive.scenes.length,
    instances: archive.instances.length,
    messages: archive.messages.length,
    memories: archive.memories.length,
    chapters: archive.chapters.length,
    cards: archive.cards.length,
    worldBooks: archive.worldBooks.length,
    usageRecords: archive.usageRecords.length,
  };
}

export interface BuildArchiveInput {
  room: Room;
  conversations: readonly Conversation[];
  scenes: readonly Scene[];
  instances: readonly CharacterInstance[];
  messages: readonly Message[];
  memories: readonly MemoryEvent[];
  chapters: readonly ChapterSummary[];
  cards: readonly Card[];
  worldBooks: readonly WorldBook[];
  persona?: Persona | null;
  usageRecords?: readonly UsageRecord[];
  /** 导出时间，缺省取当下。测试要用得上。 */
  at?: string;
}

export function buildWorldArchive(input: BuildArchiveInput): WorldArchive {
  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exportedAt: input.at ?? nowIso(),
    title: input.room.title,
    room: input.room,
    conversations: [...input.conversations],
    scenes: [...input.scenes],
    instances: [...input.instances],
    // 按原有的房间内序号排好：导入时仓储层会重新分配，但顺序必须原样保留
    messages: [...input.messages].sort((left, right) => localSeqOf(left) - localSeqOf(right)),
    memories: [...input.memories],
    chapters: [...input.chapters],
    cards: [...input.cards],
    worldBooks: [...input.worldBooks],
    persona: input.persona ?? null,
    usageRecords: [...(input.usageRecords ?? [])],
  };
}

export type ParseArchiveResult = { ok: true; archive: WorldArchive } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 解析导出文件。
 *
 * 报错要说人话：用户手里可能是**别的** JSON（角色卡、世界书），
 * 甚至是一张 PNG 被改了后缀——所以每条错误都写清「这不是什么」。
 */
export function parseWorldArchive(text: string): ParseArchiveResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: '这不是一个 JSON 文件。封存文件是一份 .json，请确认没有选错文件。' };
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: '文件内容不是一个对象，读不出世界。' };
  }

  if (parsed.format !== ARCHIVE_FORMAT) {
    return {
      ok: false,
      error: `这不是 Dramatis 的世界封存（format=${String(parsed.format ?? '缺失')}）。角色卡与世界书请用左侧的「导入素材」。`,
    };
  }

  const version = typeof parsed.version === 'number' ? parsed.version : 0;
  if (version > ARCHIVE_VERSION) {
    return {
      ok: false,
      error: `这份封存来自更新的版本（v${String(version)}），当前版本只认到 v${String(ARCHIVE_VERSION)}。请升级应用后再导入。`,
    };
  }

  const room = parsed.room;
  if (!isRecord(room) || typeof room.id !== 'string' || typeof room.title !== 'string') {
    return { ok: false, error: '封存里没有可用的世界记录，文件可能不完整。' };
  }

  const list = (key: string): unknown[] => (Array.isArray(parsed[key]) ? (parsed[key] as unknown[]) : []);

  return {
    ok: true,
    archive: {
      format: ARCHIVE_FORMAT,
      version,
      exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : nowIso(),
      title: room.title,
      room: room as unknown as Room,
      conversations: list('conversations') as Conversation[],
      scenes: list('scenes') as Scene[],
      instances: list('instances') as CharacterInstance[],
      messages: list('messages') as Message[],
      memories: list('memories') as MemoryEvent[],
      chapters: list('chapters') as ChapterSummary[],
      cards: list('cards') as Card[],
      worldBooks: list('worldBooks') as WorldBook[],
      persona: isRecord(parsed.persona) ? (parsed.persona as unknown as Persona) : null,
      usageRecords: list('usageRecords') as UsageRecord[],
    },
  };
}

export interface ImportArchiveReport {
  roomId: RoomId;
  title: string;
  counts: ArchiveCounts;
}

export interface ImportArchiveOptions {
  /** 导入时间，缺省取当下。 */
  at?: string;
  /** 有账本时把这一局的账单也写进去；没有就跳过（不影响使用）。 */
  ledger?: UsageLedger;
}

/**
 * 把封存写进库里，返回新世界的 id。
 *
 * 全过程只用仓储层的公开写入口：导入之后的世界与手工开出来的世界在结构上完全一样，
 * 不存在「只有导入才有的状态」。
 */
export async function importWorldArchive(
  archive: WorldArchive,
  repository: Repository,
  options: ImportArchiveOptions = {},
): Promise<ImportArchiveReport> {
  const at = options.at ?? nowIso();

  // 所有 id 都换新，引用靠这几张表改写
  const roomId = asRoomId(newId());
  const cardIds = new Map<string, CardId>();
  const worldBookIds = new Map<string, string>();
  const conversationIds = new Map<string, ConversationId>();
  const sceneIds = new Map<string, SceneId>();
  const instanceIds = new Map<string, InstanceId>();
  const turnIds = new Map<string, string>();

  const remapTurn = (turnId: string): string => {
    const existing = turnIds.get(turnId);
    if (existing !== undefined) return existing;
    const created = newId();
    turnIds.set(turnId, created);
    return created;
  };

  // 1) 角色卡与世界书：复制一份，别动用户素材库里已有的那几张
  for (const card of archive.cards) {
    const created = { ...card, id: asCardId(newId()) };
    cardIds.set(card.id, created.id);
    await repository.saveCard(created);
  }
  for (const book of archive.worldBooks) {
    const created = { ...book, id: asWorldBookId(newId()) };
    worldBookIds.set(book.id, created.id);
    await repository.saveWorldBook(created);
  }

  // 2) 玩家身份
  let personaId: string | null = null;
  if (archive.persona !== null) {
    const created: Persona = { ...archive.persona, id: newId(), updatedAt: at };
    await repository.savePersona(created);
    personaId = created.id;
  }

  // 3) 对话（场景与消息都挂在它下面）
  for (const conversation of archive.conversations) {
    const created: Conversation = {
      ...conversation,
      id: asConversationId(newId()),
      roomId,
      activeSceneId: null,
      updatedAt: at,
    };
    conversationIds.set(conversation.id, created.id);
    await repository.saveConversation(created);
  }

  // 4) 角色：先建出来，场景名单与关系才有人可指
  const instances: CharacterInstance[] = [];
  for (const instance of archive.instances) {
    const created: CharacterInstance = {
      ...instance,
      id: asInstanceId(newId()),
      roomId,
      cardId: cardIds.get(instance.cardId) ?? instance.cardId,
      relationships: instance.relationships.map((relationship) => ({ ...relationship })),
      updatedAt: at,
    };
    instanceIds.set(instance.id, created.id);
    instances.push(created);
  }

  // 角色之间的关系指向的是角色 id，一起改写
  for (const instance of instances) {
    const relationships = instance.relationships.map((relationship) => {
      const target = instanceIds.get(relationship.target);
      return target === undefined ? relationship : { ...relationship, target };
    });
    await repository.saveInstance({ ...instance, relationships });
  }

  // 5) 场景：名单里的角色已经就位
  for (const scene of archive.scenes) {
    const created: Scene = {
      ...scene,
      id: asSceneId(newId()),
      roomId,
      conversationId: scene.conversationId === null ? null : (conversationIds.get(scene.conversationId) ?? null),
      cast: scene.cast.map((id) => instanceIds.get(id)).filter((id): id is InstanceId => id !== undefined),
    };
    sceneIds.set(scene.id, created.id);
    await repository.saveScene(created);
  }

  // 6) 世界本身（引用都齐了才写）
  const room: Room = {
    ...archive.room,
    id: roomId,
    personaId,
    cardIds: archive.room.cardIds.map((id) => cardIds.get(id)).filter((id): id is CardId => id !== undefined),
    instanceIds: instances.map((instance) => instance.id),
    worldBookIds: archive.room.worldBookIds
      .map((id) => worldBookIds.get(id))
      .filter((id): id is string => id !== undefined)
      .map((id) => asWorldBookId(id)),
    activeConversationId: null,
    updatedAt: at,
  };
  await repository.saveRoom(room);

  // 7) 消息：按原顺序交给 appendMessages，localSeq 与 deviceId 由仓储层重发
  await repository.appendMessages(
    roomId,
    archive.messages.map((message) => ({
      ...message,
      id: asMessageId(newId()),
      roomId,
      conversationId: message.conversationId === null ? null : (conversationIds.get(message.conversationId) ?? null),
      sceneId: message.sceneId === null ? null : (sceneIds.get(message.sceneId) ?? null),
      turnId: remapTurn(message.turnId),
      speakerInstanceId:
        message.speakerInstanceId === null ? null : (instanceIds.get(message.speakerInstanceId) ?? null),
      audience: message.audience.map((id) => instanceIds.get(id)).filter((id): id is InstanceId => id !== undefined),
    })),
  );

  // 8) 记忆与章节
  const memories: MemoryEvent[] = archive.memories.map((memory) => {
    const created: MemoryEvent = {
      ...memory,
      id: asEventId(newId()),
      roomId,
      conversationId: memory.conversationId === null ? null : (conversationIds.get(memory.conversationId) ?? null),
      sceneId: memory.sceneId === null ? null : (sceneIds.get(memory.sceneId) ?? null),
      participants: memory.participants
        .map((id) => instanceIds.get(id))
        .filter((id): id is InstanceId => id !== undefined),
      observerId: memory.observerId === null ? null : (instanceIds.get(memory.observerId) ?? null),
      affects: memory.affects.map((id) => instanceIds.get(id)).filter((id): id is InstanceId => id !== undefined),
      sourceTurnIds: memory.sourceTurnIds.map((id) => turnIds.get(id) ?? id),
    };
    return created;
  });
  await repository.saveMemories(memories);

  for (const chapter of archive.chapters) {
    await repository.saveChapterSummary({
      ...chapter,
      id: newId(),
      roomId,
      conversationId: chapter.conversationId === null ? null : (conversationIds.get(chapter.conversationId) ?? null),
      sceneIds: chapter.sceneIds.map((id) => sceneIds.get(id)).filter((id): id is SceneId => id !== undefined),
      createdAt: at,
    });
  }

  // 9) 世界当前的对话/场景指回来（场景 id 是第 5 步才有的）
  const firstConversation = archive.conversations[0];
  if (firstConversation !== undefined) {
    const createdConversation = conversationIds.get(firstConversation.id);
    const createdScene =
      firstConversation.activeSceneId === null ? null : sceneIds.get(firstConversation.activeSceneId);
    if (createdConversation !== undefined) {
      await repository.saveConversation({
        ...firstConversation,
        id: createdConversation,
        roomId,
        activeSceneId: createdScene ?? null,
        updatedAt: at,
      });
      await repository.saveRoom({ ...room, activeConversationId: createdConversation, updatedAt: at });
    }
  }

  // 10) 账单：只为了把花费统计连上，缺了不影响使用
  if (options.ledger !== undefined) {
    for (const record of archive.usageRecords) {
      await options.ledger.record({
        roomId,
        conversationId: record.conversationId === null ? null : (conversationIds.get(record.conversationId) ?? null),
        turnId: record.turnId === null ? null : remapTurn(record.turnId),
        category: record.category,
        model: record.model,
        promptTokens: record.promptTokens,
        completionTokens: record.completionTokens,
        speakerInstanceId:
          record.speakerInstanceId === null ? null : (instanceIds.get(record.speakerInstanceId) ?? null),
        speakerName: record.speakerName,
        price: record.price,
        at: record.createdAt,
      });
    }
  }

  return {
    roomId,
    title: archive.title,
    counts: {
      conversations: archive.conversations.length,
      scenes: archive.scenes.length,
      instances: archive.instances.length,
      messages: archive.messages.length,
      memories: archive.memories.length,
      chapters: archive.chapters.length,
      cards: archive.cards.length,
      worldBooks: archive.worldBooks.length,
      usageRecords: archive.usageRecords.length,
    },
  };
}
