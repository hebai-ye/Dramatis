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
  type EventId,
  type InstanceId,
  type MessageId,
  newId,
  nowIso,
  type RelationshipTarget,
  type RoomId,
  type SceneId,
  type WorldBookId,
} from '../model/ids.js';
import type { Affect, CharacterInstance, Relationship } from '../model/instance.js';
import { type AdminArtifact, localSeqOf, type MemoryEvent, type Message } from '../model/message.js';
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
 * 「导入中」标记的 meta 键（审计 C7）。
 *
 * 导入要写几十上百条记录，却不是一个事务：中途失败（配额满、页面被关）会留下半个世界。
 * 所以开工前先记下「这一趟会造出哪些东西」，成功后清掉；失败当场回滚，页面被关掉的
 * 那种则由下次启动时的 `recoverInterruptedImports` 收拾。
 */
export const IMPORT_PENDING_META_KEY = 'archive.importPending';

interface PendingImport {
  roomId: string;
  cardIds: string[];
  worldBookIds: string[];
  personaId: string | null;
  startedAt: string;
}

/** 按「导入中」标记把半个世界整个撤掉（全部软删除，与手动删世界一致）。 */
async function rollbackImport(repository: Repository, pending: PendingImport): Promise<void> {
  await repository.deleteRoom(asRoomId(pending.roomId));
  for (const id of pending.cardIds) await repository.deleteCard(asCardId(id));
  for (const id of pending.worldBookIds) await repository.deleteWorldBook(asWorldBookId(id));
  if (pending.personaId !== null) await repository.deletePersona(pending.personaId);
}

/**
 * 启动时调用：上一次导入被打断（页面关掉、崩溃）就把那半个世界撤掉（审计 C7）。
 * 返回撤掉的世界 id；没有就返回 null。
 */
export async function recoverInterruptedImports(repository: Repository): Promise<RoomId | null> {
  const pending = await repository.getMeta<PendingImport | null>(IMPORT_PENDING_META_KEY);
  if (pending === null || typeof pending !== 'object' || typeof pending.roomId !== 'string') return null;
  await rollbackImport(repository, pending);
  await repository.setMeta(IMPORT_PENDING_META_KEY, null);
  return asRoomId(pending.roomId);
}

/** 一趟导入里所有「旧 id → 新 id」的对照表（审计 A11：所有引用都从这里改写）。 */
interface IdMaps {
  cards: Map<string, CardId>;
  worldBooks: Map<string, WorldBookId>;
  conversations: Map<string, ConversationId>;
  scenes: Map<string, SceneId>;
  instances: Map<string, InstanceId>;
  messages: Map<string, MessageId>;
  memories: Map<string, EventId>;
  turns: Map<string, string>;
  persona: { from: string | null; to: string | null };
}

function buildIdMaps(archive: WorldArchive): IdMaps {
  const fresh = <T>(items: readonly { id: string }[], make: (id: string) => T): Map<string, T> =>
    new Map(items.map((item) => [item.id, make(newId())]));
  return {
    cards: fresh(archive.cards, asCardId),
    worldBooks: fresh(archive.worldBooks, asWorldBookId),
    conversations: fresh(archive.conversations, asConversationId),
    scenes: fresh(archive.scenes, asSceneId),
    instances: fresh(archive.instances, asInstanceId),
    messages: fresh(archive.messages, asMessageId),
    memories: fresh(archive.memories, asEventId),
    turns: new Map(),
    persona: { from: archive.persona?.id ?? null, to: archive.persona === null ? null : newId() },
  };
}

function mapList<T>(ids: readonly string[] | undefined, map: Map<string, T>): T[] {
  return (ids ?? []).map((id) => map.get(id)).filter((id): id is T => id !== undefined);
}

function mapOptional<T>(id: string | null | undefined, map: Map<string, T>): T | null {
  return id === null || id === undefined ? null : (map.get(id) ?? null);
}

