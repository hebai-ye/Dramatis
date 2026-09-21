import { describe, expect, it, vi } from 'vitest';
import type { Card } from '../model/card.js';
import { createConversation } from '../model/conversation.js';
import { cardId, instanceId, newId, nowIso, roomId } from '../model/ids.js';
import type { CharacterInstance } from '../model/instance.js';
import type { Room } from '../model/room.js';
import type { ChatMessage } from '../prompt/types.js';
import type { ModelProvider as Provider, ChatStreamEvent as ProviderEvent } from '../provider/openai-compatible.js';
import { buildAdminMessages } from './prompt.js';
import type { AdminDraft } from './tools.js';
import { type AdminTurnEvent, runAdminTurn } from './turn.js';

function makeCard(name: string): Card {
  return {
    id: cardId(newId()),
    name,
    nickname: '',
    description: `${name} 的设定`,
    personality: '',
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

function makeInstance(card: Card, roomIdValue: Room['id']): CharacterInstance {
  const now = nowIso();
  return {
    id: instanceId(newId()),
    roomId: roomIdValue,
    cardId: card.id,
    displayName: card.name,
    presence: 'onstage',
    traits: { extroversion: 0, aggression: 0, empathy: 0, playfulness: 0, caution: 0 },
    affect: { valence: 0, arousal: 0, updatedAt: now, history: [] },
    relationships: [],
    traitsLocked: false,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

/**
 * 脚本化的「管理员」：第一轮请求起草一张卡，拿到工具结果之后才给答复。
 *
 * 它同时验证了一件重要的事——回填的 tool 消息真的被送回了模型。
 * 只有收到 tool 消息，它才会结束循环。
 */
function scriptedAdmin(): { provider: Provider; seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];

  const provider: Provider = {
    id: 'scripted-admin',
    model: 'scripted',

    async *chat(messages: ChatMessage[]): AsyncIterable<ProviderEvent> {
      seen.push(messages.map((message) => ({ ...message })));
      const hasToolResult = messages.some((message) => message.role === 'tool');

      if (!hasToolResult) {
        yield { type: 'text', text: '我来起草一个酒馆老板。' };
        yield {
          type: 'done',
          usage: null,
          toolCalls: [
            {
              id: 'call-1',
              type: 'function',
              function: {
                name: 'upsert_character_card',
                arguments: JSON.stringify({ name: '酒馆老板', description: '旧城酒馆的老板' }),
              },
            },
          ],
        };
        return;
      }

      yield { type: 'text', text: '草稿已经放在上面，采纳后就能用。' };
      yield { type: 'done', usage: null };
    },

    async listModels() {
      return ['scripted'];
    },
  };

  return { provider, seen };
}

function fixture() {
  const roomIdValue = roomId(newId());
  const card = makeCard('Alice');
  const alice = makeInstance(card, roomIdValue);
  const room: Room = {
    id: roomIdValue,
    title: '雨夜酒馆',
    personaId: null,
    playerName: '旅人',
    playerPersona: '',
    cardIds: [card.id],
    instanceIds: [alice.id],
    worldBookIds: [],
    activeConversationId: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    deletedAt: null,
  };
  const conversation = createConversation({ roomId: roomIdValue, title: '世界管理' });

  return { room, card, alice, conversation };
}

describe('buildAdminMessages', () => {
  it('不提角色人设、不带记忆：副对话是工作流而不是角色扮演', () => {
    const { room, card, alice, conversation } = fixture();
    const messages = buildAdminMessages({
      room,
      conversation,
      scene: null,
      instances: [alice],
      cards: [card],
      worldBooks: [],
      personas: [],
      history: [],
      userInput: '帮我建一个酒馆老板',
    });

    const joined = messages.map((message) => message.content).join('\n');
    expect(joined).toContain('世界管理员');
    expect(joined).toContain('upsert_character_card');
    expect(joined).toContain(card.id);
    expect(messages.at(-1)?.content).toBe('帮我建一个酒馆老板');
    // 没有角色扮演的 persona 块
    expect(joined).not.toContain('你现在扮演的是');
  });

  it('已起草的草稿会写进上下文，避免重复起草', () => {
    const { room, card, alice, conversation } = fixture();
    const messages = buildAdminMessages({
      room,
      conversation,
      scene: null,
      instances: [alice],
      cards: [card],
      worldBooks: [],
      personas: [],
      history: [],
      userInput: '继续',
      pendingDrafts: ['新建角色卡「酒馆老板」'],
    });

    expect(messages.some((message) => message.content.includes('正在等用户决定去留'))).toBe(true);
  });
});

describe('runAdminTurn', () => {
  it('走完「请求工具 → 执行 → 回填 → 再说话」的循环', async () => {
    const { room, card, alice, conversation } = fixture();
    const { provider, seen } = scriptedAdmin();
    const execute = vi.fn(async (_draft: AdminDraft) => '已把草稿放到用户面前，等待采纳');

    const events: AdminTurnEvent[] = [];
    for await (const event of runAdminTurn(
      provider,
      buildAdminMessages({
        room,
        conversation,
        scene: null,
        instances: [alice],
        cards: [card],
        worldBooks: [],
        personas: [],
        history: [],
        userInput: '帮我建一个酒馆老板',
      }),
      { execute },
    )) {
      events.push(event);
    }

    // 工具真的被执行了一次
    expect(execute).toHaveBeenCalledTimes(1);
    const executed = execute.mock.calls[0]?.[0];
    expect(executed?.kind).toBe('character-card');

    // 事件流里能看到工具结果
    const toolEvent = events.find((event) => event.type === 'tool');
    expect(toolEvent?.type === 'tool' && toolEvent.execution.ok).toBe(true);

    // 第二轮的上下文里带上了 tool 消息，模型因此收尾而不是重复起草
    expect(seen).toHaveLength(2);
    expect(seen[1]?.some((message) => message.role === 'tool')).toBe(true);

    const final = events.at(-1);
    expect(final?.type).toBe('done');
    if (final?.type !== 'done') return;
    expect(final.text).toContain('我来起草一个酒馆老板。');
    expect(final.text).toContain('草稿已经放在上面');
    expect(final.executions).toHaveLength(1);
  });

  it('参数不合法时不执行工具，把错误回填给模型', async () => {
    const { room, card, alice, conversation } = fixture();
    const execute = vi.fn(async (_draft: AdminDraft) => '不该被调用');

    const broken: Provider = {
      id: 'broken',
      model: 'broken',
      async *chat(messages: ChatMessage[]): AsyncIterable<ProviderEvent> {
        if (messages.some((message) => message.role === 'tool')) {
          yield { type: 'text', text: '我换个方式。' };
          yield { type: 'done', usage: null };
          return;
        }
        yield {
          type: 'done',
          usage: null,
          toolCalls: [
            { id: 'c1', type: 'function', function: { name: 'set_scene', arguments: '{"castPolicy":"乱写"}' } },
          ],
        };
      },
      async listModels() {
        return ['broken'];
      },
    };

    const events: AdminTurnEvent[] = [];
    for await (const event of runAdminTurn(
      broken,
      buildAdminMessages({
        room,
        conversation,
        scene: null,
        instances: [alice],
        cards: [card],
        worldBooks: [],
        personas: [],
        history: [],
        userInput: '换场景',
      }),
      { execute },
    )) {
      events.push(event);
    }

    expect(execute).not.toHaveBeenCalled();
    const toolEvent = events.find((event) => event.type === 'tool');
    if (toolEvent?.type !== 'tool') throw new Error('没有工具事件');
    expect(toolEvent.execution.ok).toBe(false);
    expect(toolEvent.execution.result).toContain('castPolicy');
  });

  it('模型一直要工具时，最后一轮强制收口', async () => {
    const { room, card, alice, conversation } = fixture();
    let calls = 0;

    const greedy: Provider = {
      id: 'greedy',
      model: 'greedy',
      async *chat(): AsyncIterable<ProviderEvent> {
        calls += 1;
        yield {
          type: 'done',
          usage: null,
          toolCalls: [
            {
              id: `c${String(calls)}`,
              type: 'function',
              function: { name: 'set_scene', arguments: '{"location":"酒馆"}' },
            },
          ],
        };
      },
      async listModels() {
        return ['greedy'];
      },
    };

    const execute = vi.fn(async (_draft: AdminDraft) => '已设置');
    const events: AdminTurnEvent[] = [];
    for await (const event of runAdminTurn(
      greedy,
      buildAdminMessages({
        room,
        conversation,
        scene: null,
        instances: [alice],
        cards: [card],
        worldBooks: [],
        personas: [],
        history: [],
        userInput: '一直调用工具',
      }),
      { execute, maxRounds: 3 },
    )) {
      events.push(event);
    }

    // 三轮封顶，不会无限循环
    expect(calls).toBe(3);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('用量按调用次数累加：工具回填让一次回合变成多次调用，不能只记最后一次', async () => {
    const { room, card, alice, conversation } = fixture();
    let round = 0;

    const scripted: Provider = {
      id: 'usage-scripted',
      model: 'scripted',
      async *chat(messages: ChatMessage[]): AsyncIterable<ProviderEvent> {
        round += 1;
        const usage = { promptTokens: 100 * round, completionTokens: 10 * round };

        if (round === 1) {
          yield {
            type: 'done',
            usage,
            toolCalls: [
              { id: 'c1', type: 'function', function: { name: 'set_scene', arguments: '{"location":"酒馆"}' } },
            ],
          };
          return;
        }

        expect(messages.some((message) => message.role === 'tool')).toBe(true);
        yield { type: 'text', text: '好了。' };
        yield { type: 'done', usage };
      },
      async listModels() {
        return ['scripted'];
      },
    };

    const events: AdminTurnEvent[] = [];
    for await (const event of runAdminTurn(
      scripted,
      buildAdminMessages({
        room,
        conversation,
        scene: null,
        instances: [alice],
        cards: [card],
        worldBooks: [],
        personas: [],
        history: [],
        userInput: '换场景',
      }),
      { execute: async () => '已设置' },
    )) {
      events.push(event);
    }

    const final = events.at(-1);
    if (final?.type !== 'done') throw new Error('没有 done 事件');
    expect(final.calls).toBe(2);
    // 100+200 提示、10+20 输出——只记最后一轮的话会得到 200 / 20
    expect(final.usage).toEqual({ promptTokens: 300, completionTokens: 30 });
  });
});
