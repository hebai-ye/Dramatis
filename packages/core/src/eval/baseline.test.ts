import { describe, expect, it } from 'vitest';
import { scheduleSpeakers, turnsSinceLastSpoke } from '../director/scheduler.js';
import { buildExtractionMessages, parseExtraction } from '../memory/extract.js';
import { buildMemoryEvents } from '../memory/ingest.js';
import { recallMemories, selectWithinBudget } from '../memory/recall.js';
import type { Card } from '../model/card.js';
import { cardId, instanceId, newId, nowIso, PLAYER, roomId, sceneId } from '../model/ids.js';
import { type CharacterInstance, neutralTraits, type Presence } from '../model/instance.js';
import type { MemoryEvent } from '../model/message.js';
import type { Room, Scene } from '../model/room.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import { assemblePrompt } from '../prompt/assemble.js';
import type { ChatMessage } from '../prompt/types.js';
import type { ChatStreamEvent, ModelProvider } from '../provider/openai-compatible.js';
import { createCharacterMessage, createPlayerMessage } from '../session/turn.js';
import { Repository } from '../storage/repository.js';

/**
 * P1-10 评测基线的自动化部分（ROADMAP P1-10）。
 *
 * 走真实的调度、装配、召回、抽取、落库管线，只有模型是脚本化的。
 * 目的是把「工程约束有没有被守住」变成可重复的断言——预算会不会爆、
 * 记忆会不会串味、重抽有没有回滚干净——这些都不该依赖肉眼判断。
 *
 * 它**不**衡量对话质量。质量需要真实模型，见 tools/eval 里的手工验证步骤。
 */
const TOTAL_TURNS = 50;

interface ScriptedContext {
  turn: number;
}