function remapTurnId(turnId: string, maps: IdMaps): string {
  const existing = maps.turns.get(turnId);
  if (existing !== undefined) return existing;
  const created = newId();
  maps.turns.set(turnId, created);
  return created;
}

/** 关系目标：玩家（或别的非角色目标）原样保留，角色 id 换新。 */
function remapRelationships(relationships: readonly Relationship[], maps: IdMaps): Relationship[] {
  return relationships.map((relationship) => ({
    ...relationship,
    target: (maps.instances.get(relationship.target) ?? relationship.target) as RelationshipTarget,
    history: relationship.history.map((change) => ({
      ...change,
      turnId: remapTurnId(change.turnId, maps),
      sourceMemoryIds: mapList(change.sourceMemoryIds, maps.memories),
    })),
  }));
}

function remapAffect(affect: Affect, maps: IdMaps): Affect {
  return {
    ...affect,
    history: affect.history.map((change) => ({
      ...change,
      turnId: remapTurnId(change.turnId, maps),
      sourceMemoryIds: mapList(change.sourceMemoryIds, maps.memories),
    })),
  };
}

/**
 * 管理员草稿的目标 id：指向封存里带着的素材就换成新 id；指向封存外的东西（原机器素材库
 * 里的某张卡）一律清空——否则在同一台机器上导入之后「撤回采纳」会删掉用户自己的原卡。
 */
function remapArtifacts(artifacts: readonly AdminArtifact[], maps: IdMaps): AdminArtifact[] {
  return artifacts.map((artifact) => {
    const lookup = (id: string | null): string | null => {
      if (id === null) return null;
      if (artifact.kind === 'character-card') return maps.cards.get(id) ?? null;
      if (artifact.kind === 'world-book') return maps.worldBooks.get(id) ?? null;
      if (artifact.kind === 'scene') return maps.scenes.get(id) ?? null;
      return id === maps.persona.from ? maps.persona.to : null;
    };
    const payload = artifact.payload;
    let nextPayload = payload;
    if (isRecord(payload) && typeof payload.id === 'string') {
      const mapped = lookup(payload.id);
      if (mapped !== null) nextPayload = { ...payload, id: mapped };
    }
    return { ...artifact, targetId: lookup(artifact.targetId), payload: nextPayload };
  });
}

/**
 * 把封存写进库里，返回新世界的 id。
 *
 * 全过程只用仓储层的公开写入口：导入之后的世界与手工开出来的世界在结构上完全一样，
 * 不存在「只有导入才有的状态」。
 *
 * 审计 A11：id 全部先分配好，再统一改写所有交叉引用——对话的状态快照（角色 id 与关系目标）、
 * 情绪/关系变化的来源记忆、记忆之间的合并链、场记游标、草稿目标。
 * 审计 C7：失败时整趟回滚，不留半个世界。
 */
export async function importWorldArchive(
  archive: WorldArchive,
  repository: Repository,
  options: ImportArchiveOptions = {},
): Promise<ImportArchiveReport> {
  const at = options.at ?? nowIso();
  const roomId = asRoomId(newId());
  const maps = buildIdMaps(archive);

  const pending: PendingImport = {
    roomId,
    cardIds: [...maps.cards.values()],
    worldBookIds: [...maps.worldBooks.values()],
    personaId: maps.persona.to,
    startedAt: at,
  };
  await repository.setMeta(IMPORT_PENDING_META_KEY, pending);

  try {
    await writeArchive(archive, repository, options, at, roomId, maps);
  } catch (error) {
    try {
      await rollbackImport(repository, pending);
      await repository.setMeta(IMPORT_PENDING_META_KEY, null);
    } catch {
      // 回滚本身失败：标记留着，下次启动的 recoverInterruptedImports 会再试
    }
    throw error;
  }
  await repository.setMeta(IMPORT_PENDING_META_KEY, null);

  return { roomId, title: archive.title, counts: countArchive(archive) };
}

