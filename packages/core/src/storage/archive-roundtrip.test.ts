/**
 * 封存往返（审计 A11 / C7）：导出 → 导入 → 在新世界里归档 / 召回 / 场记收起都还对得上。
 *
 * 这条测试的意义是「以后新增引用字段还会漏」的守门员：任何一个交叉引用没改写，
 * 下面至少有一条断言会失败。
 */
import { describe, expect, it } from 'vitest';
import { coveredBySummary } from '../memory/summary.js';
import { createBlankCard } from '../model/card.js';
import { createConversation } from '../model/conversation.js';
import { eventId, newId, nowIso, roomId } from '../model/ids.js';
import type { MemoryEvent, Message } from '../model/message.js';
import type { Room } from '../model/room.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import { createInstanceFor, createSceneFor } from '../session/setup.js';
import { createPlayerMessage } from '../session/turn.js';
import {
  buildWorldArchive,
  IMPORT_PENDING_KEY_PREFIX,
  IMPORT_PENDING_STALE_MS,
  importWorldArchive,
  recoverInterruptedImports,
  type WorldArchive,
} from './archive.js';
import { Repository } from './repository.js';

const T0 = '2026-09-01T10:00:00.000Z';

function memory(room: Room, overrides: Partial<MemoryEvent>): MemoryEvent {
  return {
    id: eventId(newId()),
    roomId: room.id,
    conversationId: null,
    sceneId: null,
    timeline: { worldTime: '第一日', sequence: 1 },
    location: '',
    participants: [],
    summary: '一件事',
    observerId: null,
    perception: '',
    importance: 0.3,
    pinned: false,
    importanceLocked: false,
    affects: [],
    sourceTurnIds: [],
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    supersededBy: null,
    supersedes: [],
    consolidatedAt: null,
    lastRecalledAt: null,
    recallCount: 0,
    ...overrides,
  };
}

