import { describe, expect, it } from 'vitest';
import { createBlankCard } from '../model/card.js';
import { instanceId, newId, nowIso, PLAYER, roomId, sceneId } from '../model/ids.js';
import { type CharacterInstance, neutralTraits } from '../model/instance.js';
import type { Room, Scene } from '../model/room.js';
import type { ChatStreamEvent, ModelProvider } from '../provider/openai-compatible.js';
import { renderMessageContent } from '../render/segments.js';
import { createGreetingMessage, MAX_AUTOMATIC_GREETING_LENGTH, prepareAutomaticGreeting, runTurn } from './turn.js';

function fixtures() {
  const now = nowIso();
  const roomIdValue = roomId(newId());
  const card = createBlankCard({ name: '秦娘', description: '酒馆老板娘' });
  const instance: CharacterInstance = {
    id: instanceId(newId()),
    roomId: roomIdValue,
    cardId: card.id,
    displayName: '秦娘',
    presence: 'onstage',
    traits: neutralTraits(),
    affect: { valence: 0, arousal: 0, updatedAt: now, history: [] },
    relationships: [
      { target: PLAYER, trust: 0, affinity: 0, fear: 0, respect: 0, tension: 0, updatedAt: now, history: [] },
    ],
    traitsLocked: false,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  const room: Room = {
    id: roomIdValue,
    title: '雨夜酒馆',
    personaId: null,
    playerName: '旅人',
    playerPersona: '',
    cardIds: [card.id],
    instanceIds: [instance.id],
    worldBookIds: [],
    activeConversationId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  const scene: Scene = {
    id: sceneId(newId()),
    roomId: roomIdValue,
    conversationId: null,
    title: '开场',
    location: '酒馆',
    worldTime: '第三日',
    castPolicy: 'locked',
    cast: [instance.id],
    summary: '',
    createdAt: now,
    updatedAt: now,
    endedAt: null,
    deletedAt: null,
  };

  return { card, instance, room, scene };
}

function provider(usage: { prompt_tokens?: number; completion_tokens?: number } | null): ModelProvider {
  return {
    id: 'fake',
    model: 'fake',
    async *chat(): AsyncIterable<ChatStreamEvent> {
      yield { type: 'text', text: '这雨，一时半会儿停不了。' };
      yield {
        type: 'done',
        usage:
          usage === null
            ? null
            : {
                ...(usage.prompt_tokens === undefined ? {} : { promptTokens: usage.prompt_tokens }),
                ...(usage.completion_tokens === undefined ? {} : { completionTokens: usage.completion_tokens }),
              },
      };
    },
    async listModels() {
      return ['fake'];
    },
  };
}

describe('runTurn 的用量传递', () => {
  it('把服务商返回的用量原样带在 done 事件上', async () => {
    const { card, instance, room, scene } = fixtures();
    const events = [];
    for await (const event of runTurn(
      {
        card,
        instance,
        room,
        scene,
        history: [],
        playerInput: '这雨要下到什么时候',
        budget: { maxTokens: 8192, reserveForReply: 1024 },
      },
      provider({ prompt_tokens: 1280, completion_tokens: 64 }),
    )) {
      events.push(event);
    }

    const done = events.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type !== 'done') return;
    expect(done.text).toContain('这雨');
    expect(done.usage).toEqual({ promptTokens: 1280, completionTokens: 64 });
  });

  it('服务商没返回用量时是 null，而不是编一个数出来', async () => {
    const { card, instance, room, scene } = fixtures();
    const events = [];
    for await (const event of runTurn(
      {
        card,
        instance,
        room,
        scene,
        history: [],
        playerInput: '在吗',
        budget: { maxTokens: 8192, reserveForReply: 1024 },
      },
      provider(null),
    )) {
      events.push(event);
    }

    const done = events.at(-1);
    if (done?.type !== 'done') throw new Error('没有 done 事件');
    expect(done.usage).toBeNull();
  });

  it('缺字段的用量补 0，保证界面拿到的是可相加的数字', async () => {
    const { card, instance, room, scene } = fixtures();
    const events = [];
    for await (const event of runTurn(
      {
        card,
        instance,
        room,
        scene,
        history: [],
        playerInput: '在吗',
        budget: { maxTokens: 8192, reserveForReply: 1024 },
      },
      provider({ completion_tokens: 12 }),
    )) {
      events.push(event);
    }

    const done = events.at(-1);
    if (done?.type !== 'done') throw new Error('没有 done 事件');
    expect(done.usage).toEqual({ promptTokens: 0, completionTokens: 12 });
  });
});

describe('自动开场只改消息，不改角色卡原文', () => {
  it('两张卡分别归属自己的角色，兼容字面 /n 与 \\n 后仍把动作分到气泡外', () => {
    const { card, instance, room, scene } = fixtures();
    const second = createBlankCard({ name: '陈九' });
    const secondInstance: CharacterInstance = {
      ...instance,
      id: instanceId(newId()),
      cardId: second.id,
      displayName: '陈九',
    };
    card.firstMessage = '「坐。」/n# 她指了指椅子。';
    second.firstMessage = String.raw`# 他掸了掸袖口。\n「路上好走吗？」`;
    const audience = [instance.id, secondInstance.id];
    const first = createGreetingMessage({ card, instance, room, scene, audience });
    const next = createGreetingMessage({ card: second, instance: secondInstance, room, scene, audience });

    expect(first?.speakerInstanceId).toBe(instance.id);
    expect(next?.speakerInstanceId).toBe(secondInstance.id);
    expect(first?.audience).toEqual(audience);
    expect(next?.audience).toEqual(audience);
    expect(first?.content).toBe('「坐。」\n# 她指了指椅子。');
    expect(next?.content).toBe('# 他掸了掸袖口。\n「路上好走吗？」');
    expect(next && renderMessageContent(next.content).map((part) => part.kind)).toEqual(['action', 'speech']);
    expect(card.firstMessage).toContain('/n');
    expect(second.firstMessage).toContain(String.raw`\n`);
  });

  it('长开场按完整引号收成一段，短卡保持原样，模板只在消息中展开', () => {
    const { card, instance, room, scene } = fixtures();
    card.firstMessage = `{{char}}抬眼看向{{user}}。\n${'「这边请。」'.repeat(180)}`;
    const long = createGreetingMessage({ card, instance, room, scene });
    const shortCard = createBlankCard({ name: '小满' });
    shortCard.firstMessage = '「来了。」';
    const shortInstance: CharacterInstance = {
      ...instance,
      id: instanceId(newId()),
      cardId: shortCard.id,
      displayName: '小满',
    };
    const audience = [instance.id, shortInstance.id];
    const short = createGreetingMessage({ card: shortCard, instance: shortInstance, room, scene, audience });

    expect(long?.content.startsWith('秦娘抬眼看向旅人。\n')).toBe(true);
    expect(long?.content.length).toBeLessThanOrEqual(MAX_AUTOMATIC_GREETING_LENGTH + 85);
    expect(long?.content.endsWith('」……')).toBe(true);
    expect((long?.content.match(/「/g) ?? []).length).toBe((long?.content.match(/」/g) ?? []).length);
    expect(card.firstMessage).toContain('{{char}}');
    expect(card.firstMessage.length).toBeGreaterThan(long?.content.length ?? 0);
    expect(short?.content).toBe('「来了。」');
    expect(short?.speakerInstanceId).toBe(shortInstance.id);
    expect(short?.audience).toEqual(audience);
  });

  it('明确的他人台词不冒领；星号和圆括号动作仍在气泡外', () => {
    const { card, instance, room, scene } = fixtures();
    card.firstMessage = '秦娘：「请坐。」/n*她推开门*「风大。」/n（她放下杯子）/n陈九：「我也来了。」';
    const greeting = createGreetingMessage({ card, instance, room, scene });
    expect(greeting?.content).toBe('「请坐。」\n# 她推开门\n「风大。」\n# 她放下杯子');
    expect(greeting && renderMessageContent(greeting.content).map((part) => part.kind)).toEqual([
      'speech',
      'action',
      'speech',
      'action',
    ]);
    expect(card.firstMessage).toContain('陈九：「我也来了。」');
  });

  it('星号动作后接无引号正文也先拆动作，不猜后半句的类型', () => {
    const { card, instance, room, scene } = fixtures();
    card.firstMessage = '*她推开门*风还没停。';
    const greeting = createGreetingMessage({ card, instance, room, scene });
    expect(greeting?.content).toBe('# 她推开门\n风还没停。');
    expect(greeting && renderMessageContent(greeting.content).map((part) => part.kind)).toEqual(['action', 'speech']);
  });

  it('他人先说且有无标签续行时跳过那一段，之后仍提取当前角色的开场', () => {
    const { card, instance, room, scene } = fixtures();
    card.firstMessage = '【陈九】「先进去。」/n*他推开门*/n【秦娘】「坐这儿。」/n*她把杯子摆好*';
    const greeting = createGreetingMessage({ card, instance, room, scene });
    expect(greeting?.content).toBe('「坐这儿。」\n# 她把杯子摆好');
    expect(greeting?.speakerInstanceId).toBe(instance.id);
    expect(card.firstMessage).toContain('【陈九】');
  });

  it('英文名和较长中文名的明确标签也按归属跳过，不冒领台词', () => {
    expect(prepareAutomaticGreeting('Bob: "先坐。"\n*he opens the door*\nAlice: "谢谢。"', 'Alice', 'You')).toBe(
      '"谢谢。"',
    );
    expect(
      prepareAutomaticGreeting(
        '北城货栈的老掌柜：「从这儿走。」\n*他掀开门帘*\n渡口巡夜的年轻管事：「我带路。」',
        '渡口巡夜的年轻管事',
        '旅人',
      ),
    ).toBe('「我带路。」');
    expect(prepareAutomaticGreeting('地点：酒馆\nBob: Hello\nAlice: Hi', 'Alice', 'You')).toBe('地点：酒馆\nHi');
    expect(
      prepareAutomaticGreeting(
        '北城货栈的老掌柜：先进去。\n渡口巡夜的年轻管事：我带路。',
        '渡口巡夜的年轻管事',
        '旅人',
      ),
    ).toBe('我带路。');
  });

  it('无标记的明确第三人称动作紧接引号对白时，只在自动开场补动作标记', () => {
    const { card, instance, room, scene } = fixtures();
    card.firstMessage = '她推开门。\n「你好。」';
    const greeting = createGreetingMessage({ card, instance, room, scene });
    expect(greeting?.content).toBe('# 她推开门。\n「你好。」');
    expect(greeting && renderMessageContent(greeting.content).map((part) => part.kind)).toEqual(['action', 'speech']);
    expect(card.firstMessage).toBe('她推开门。\n「你好。」');
  });

  it('同一行对白后的星号或圆括号动作独立成段', () => {
    const { card, instance, room, scene } = fixtures();
    card.firstMessage = '你好。*她挥手*';
    const starred = createGreetingMessage({ card, instance, room, scene });
    expect(starred?.content).toBe('你好。\n# 她挥手');
    expect(starred && renderMessageContent(starred.content).map((part) => part.kind)).toEqual(['speech', 'action']);

    card.firstMessage = '你好。（她挥手）';
    const parenthesized = createGreetingMessage({ card, instance, room, scene });
    expect(parenthesized?.content).toBe('你好。\n# 她挥手');
    expect(parenthesized && renderMessageContent(parenthesized.content).map((part) => part.kind)).toEqual([
      'speech',
      'action',
    ]);
  });
});
