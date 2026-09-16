import { describe, expect, it } from 'vitest';
import { createBlankCard } from '../model/card.js';
import { instanceId, newId, nowIso, PLAYER, roomId, sceneId } from '../model/ids.js';
import { type CharacterInstance, neutralTraits } from '../model/instance.js';
import type { Room, Scene } from '../model/room.js';
import type { ChatStreamEvent, ModelProvider } from '../provider/openai-compatible.js';
import { runTurn } from './turn.js';

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
    endedAt: null,
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