async function seedWorld(options: { legacyCursorOnly: boolean }) {
  const repository = new Repository(createMemoryEntityStore());
  const now = nowIso();
  const card = createBlankCard({ name: 'Alice' });
  await repository.saveCard(card);

  const room: Room = {
    id: roomId(newId()),
    title: '往返',
    personaId: null,
    playerName: '旅人',
    playerPersona: '',
    cardIds: [card.id],
    instanceIds: [],
    worldBookIds: [],
    activeConversationId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  const alice = createInstanceFor(card, room.id);
  // 对话开始前的状态：平静，对玩家有一点信任
  alice.relationships = [
    { target: 'player', trust: 0.1, affinity: 0, fear: 0, respect: 0, tension: 0, updatedAt: now, history: [] },
  ];
  const conversation = createConversation({ roomId: room.id, title: '主线', instances: [alice] });
  const scene = createSceneFor(room.id, conversation.id, [alice.id], { title: '开场' });
  await repository.saveSnapshot({
    room: { ...room, instanceIds: [alice.id], activeConversationId: conversation.id },
    conversations: [{ ...conversation, activeSceneId: scene.id }],
    instances: [alice],
  });

  // 先发三条再删掉：让活着的消息序号从 4 开始，导入后序号会从 1 重新发
  const filler = await repository.appendMessages(
    room.id,
    [1, 2, 3].map((index) => ({
      ...createPlayerMessage({
        roomId: room.id,
        sceneId: scene.id,
        turnId: `f${index}`,
        speakerName: '旅人',
        content: '废话',
      }),
      conversationId: conversation.id,
    })),
  );
  for (const item of filler) await repository.deleteMessage(item.id);

  const messages: Message[] = await repository.appendMessages(
    room.id,
    ['一', '二', '三', '四'].map((content, index) => ({
      ...createPlayerMessage({
        roomId: room.id,
        sceneId: scene.id,
        turnId: `turn-${String(index)}`,
        speakerName: '旅人',
        content,
      }),
      conversationId: conversation.id,
      ...(index === 3
        ? {
            artifacts: [
              {
                id: 'art-1',
                kind: 'character-card' as const,
                title: 'Alice',
                summary: '',
                status: 'adopted' as const,
                payload: { ...card },
                targetId: card.id,
                createdAt: now,
              },
            ],
          }
        : {}),
    })),
  );
  const [, second] = messages;
  if (second === undefined) throw new Error('fixture');

  // 场记覆盖到第二条
  await repository.saveScene({
    ...scene,
    recap: '玩家说了一和二。',
    recapUpToSeq: second.localSeq,
    ...(options.legacyCursorOnly ? {} : { recapUpToMessageId: second.id }),
  });

  // 记忆：m1 是情绪变化的来源；m2 已被印象 imp 合并
  const m1 = memory(room, { conversationId: conversation.id, sourceTurnIds: ['turn-0'], summary: '被夸了' });
  const impId = eventId(newId());
  const m2 = memory(room, {
    conversationId: conversation.id,
    sourceTurnIds: ['turn-1'],
    supersededBy: impId,
    consolidatedAt: now,
  });
  const imp = memory(room, {
    id: impId,
    conversationId: conversation.id,
    sourceTurnIds: ['turn-1'],
    supersedes: [m2.id],
    consolidatedAt: now,
    summary: '印象',
  });
  await repository.saveMemories([m1, m2, imp]);

  // 这条线里 Alice 的情绪与关系都变了，并且记着来源记忆
  await repository.saveInstance({
    ...alice,
    affect: {
      ...alice.affect,
      valence: 0.8,
      history: [
        {
          id: 'c1',
          at: now,
          turnId: 'turn-0',
          beforeValence: 0,
          afterValence: 0.8,
          beforeArousal: 0,
          afterArousal: 0,
          deltaValence: 0.8,
          deltaArousal: 0,
          reason: '被夸了',
          sourceMemoryIds: [m1.id],
          reversionOf: null,
        },
      ],
    },
    relationships: [
      { target: 'player', trust: 0.9, affinity: 0, fear: 0, respect: 0, tension: 0, updatedAt: now, history: [] },
    ],
  });

  // 两章，创建时间不同
  for (const [index, createdAt] of ['2026-09-01T10:00:00.000Z', '2026-09-02T10:00:00.000Z'].entries()) {
    await repository.saveChapterSummary({
      id: newId(),
      roomId: room.id,
      conversationId: conversation.id,
      title: `第 ${String(index + 1)} 章`,
      sceneIds: [scene.id],
      summary: '',
      keyFacts: [],
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
    });
  }

  const loaded = await repository.loadRoom(room.id);
  if (!loaded) throw new Error('fixture');
  return buildWorldArchive({ ...loaded, persona: null });
}

async function importInto(archive: WorldArchive) {
  const target = new Repository(createMemoryEntityStore());
  const report = await importWorldArchive(archive, target);
  const loaded = await target.loadRoom(report.roomId);
  if (!loaded) throw new Error('导入后读不回来');
  return { target, loaded };
}

describe('封存往返（审计 A11）', () => {
  for (const legacyCursorOnly of [false, true]) {
    it(`场记游标按新序号重算（${legacyCursorOnly ? '只有老序号游标' : '消息 id 游标'}）`, async () => {
      const archive = await seedWorld({ legacyCursorOnly });
      const { loaded } = await importInto(archive);
      const scene = loaded.scenes[0];
      if (scene === undefined) throw new Error('缺场景');
      const covered = coveredBySummary(scene, loaded.messages);
      expect(loaded.messages.filter((item) => covered.has(item.id)).map((item) => item.content)).toEqual(['一', '二']);
      expect(scene.recapUpToSeq).toBe(loaded.messages[1]?.localSeq);
    });
  }

  it('归档导入后的对话：状态快照能匹配到新角色并回滚', async () => {
    const archive = await seedWorld({ legacyCursorOnly: false });
    const { target, loaded } = await importInto(archive);
    const conversation = loaded.conversations[0];
    if (conversation === undefined) throw new Error('缺对话');
    expect(conversation.stateSnapshot[0]?.instanceId).toBe(loaded.instances[0]?.id);

    const report = await target.archiveConversation(conversation.id);
    expect(report?.restoredInstances).toBe(1);
    const [alice] = await target.listInstances(loaded.room.id);
    expect(alice?.affect.valence).toBe(0);
    expect(alice?.relationships[0]?.trust).toBe(0.1);
  });

  it('记忆合并链、情绪来源、草稿目标都指向新 id；章节保留原时间与顺序', async () => {
    const archive = await seedWorld({ legacyCursorOnly: false });
    const { loaded } = await importInto(archive);
    const memoryIds = new Set(loaded.memories.map((item) => item.id as string));

    const impression = loaded.memories.find((item) => item.summary === '印象');
    const original = loaded.memories.find((item) => item.supersededBy !== null && item.supersededBy !== undefined);
    expect(impression?.supersedes).toEqual([original?.id]);
    expect(original?.supersededBy).toBe(impression?.id);

    const source = loaded.instances[0]?.affect.history[0]?.sourceMemoryIds[0];
    expect(source !== undefined && memoryIds.has(source)).toBe(true);

    const artifact = loaded.messages.find((item) => item.artifacts !== undefined)?.artifacts?.[0];
    expect(artifact?.targetId).toBe(loaded.cards[0]?.id);
    expect(artifact?.targetId).not.toBe(archive.cards[0]?.id);

    expect(loaded.chapters.map((item) => item.createdAt)).toEqual([
      '2026-09-01T10:00:00.000Z',
      '2026-09-02T10:00:00.000Z',
    ]);
    expect(loaded.chapters.map((item) => item.title)).toEqual(['第 1 章', '第 2 章']);
  });

  it('草稿指向封存外的素材时清空目标，免得撤回采纳删掉本机的原卡', async () => {
    const archive = await seedWorld({ legacyCursorOnly: false });
    const withoutCards: WorldArchive = { ...archive, cards: [] };
    const { loaded } = await importInto(withoutCards);
    const artifact = loaded.messages.find((item) => item.artifacts !== undefined)?.artifacts?.[0];
    expect(artifact?.targetId).toBeNull();
  });
});

describe('导入失败回滚（审计 C7）', () => {
  it('中途失败：不留半个世界，也不留标记', async () => {
    const archive = await seedWorld({ legacyCursorOnly: false });
    const target = new Repository(createMemoryEntityStore());
    const original = target.saveMemories.bind(target);
    target.saveMemories = async () => {
      throw new Error('配额满了');
    };
    await expect(importWorldArchive(archive, target)).rejects.toThrow('配额满了');
    target.saveMemories = original;

    expect(await target.listRooms()).toEqual([]);
    expect(await target.listCards()).toEqual([]);
    expect(await target.listMetaKeys(IMPORT_PENDING_KEY_PREFIX)).toEqual([]);
  });

  it('页面被关掉留下的标记：下次启动撤掉那半个世界', async () => {
    const archive = await seedWorld({ legacyCursorOnly: false });
    const target = new Repository(createMemoryEntityStore());
    const report = await importWorldArchive(archive, target);
    // 模拟：写完了但标记没来得及清（等价于中途被打断），而且那一趟早就没了
    await target.setMeta(`${IMPORT_PENDING_KEY_PREFIX}${newId()}`, {
      roomId: report.roomId,
      cardIds: (await target.listCards()).map((item) => item.id),
      worldBookIds: [],
      personaId: null,
      startedAt: new Date(Date.now() - IMPORT_PENDING_STALE_MS - 1000).toISOString(),
    });

    const recovery = await recoverInterruptedImports(target);
    expect(recovery.rooms).toEqual([report.roomId]);
    expect(await target.listRooms()).toEqual([]);
    expect(await target.listMetaKeys(IMPORT_PENDING_KEY_PREFIX)).toEqual([]);
    expect(await recoverInterruptedImports(target)).toEqual({ rooms: [], stillPending: 0 });
  });

  it('另一个标签页的导入还活着时不动它的标记（审计 C7：一次导入一把钥匙）', async () => {
    const archive = await seedWorld({ legacyCursorOnly: false });
    const target = new Repository(createMemoryEntityStore());
    const otherKey = `${IMPORT_PENDING_KEY_PREFIX}${newId()}`;
    await target.setMeta(otherKey, {
      roomId: 'room-other-tab',
      cardIds: [],
      worldBookIds: [],
      personaId: null,
      startedAt: nowIso(),
    });

    // 这一趟走完了：只清自己的标记，不碰别人的
    const report = await importWorldArchive(archive, target);
    expect(await target.getMeta(otherKey)).not.toBeNull();

    // 还太新：这一轮启动不动它（动了就等于删掉人家正在写的世界）
    const fresh = await recoverInterruptedImports(target);
    expect(fresh).toEqual({ rooms: [], stillPending: 1 });
    expect(await target.getMeta(otherKey)).not.toBeNull();
    expect((await target.listRooms()).map((item) => item.id)).toEqual([report.roomId]);

    // 等它「死透」再收拾：撤掉那一趟，本机刚导入的世界不受影响
    const stale = await recoverInterruptedImports(target, { now: Date.now() + IMPORT_PENDING_STALE_MS + 1000 });
    expect(stale).toEqual({ rooms: [roomId('room-other-tab')], stillPending: 0 });
    expect((await target.listRooms()).map((item) => item.id)).toEqual([report.roomId]);
    expect(await target.listMetaKeys(IMPORT_PENDING_KEY_PREFIX)).toEqual([]);
  });

  it('认不出来的标记直接删掉，不留在库里每次启动翻一遍', async () => {
    const target = new Repository(createMemoryEntityStore());
    const key = `${IMPORT_PENDING_KEY_PREFIX}${newId()}`;
    await target.setMeta(key, { roomId: 42 });

    expect(await recoverInterruptedImports(target)).toEqual({ rooms: [], stillPending: 0 });
    expect(await target.listMetaKeys(IMPORT_PENDING_KEY_PREFIX)).toEqual([]);
  });

  it('老版本留下的单键标记也认（不然那半个世界永远没人收拾）', async () => {
    const archive = await seedWorld({ legacyCursorOnly: false });
    const target = new Repository(createMemoryEntityStore());
    const report = await importWorldArchive(archive, target);
    const legacy = {
      roomId: report.roomId,
      cardIds: [],
      worldBookIds: [],
      personaId: null,
    };

    // 还太新：老版本的标签页可能正在导入，先不动它
    await target.setMeta('archive.importPending', { ...legacy, startedAt: nowIso() });
    expect(await recoverInterruptedImports(target)).toEqual({ rooms: [], stillPending: 1 });

    // 死透了：照样撤掉，并把旧钥匙清掉
    await target.setMeta('archive.importPending', {
      ...legacy,
      startedAt: new Date(Date.now() - IMPORT_PENDING_STALE_MS - 1000).toISOString(),
    });
    expect((await recoverInterruptedImports(target)).rooms).toEqual([report.roomId]);
    expect(await target.getMeta('archive.importPending')).toBeNull();
    expect((await target.listRooms()).map((item) => item.id)).toEqual([]);
  });

  it('正常导入不留标记', async () => {
    const archive = await seedWorld({ legacyCursorOnly: false });
    const target = new Repository(createMemoryEntityStore());
    await importWorldArchive(archive, target);
    expect(await target.listMetaKeys(IMPORT_PENDING_KEY_PREFIX)).toEqual([]);
    expect(await recoverInterruptedImports(target)).toEqual({ rooms: [], stillPending: 0 });
  });
});