async function writeArchive(
  archive: WorldArchive,
  repository: Repository,
  options: ImportArchiveOptions,
  at: string,
  roomId: RoomId,
  maps: IdMaps,
): Promise<void> {
  const personaId = maps.persona.to;

  // 1) 角色卡与世界书：复制一份，别动用户素材库里已有的那几张
  for (const card of archive.cards) {
    await repository.saveCard({ ...card, id: maps.cards.get(card.id) ?? asCardId(newId()) });
  }
  for (const book of archive.worldBooks) {
    await repository.saveWorldBook({ ...book, id: maps.worldBooks.get(book.id) ?? asWorldBookId(newId()) });
  }

  // 2) 玩家身份
  if (archive.persona !== null && personaId !== null) {
    const created: Persona = { ...archive.persona, id: personaId, updatedAt: at };
    await repository.savePersona(created);
  }

  // 3) 角色：关系目标与变化来源一起改写
  const instances: CharacterInstance[] = archive.instances.map((instance) => ({
    ...instance,
    id: maps.instances.get(instance.id) ?? asInstanceId(newId()),
    roomId,
    cardId: maps.cards.get(instance.cardId) ?? instance.cardId,
    affect: remapAffect(instance.affect, maps),
    relationships: remapRelationships(instance.relationships, maps),
    updatedAt: at,
  }));
  for (const instance of instances) await repository.saveInstance(instance);

  // 4) 对话：状态快照里的角色 id 与关系目标必须能对上新角色，否则归档回滚匹配不到任何人
  const conversationFor = (conversation: Conversation, activeSceneId: SceneId | null): Conversation => ({
    ...conversation,
    id: maps.conversations.get(conversation.id) ?? asConversationId(newId()),
    roomId,
    activeSceneId,
    personaId: conversation.personaId === maps.persona.from ? personaId : (conversation.personaId ?? personaId),
    playerName: conversation.playerName ?? archive.persona?.name ?? '玩家',
    playerPersona: conversation.playerPersona ?? archive.persona?.description ?? '',
    stateSnapshot: (conversation.stateSnapshot ?? [])
      .filter((item) => maps.instances.has(item.instanceId))
      .map((item) => ({
        ...item,
        instanceId: maps.instances.get(item.instanceId) ?? item.instanceId,
        affect: remapAffect(item.affect, maps),
        relationships: remapRelationships(item.relationships, maps),
      })),
    updatedAt: at,
  });
  for (const conversation of archive.conversations) {
    await repository.saveConversation(conversationFor(conversation, null));
  }

  // 5) 消息：按原顺序交给 appendMessages，localSeq 与 deviceId 由仓储层重发
  const stamped = await repository.appendMessages(
    roomId,
    archive.messages.map((message) => ({
      ...message,
      id: maps.messages.get(message.id) ?? asMessageId(newId()),
      roomId,
      conversationId: mapOptional(message.conversationId, maps.conversations),
      sceneId: mapOptional(message.sceneId, maps.scenes),
      turnId: remapTurnId(message.turnId, maps),
      speakerInstanceId: mapOptional(message.speakerInstanceId, maps.instances),
      audience: mapList(message.audience, maps.instances),
      ...(message.artifacts === undefined ? {} : { artifacts: remapArtifacts(message.artifacts, maps) }),
    })),
  );
  const newSeqById = new Map<string, number>(stamped.map((message) => [message.id, message.localSeq]));

  /*
   * 6) 场景：场记游标要按**新**序号重算。
   *
   * 导入后序号从 1 重新发，旧的 `recapUpToSeq` 直接沿用会把没摘过的消息误判成「已覆盖」，
   * 它们就从提示词里消失了。游标有消息 id 就按 id 找新号；只有老序号的，取这一场里
   * 旧序号不超过它的最后一条消息，再换成那条的新号。
   */
  for (const scene of archive.scenes) {
    let recapUpToMessageId: MessageId | null = mapOptional(scene.recapUpToMessageId, maps.messages);
    const legacyCursor = scene.recapUpToSeq ?? 0;
    if (recapUpToMessageId === null && legacyCursor > 0) {
      const covered = archive.messages
        .filter((message) => message.sceneId === scene.id && localSeqOf(message) <= legacyCursor)
        .at(-1);
      recapUpToMessageId = covered === undefined ? null : (maps.messages.get(covered.id) ?? null);
    }
    const hadCursor = scene.recapUpToMessageId !== undefined || scene.recapUpToSeq !== undefined;
    const recapUpToSeq = recapUpToMessageId === null ? 0 : (newSeqById.get(recapUpToMessageId) ?? 0);

    const created: Scene = {
      ...scene,
      id: maps.scenes.get(scene.id) ?? asSceneId(newId()),
      roomId,
      conversationId: mapOptional(scene.conversationId, maps.conversations),
      cast: mapList(scene.cast, maps.instances),
      ...(hadCursor ? { recapUpToSeq, recapUpToMessageId } : {}),
    };
    await repository.saveScene(created);
  }

  // 7) 记忆：合并链（supersedes / supersededBy）指向的也是记忆 id
  const memories: MemoryEvent[] = archive.memories.map((memory) => ({
    ...memory,
    id: maps.memories.get(memory.id) ?? asEventId(newId()),
    roomId,
    conversationId: mapOptional(memory.conversationId, maps.conversations),
    sceneId: mapOptional(memory.sceneId, maps.scenes),
    participants: mapList(memory.participants, maps.instances),
    observerId: mapOptional(memory.observerId, maps.instances),
    affects: mapList(memory.affects, maps.instances),
    sourceTurnIds: memory.sourceTurnIds.map((id) => remapTurnId(id, maps)),
    ...(memory.supersedes === undefined ? {} : { supersedes: mapList(memory.supersedes, maps.memories) }),
    ...(memory.supersededBy === undefined ? {} : { supersededBy: mapOptional(memory.supersededBy, maps.memories) }),
  }));
  await repository.saveMemories(memories);

  // 8) 章节：保留原来的创建时间——章节按它排序，全设成同一刻顺序就乱了
  for (const chapter of archive.chapters) {
    await repository.saveChapterSummary({
      ...chapter,
      id: newId(),
      roomId,
      conversationId: mapOptional(chapter.conversationId, maps.conversations),
      sceneIds: mapList(chapter.sceneIds, maps.scenes),
      createdAt: typeof chapter.createdAt === 'string' && chapter.createdAt !== '' ? chapter.createdAt : at,
    });
  }

  // 9) 对话的当前场景指回来（场景是第 6 步才落库的），世界本身最后写
  for (const conversation of archive.conversations) {
    const activeSceneId = mapOptional(conversation.activeSceneId, maps.scenes);
    if (activeSceneId !== null) await repository.saveConversation(conversationFor(conversation, activeSceneId));
  }

  const activeConversationId =
    mapOptional(archive.room.activeConversationId, maps.conversations) ??
    mapOptional(archive.conversations[0]?.id, maps.conversations);
  const room: Room = {
    ...archive.room,
    id: roomId,
    personaId,
    cardIds: mapList(archive.room.cardIds, maps.cards),
    instanceIds: instances.map((instance) => instance.id),
    worldBookIds: mapList(archive.room.worldBookIds, maps.worldBooks),
    activeConversationId,
    updatedAt: at,
  };
  await repository.saveRoom(room);

  // 10) 账单：只为了把花费统计连上，缺了不影响使用
  if (options.ledger !== undefined) {
    for (const record of archive.usageRecords) {
      await options.ledger.record({
        roomId,
        conversationId: mapOptional(record.conversationId, maps.conversations),
        turnId: record.turnId === null ? null : remapTurnId(record.turnId, maps),
        category: record.category,
        model: record.model,
        promptTokens: record.promptTokens,
        completionTokens: record.completionTokens,
        speakerInstanceId: mapOptional(record.speakerInstanceId, maps.instances),
        speakerName: record.speakerName,
        price: record.price,
        at: record.createdAt,
      });
    }
  }
}
