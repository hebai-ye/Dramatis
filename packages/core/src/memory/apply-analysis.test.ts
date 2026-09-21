import { describe, expect, it } from 'vitest';
import { createBlankCard } from '../model/card.js';
import { conversationId, instanceId, roomId } from '../model/ids.js';
import { createPersona } from '../model/persona.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import { createWorldFromCard } from '../session/setup.js';
import { Repository } from '../storage/repository.js';
import { applyTurnAnalysis } from './apply-analysis.js';

async function seed() {
  const repository = new Repository(createMemoryEntityStore());
  const persona = createPersona({ name: '沈砚' });
  const card = createBlankCard({ name: '秦娘' });
  const world = createWorldFromCard(card, persona);
  await repository.savePersona(persona);
  await repository.saveCard(card);
  await repository.saveRoom(world.room);
  await repository.saveConversation(world.conversation);
  await repository.saveScene(world.scene);
  await repository.saveInstance(world.instance);
  return { repository, world };
}

const OUTPUT = JSON.stringify({
  summary: '玩家问起那批货单的去向，秦娘说账房里还压着一份。',
  importance: 0.6,
  location: '货栈',
  observations: [{ speaker: '秦娘', perception: '他先问货单，说明他知道点什么。' }],
  updates: [
    {
      observer: '秦娘',
      deltaValence: 0.1,
      deltaArousal: 0.1,
      reason: '被问到货单，警觉起来。',
      relationship: [{ field: 'trust', delta: -0.1 }],
    },
  ],
});

describe('applyTurnAnalysis', () => {
  it('一次落库：1 条客观 + N 条视角，并把状态变化记在同一个 turnId 上', async () => {
    const { repository, world } = await seed();
    const result = await applyTurnAnalysis({
      repository,
      roomId: world.room.id,
      sceneId: world.scene.id,
      conversationId: world.conversation.id,
      turnId: 'turn-1',
      worldTime: '第九日',
      participants: [world.instance],
      raw: OUTPUT,
      at: '2026-09-20T10:00:00.000Z',
    });

    expect(result.memories).toBe(2);
    expect(result.updates).toBe(1);

    const memories = await repository.listMemories(world.room.id);
    const objective = memories.filter((memory) => memory.observerId === null);
    const views = memories.filter((memory) => memory.observerId !== null);
    expect(objective).toHaveLength(1);
    expect(views).toHaveLength(1);
    expect(objective[0]?.summary).toContain('货单');
    expect(objective[0]?.conversationId).toBe(world.conversation.id);
    expect(objective[0]?.timeline.worldTime).toBe('第九日');

    const [instance] = await repository.listInstances(world.room.id);
    expect(instance?.affect.history.some((change) => change.turnId === 'turn-1')).toBe(true);
    expect(instance?.affect.history[0]?.sourceMemoryIds).toEqual([views[0]?.id]);
  });

  it('粘回来一段脏文本也能收下（解析层本来就宽容）', async () => {
    const { repository, world } = await seed();
    const result = await applyTurnAnalysis({
      repository,
      roomId: world.room.id,
      sceneId: world.scene.id,
      conversationId: world.conversation.id,
      turnId: 'turn-2',
      worldTime: '',
      participants: [world.instance],
      raw: `好的，这是你要的 JSON：\n\n\`\`\`json\n${OUTPUT}\n\`\`\``,
    });

    expect(result.memories).toBe(2);
  });

  it('同一轮贴两次：记忆按最新那份重写，状态不会翻倍（幂等）', async () => {
    const { repository, world } = await seed();
    const input = {
      repository,
      roomId: world.room.id,
      sceneId: world.scene.id,
      conversationId: world.conversation.id,
      turnId: 'turn-3',
      worldTime: '',
      participants: [world.instance],
    };

    await applyTurnAnalysis({ ...input, raw: OUTPUT });
    const first = await repository.listMemories(world.room.id);
    const second = await applyTurnAnalysis({ ...input, raw: OUTPUT });
    const after = await repository.listMemories(world.room.id);

    expect(after).toHaveLength(first.length);
    expect(second.updates).toBe(0); // 已经推演过，不再叠加

    const [instance] = await repository.listInstances(world.room.id);
    const changes = instance?.affect.history.filter((change) => change.turnId === 'turn-3') ?? [];
    expect(changes).toHaveLength(1);
  });

  it('名字对不上在场角色时：客观条目照写，视角条目落到 unmatchedSpeakers 里', async () => {
    const { repository, world } = await seed();
    const raw = JSON.stringify({
      summary: '有人在门外喊了一句。',
      importance: 0.3,
      location: '',
      observations: [{ speaker: '连名字都没有的人', perception: '……' }],
      updates: [],
    });

    const result = await applyTurnAnalysis({
      repository,
      roomId: world.room.id,
      sceneId: world.scene.id,
      conversationId: world.conversation.id,
      turnId: 'turn-4',
      worldTime: '',
      participants: [world.instance],
      raw,
    });

    expect(result.memories).toBe(1);
    expect(result.unmatchedSpeakers).toEqual(['连名字都没有的人']);
  });
});

describe('applyTurnAnalysis 与 conversationId', () => {
  it('记忆带上这条记忆属于哪条对话（归档时要按它整批撤销）', async () => {
    const { repository, world } = await seed();
    const other = conversationId('conv-other');
    await applyTurnAnalysis({
      repository,
      roomId: world.room.id,
      sceneId: null,
      conversationId: other,
      turnId: 'turn-5',
      worldTime: '',
      participants: [world.instance],
      raw: OUTPUT,
    });

    const memories = await repository.listMemories(world.room.id, { conversationId: other });
    expect(memories).toHaveLength(2);
    expect(memories.every((memory) => memory.conversationId === other)).toBe(true);
  });
});

describe('instanceId 归一', () => {
  it('参与者传的是实例 id，视角条目的 observerId 与之一致', async () => {
    const { repository, world } = await seed();
    await applyTurnAnalysis({
      repository,
      roomId: world.room.id,
      sceneId: world.scene.id,
      conversationId: world.conversation.id,
      turnId: 'turn-6',
      worldTime: '',
      participants: [world.instance],
      raw: OUTPUT,
    });

    const views = (await repository.listMemories(world.room.id)).filter((memory) => memory.observerId !== null);
    expect(views[0]?.observerId).toBe(instanceId(world.instance.id));
    expect(roomId(world.room.id)).toBe(world.room.id);
  });
});