function scriptedProvider(context: ScriptedContext): ModelProvider {
  return {
    id: 'scripted',
    model: 'scripted',

    async *chat(messages: ChatMessage[]): AsyncIterable<ChatStreamEvent> {
      const userContent = messages.find((message) => message.role === 'user')?.content ?? '';
      const isExtraction = messages.some((message) => message.content.includes('observations'));

      if (isExtraction) {
        const roster = /在场角色：(.+)/.exec(userContent)?.[1] ?? '';
        const speakers = roster
          .split('、')
          .map((name) => name.trim())
          .filter((name) => name !== '');

        const payload = {
          summary: `第 ${context.turn} 轮：玩家和在场的人交换了几句话。`,
          importance: 0.4 + (context.turn % 5) * 0.1,
          location: context.turn === 20 ? '旧城东侧的酒馆' : '',
          observations: speakers.map((speaker) => ({
            speaker,
            perception: `${speaker}在第 ${context.turn} 轮里留意到玩家提到了「商队」。`,
          })),
        };

        // 故意套一层代码块与前后废话，检验解析器的容错
        yield { type: 'text', text: `好的，这是记录：\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`` };
        yield { type: 'done', usage: null };
        return;
      }

      yield { type: 'text', text: `我明白了。这是第 ${context.turn} 轮，我们继续。` };
      yield { type: 'done', usage: null };
    },

    async listModels() {
      return ['scripted'];
    },
  };
}

function makeCard(name: string): Card {
  return {
    id: cardId(newId()),
    name,
    nickname: '',
    description: `${name}的描述`,
    personality: '普通',
    scenario: '',
    firstMessage: '',
    alternateGreetings: [],
    exampleMessages: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    creator: '',
    creatorNotes: '',
    characterVersion: '',
    tags: [],
    embeddedWorldBook: null,
    extensions: {},
    source: { kind: 'manual', spec: 'dramatis', specVersion: '1', importedAt: nowIso() },
    createdAt: nowIso(),
    updatedAt: nowIso(),
    deletedAt: null,
  };
}

function makeInstance(card: Card, room: Room, name: string, presence: Presence): CharacterInstance {
  const now = nowIso();
  return {
    id: instanceId(newId()),
    roomId: room.id,
    cardId: card.id,
    displayName: name,
    presence,
    traits: { ...neutralTraits(), extroversion: name === 'Bob' ? 0.6 : -0.2 },
    affect: { valence: 0, arousal: 0, updatedAt: now, history: [] },
    relationships: [
      { target: PLAYER, trust: 0, affinity: 0, fear: 0, respect: 0, tension: 0, updatedAt: now, history: [] },
    ],
    traitsLocked: false,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

async function collect(provider: ModelProvider, messages: ChatMessage[]): Promise<string> {
  let full = '';
  for await (const event of provider.chat(messages)) {
    if (event.type === 'text') full += event.text;
  }
  return full;
}

describe('长跑基线（P1-10）', () => {
  it(`${TOTAL_TURNS} 回合：预算不爆、记忆按视角累积、重抽回滚干净`, async () => {
    const repository = new Repository(createMemoryEntityStore());
    const roomIdValue = roomId(newId());
    const sceneIdValue = sceneId(newId());
    const now = nowIso();

    const aliceCard = makeCard('Alice');
    const bobCard = makeCard('Bob');
    const carolCard = makeCard('Carol');

    const room: Room = {
      id: roomIdValue,
      title: '长跑测试',
      personaId: null,
      playerName: '旅人',
      playerPersona: '',
      cardIds: [aliceCard.id, bobCard.id, carolCard.id],
      instanceIds: [],
      worldBookIds: [],
      activeConversationId: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };

    const alice = makeInstance(aliceCard, room, 'Alice', 'onstage');
    const bob = makeInstance(bobCard, room, 'Bob', 'onstage');
    // Carol 全程在幕后：她不该被调度上台，也不该拿到任何记忆
    const carol = makeInstance(carolCard, room, 'Carol', 'offscreen');
    room.instanceIds = [alice.id, bob.id, carol.id];

    const scene: Scene = {
      id: sceneIdValue,
      roomId: roomIdValue,
      conversationId: null,
      title: '开场',
      location: '',
      worldTime: '第一日',
      castPolicy: 'locked',
      cast: [alice.id, bob.id],
      summary: '',
      createdAt: now,
      updatedAt: now,
      endedAt: null,
      deletedAt: null,
    };

    await repository.saveSnapshot({
      room,
      scenes: [scene],
      instances: [alice, bob, carol],
      cards: [aliceCard, bobCard, carolCard],
    });

    const context: ScriptedContext = { turn: 0 };
    const provider = scriptedProvider(context);
    const participants = [alice, bob];
    const cards = new Map([
      [alice.id, aliceCard],
      [bob.id, bobCard],
    ]);

    let messages = await repository.listMessages(roomIdValue);
    let memories: MemoryEvent[] = [];
    let maxPromptTokens = 0;
    let degradedTurns = 0;
    const speakerCounts = new Map<string, number>();

    for (let turn = 1; turn <= TOTAL_TURNS; turn += 1) {
      context.turn = turn;
      const turnId = newId();
      const playerText = turn % 7 === 0 ? '你记得之前提到的那支商队吗？' : `第 ${turn} 轮，我们继续。`;

      await repository.appendMessages(roomIdValue, [
        createPlayerMessage({
          roomId: roomIdValue,
          sceneId: scene.id,
          turnId,
          speakerName: room.playerName,
          content: playerText,
          audience: scene.cast,
        }),
      ]);

      const since = turnsSinceLastSpoke(messages, turnId);
      const schedule = scheduleSpeakers({
        playerInput: playerText,
        candidates: [alice, bob, carol].map((instance) => ({
          instance,
          turnsSinceSpoke: since.get(instance.id) ?? null,
        })),
        maxSpeakers: 1,
      });

      expect(schedule.speakers).not.toContain(carol.id);
      expect(schedule.speakers.length).toBeGreaterThan(0);

      for (const speakerId of schedule.speakers) {
        const speaker = participants.find((member) => member.id === speakerId);
        if (!speaker) throw new Error('调度到了不在场的角色');

        const recalled = selectWithinBudget(
          recallMemories(memories, {
            observerId: speaker.id,
            text: playerText,
            participantIds: scene.cast,
            location: scene.location,
            now: new Date().toISOString(),
          }),
          800,
        );
        expect(recalled.every((item) => item.event.observerId === speaker.id)).toBe(true);

        const prompt = assemblePrompt({
          card: cards.get(speaker.id) ?? aliceCard,
          instance: speaker,
          room,
          scene,
          cast: participants,
          history: messages,
          playerInput: playerText,
          memories: recalled.map((item) => ({
            id: item.event.id,
            summary: item.event.summary,
            score: item.score,
            perception: item.event.perception,
          })),
          budget: { maxTokens: 8192, reserveForReply: 1024 },
        });

        // 核心断言：任何一轮都不允许超出预算
        expect(prompt.report.fits).toBe(true);
        maxPromptTokens = Math.max(maxPromptTokens, prompt.report.usedTokens);
        if (prompt.report.stages.length > 0) degradedTurns += 1;

        speakerCounts.set(speaker.displayName, (speakerCounts.get(speaker.displayName) ?? 0) + 1);

        await repository.appendMessages(roomIdValue, [
          createCharacterMessage({
            roomId: roomIdValue,
            sceneId: scene.id,
            turnId,
            speakerInstanceId: speaker.id,
            speakerName: speaker.displayName,
            content: `我明白了。这是第 ${turn} 轮，我们继续。`,
            audience: scene.cast,
          }),
        ]);
      }

      messages = await repository.listMessages(roomIdValue);

      const turnMessages = messages.filter((message) => message.turnId === turnId);
      const raw = await collect(
        provider,
        buildExtractionMessages({
          scene,
          cast: participants,
          playerName: room.playerName,
          messages: turnMessages,
        }),
      );
      const { events } = buildMemoryEvents({
        roomId: roomIdValue,
        sceneId: scene.id,
        worldTime: scene.worldTime,
        sequence: turn,
        participants,
        extraction: parseExtraction(raw),
        turnId,
      });
      await repository.saveMemories(events);
      memories = [...memories, ...events];

      for (const member of participants) {
        expect(memories.some((event) => event.observerId === member.id)).toBe(true);
      }
      expect(memories.some((event) => event.observerId === carol.id)).toBe(false);
    }

    // ---- 长跑结束后的整体检查 ----

    const recalledByAlice = recallMemories(memories, {
      observerId: alice.id,
      text: '商队',
      participantIds: scene.cast,
      location: '',
      now: new Date().toISOString(),
    });

    // 必须能翻出很早以前的事，而不是只记得最近几轮
    expect(recalledByAlice.length).toBeGreaterThan(5);
    // 视角不串味
    expect(recalledByAlice.every((item) => item.event.observerId === alice.id)).toBe(true);

    // 重抽回滚：撤掉一轮，它的记忆必须一起消失
    const victim = recalledByAlice[0];
    if (!victim) throw new Error('没有召回结果，无法测试回滚');

    const victimTurn = victim.event.sourceTurnIds[0];
    if (victimTurn === undefined) throw new Error('记忆缺少来源回合');

    const removed = await repository.deleteMemoriesByTurn(roomIdValue, victimTurn);
    expect(removed).toBeGreaterThan(0);

    const afterRollback = await repository.listMemories(roomIdValue);
    expect(afterRollback.some((event) => event.sourceTurnIds.includes(victimTurn))).toBe(false);

    const report = {
      回合数: TOTAL_TURNS,
      消息数: messages.length,
      记忆条目: afterRollback.length,
      触发预算降级的回合: degradedTurns,
      单轮最大提示词token: maxPromptTokens,
      发言分布: Object.fromEntries(speakerCounts),
    };
    console.log('长跑基线报告：', JSON.stringify(report, null, 2));
  }, 60_000);

  it('长文本 + 小窗口：预算降级确实生效，且仍然产出可用 prompt', () => {
    const roomIdValue = roomId(newId());
    const sceneIdValue = sceneId(newId());
    const now = nowIso();

    const card = makeCard('Alice');
    const room: Room = {
      id: roomIdValue,
      title: '压力测试',
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
    const alice = makeInstance(card, room, 'Alice', 'onstage');
    room.instanceIds = [alice.id];

    const scene: Scene = {
      id: sceneIdValue,
      roomId: roomIdValue,
      conversationId: null,
      title: '开场',
      location: '',
      worldTime: '第一日',
      castPolicy: 'locked',
      cast: [alice.id],
      summary: '',
      createdAt: now,
      updatedAt: now,
      endedAt: null,
      deletedAt: null,
    };

    // 造 60 条超长历史，任何窗口都装不下
    const history = Array.from({ length: 60 }, (_, index) =>
      createPlayerMessage({
        roomId: roomIdValue,
        sceneId: scene.id,
        turnId: `turn-${String(index)}`,
        speakerName: room.playerName,
        content: '这是一段很长的历史消息，用来把上下文撑爆。'.repeat(12),
        audience: scene.cast,
      }),
    );

    const prompt = assemblePrompt({
      card,
      instance: alice,
      room,
      scene,
      cast: [alice],
      history,
      playerInput: '最后一句',
      budget: { maxTokens: 2048, reserveForReply: 1024 },
    });

    // 降级必须被触发
    expect(prompt.report.stages.length).toBeGreaterThan(0);
    expect(prompt.report.dropped.length).toBeGreaterThan(0);

    // 但结果必须仍然可用：不超预算、system 还在、玩家输入还在
    expect(prompt.report.fits).toBe(true);
    expect(prompt.report.usedTokens).toBeLessThanOrEqual(prompt.report.maxTokens);
    expect(prompt.messages[0]?.role).toBe('system');
    expect(prompt.messages.at(-1)?.content).toBe('最后一句');

    console.log(
      '压力场景报告：',
      JSON.stringify(
        {
          可用预算: prompt.report.maxTokens,
          实际占用: prompt.report.usedTokens,
          丢弃区块: prompt.report.dropped.length,
          触发阶段: prompt.report.stages,
          保留消息数: prompt.messages.length,
        },
        null,
        2,
      ),
    );
  });
});
