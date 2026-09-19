import { describe, expect, it } from 'vitest';
import { createBlankCard } from '../model/card.js';
import { createConversation } from '../model/conversation.js';
import { eventId, messageId, newId, nowIso, roomId, sceneId, worldBookId } from '../model/ids.js';
import type { Message } from '../model/message.js';
import { createPersona } from '../model/persona.js';
import type { Room, Scene } from '../model/room.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import { createInstanceFor, createSceneFor } from '../session/setup.js';
import type { WorldArchive } from './archive.js';
import {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  buildWorldArchive,
  countArchive,
  importWorldArchive,
  parseWorldArchive,
} from './archive.js';
import { Repository } from './repository.js';
import { createUsageLedger, type UsageLedger } from './usage.js';

const AT = '2026-09-19T21:00:00.000Z';

/** 造一个「什么都有」的世界：两条对话、一个场景、两个角色、消息、记忆、章节、账单。 */
async function seed(): Promise<{ repository: Repository; roomId: Room['id'] }> {
  const repository = new Repository(createMemoryEntityStore());
  const now = nowIso();

  const card = createBlankCard({ name: '陈九', description: '跑船的' });
  const secondCard = createBlankCard({ name: '小满', description: '书铺学徒' });
  await repository.saveCard(card);
  await repository.saveCard(secondCard);

  const book = {
    id: worldBookId(newId()),
    name: '旧城设定',
    description: '',
    entries: [],
    extensions: {},
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  await repository.saveWorldBook(book);

  const persona = createPersona({ name: '旅人', description: '从东岸过来' });
  await repository.savePersona(persona);

  const room: Room = {
    id: roomId(newId()),
    title: '旧城',
    personaId: persona.id,
    playerName: persona.name,
    playerPersona: persona.description,
    cardIds: [card.id, secondCard.id],
    instanceIds: [],
    worldBookIds: [book.id],
    activeConversationId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  await repository.saveRoom(room);

  const main = createConversation({ roomId: room.id, title: '主线' });
  const side = createConversation({ roomId: room.id, title: '世界管理', kind: 'side' });
  await repository.saveConversation(main);
  await repository.saveConversation(side);

  const chen = createInstanceFor(card, room.id, '陈九');
  const man = createInstanceFor(secondCard, room.id, '小满');
  // 角色之间的关系指向角色 id——导入时最容易被漏掉的一处引用
  chen.relationships = [
    {
      target: man.id,
      trust: 0.2,
      affinity: 0.1,
      fear: 0,
      respect: 0.3,
      tension: 0.4,
      updatedAt: now,
      history: [],
    },
  ];
  await repository.saveInstance(chen);
  await repository.saveInstance(man);

  const scene: Scene = {
    ...createSceneFor(room.id, main.id, [chen.id, man.id], { title: '雨夜', location: '旧城酒馆' }),
    summary: '酒馆的设定',
    recap: '玩家问起三十箱货，陈九没正面回答。',
    recapUpToSeq: 3,
  };
  await repository.saveScene(scene);

  const messages: Message[] = [
    {
      id: messageId(newId()),
      roomId: room.id,
      conversationId: main.id,
      sceneId: scene.id,
      turnId: 'turn-a',
      localSeq: 0,
      deviceId: '',
      role: 'player',
      speakerInstanceId: null,
      speakerName: '旅人',
      audience: [chen.id, man.id],
      content: '三十箱货是谁的？',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: messageId(newId()),
      roomId: room.id,
      conversationId: main.id,
      sceneId: scene.id,
      turnId: 'turn-a',
      localSeq: 0,
      deviceId: '',
      role: 'character',
      speakerInstanceId: chen.id,
      speakerName: '陈九',
      audience: [chen.id, man.id],
      content: '「这你得去问跑船的。」',
      usage: { promptTokens: 100, completionTokens: 20 },
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ];
  await repository.appendMessages(room.id, messages);

  await repository.saveMemories([
    {
      id: eventId(newId()),
      roomId: room.id,
      conversationId: main.id,
      sceneId: scene.id,
      timeline: { worldTime: '第三日 · 夜', sequence: 1 },
      location: '旧城酒馆',
      participants: [chen.id, man.id],
      summary: '玩家问起三十箱没有清单的货。',
      observerId: chen.id,
      perception: '他在试探我。',
      importance: 0.7,
      pinned: false,
      importanceLocked: false,
      affects: [man.id],
      sourceTurnIds: ['turn-a'],
      createdAt: now,
      updatedAt: now,
      lastRecalledAt: null,
      recallCount: 0,
      deletedAt: null,
    },
  ]);

  await repository.saveChapterSummary({
    id: newId(),
    roomId: room.id,
    conversationId: main.id,
    title: '第 1 章 · 旧城',
    sceneIds: [scene.id],
    summary: '玩家开始追查一批没有清单的货。',
    keyFacts: ['三十箱货在胡记'],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });

  await repository.saveRoom({ ...room, activeConversationId: main.id });
  return { repository, roomId: room.id };
}

async function archiveOf(
  repository: Repository,
  id: Room['id'],
  ledger: UsageLedger = createUsageLedger(createMemoryEntityStore()),
): Promise<WorldArchive> {
  const loaded = await repository.loadRoom(id);
  if (!loaded) throw new Error('造出来的世界读不回来');

  await ledger.record({
    roomId: id,
    conversationId: loaded.conversations[0]?.id ?? null,
    turnId: 'turn-a',
    category: 'generation',
    model: 'deepseek-chat',
    promptTokens: 100,
    completionTokens: 20,
  });

  return buildWorldArchive({
    room: loaded.room,
    conversations: loaded.conversations,
    scenes: loaded.scenes,
    instances: loaded.instances,
    messages: loaded.messages,
    memories: loaded.memories,
    chapters: loaded.chapters,
    cards: loaded.cards,
    worldBooks: loaded.worldBooks,
    persona: loaded.personas.find((item) => item.id === loaded.room.personaId) ?? null,
    usageRecords: await ledger.list({ roomId: id }),
    at: AT,
  });
}

describe('封存导出 / 导入（P2-4）', () => {
  it('导出的是一份自洽的 JSON：格式、版本、时间、各集合条数都对得上', async () => {
    const source = await seed();
    const archive = await archiveOf(source.repository, source.roomId);

    const parsed = parseWorldArchive(JSON.stringify(archive, null, 2));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.archive.format).toBe(ARCHIVE_FORMAT);
    expect(parsed.archive.version).toBe(ARCHIVE_VERSION);
    expect(parsed.archive.exportedAt).toBe(AT);
    expect(parsed.archive.title).toBe('旧城');
    expect(countArchive(parsed.archive)).toEqual({
      conversations: 2,
      scenes: 1,
      instances: 2,
      messages: 2,
      memories: 1,
      chapters: 1,
      cards: 2,
      worldBooks: 1,
      usageRecords: 1,
    });
  });

  it('导入之后是同一个世界：条数一致，引用全部指向新 id', async () => {
    const source = await seed();
    const archive = await archiveOf(source.repository, source.roomId);

    const target = new Repository(createMemoryEntityStore());
    const ledger = createUsageLedger(createMemoryEntityStore());
    const report = await importWorldArchive(archive, target, { ledger, at: AT });

    expect(report.roomId).not.toBe(source.roomId);
    expect(report.counts.messages).toBe(2);

    const loaded = await target.loadRoom(report.roomId);
    expect(loaded).not.toBeNull();
    if (!loaded) return;

    expect(loaded.conversations).toHaveLength(2);
    expect(loaded.scenes).toHaveLength(1);
    expect(loaded.instances).toHaveLength(2);
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.memories).toHaveLength(1);
    expect(loaded.chapters).toHaveLength(1);
    expect(loaded.cards).toHaveLength(2);
    expect(loaded.worldBooks).toHaveLength(1);

    const oldIds = [
      source.roomId,
      ...archive.instances.map((item) => item.id),
      ...archive.messages.map((item) => item.id),
      ...archive.memories.map((item) => item.id),
      ...archive.cards.map((item) => item.id),
      ...archive.scenes.map((item) => item.id),
      ...archive.conversations.map((item) => item.id),
    ];
    const newIds = [
      report.roomId,
      ...loaded.instances.map((item) => item.id),
      ...loaded.messages.map((item) => item.id),
      ...loaded.memories.map((item) => item.id),
      ...loaded.cards.map((item) => item.id),
    ];
    for (const id of newIds) expect(oldIds).not.toContain(id);

    const instanceIds = new Set(loaded.instances.map((item) => item.id as string));
    const sceneIds = new Set(loaded.scenes.map((item) => item.id as string));
    const cardIds = new Set(loaded.cards.map((item) => item.id as string));

    expect(loaded.room.activeConversationId).not.toBeNull();
    expect(loaded.room.instanceIds.every((item) => instanceIds.has(item))).toBe(true);
    expect(loaded.room.cardIds.every((item) => cardIds.has(item))).toBe(true);
    expect(loaded.instances.every((item) => cardIds.has(item.cardId))).toBe(true);
    expect(loaded.messages.every((item) => item.sceneId !== null && sceneIds.has(item.sceneId))).toBe(true);
    expect(loaded.messages.every((item) => item.audience.every((id) => instanceIds.has(id)))).toBe(true);
    expect(loaded.scenes[0]?.cast.every((item) => instanceIds.has(item))).toBe(true);
    const observer = loaded.memories[0]?.observerId ?? null;
    expect(observer === null || instanceIds.has(observer)).toBe(true);
    expect(loaded.memories[0]?.participants.every((item) => instanceIds.has(item))).toBe(true);
    expect(loaded.chapters[0]?.sceneIds.every((item) => sceneIds.has(item))).toBe(true);

    // 角色之间的关系也得跟着改指名
    const chen = loaded.instances.find((item) => item.displayName === '陈九');
    const man = loaded.instances.find((item) => item.displayName === '小满');
    expect(chen?.relationships[0]?.target).toBe(man?.id);

    // 场景的场记（含游标）跟着走
    expect(loaded.scenes[0]?.recap).toContain('三十箱');
    expect(loaded.scenes[0]?.recapUpToSeq).toBe(3);

    // 账单连得上
    expect((await ledger.summary({ roomId: report.roomId })).total.calls).toBe(1);
  });

  it('同一个封存可以重复导入：两次得到两个互不相干的世界', async () => {
    const source = await seed();
    const archive = await archiveOf(source.repository, source.roomId);

    const target = new Repository(createMemoryEntityStore());
    const first = await importWorldArchive(archive, target, { at: AT });
    const second = await importWorldArchive(archive, target, { at: AT });

    expect(first.roomId).not.toBe(second.roomId);
    expect(await target.listRooms()).toHaveLength(2);
    for (const report of [first, second]) {
      expect((await target.loadRoom(report.roomId))?.messages).toHaveLength(2);
    }
  });

  it('导入不会覆盖本机已有的世界', async () => {
    const source = await seed();
    const archive = await archiveOf(source.repository, source.roomId);

    const target = new Repository(createMemoryEntityStore());
    const existing = await seed();
    await importWorldArchive(await archiveOf(existing.repository, existing.roomId), target, { at: AT });
    const before = await target.listRooms();

    await importWorldArchive(archive, target, { at: AT });
    const after = await target.listRooms();

    expect(after).toHaveLength(before.length + 1);
    for (const room of before) {
      expect((await target.loadRoom(room.id))?.messages).toHaveLength(2);
    }
  });

  it('选错文件时给人话：不是 JSON、不是封存、版本太新', () => {
    expect(parseWorldArchive('这不是 JSON').ok).toBe(false);

    const wrong = parseWorldArchive('{"format":"chara_card_v2"}');
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toContain('导入素材');

    const future = parseWorldArchive(
      JSON.stringify({ format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION + 1, room: { id: 'r', title: 't' } }),
    );
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.error).toContain('更新的版本');
  });

  it('缺字段的封存不会硬塞进库：明确报错', () => {
    const parsed = parseWorldArchive(JSON.stringify({ format: ARCHIVE_FORMAT, version: 1 }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('不完整');
  });

  it('空世界也能导出与导入', async () => {
    const repository = new Repository(createMemoryEntityStore());
    const room: Room = {
      id: roomId(newId()),
      title: '空世界',
      personaId: null,
      playerName: '玩家',
      playerPersona: '',
      cardIds: [],
      instanceIds: [],
      worldBookIds: [],
      activeConversationId: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      deletedAt: null,
    };
    await repository.saveRoom(room);

    const archive = await archiveOf(repository, room.id);
    const target = new Repository(createMemoryEntityStore());
    const report = await importWorldArchive(archive, target, { at: AT });

    expect(report.title).toBe('空世界');
    const loaded = await target.loadRoom(report.roomId);
    expect(loaded?.messages).toEqual([]);
    expect(loaded?.scenes).toEqual([]);
  });

  it('场景 id 会被重映射，而不是原样抄一份', async () => {
    const source = await seed();
    const archive = await archiveOf(source.repository, source.roomId);
    const target = new Repository(createMemoryEntityStore());
    const report = await importWorldArchive(archive, target, { at: AT });

    const loaded = await target.loadRoom(report.roomId);
    expect(loaded?.scenes[0]?.id).not.toBe(sceneId(archive.scenes[0]?.id ?? ''));
  });
});
