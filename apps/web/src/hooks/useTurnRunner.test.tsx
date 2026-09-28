import type { CharacterInstance, Message } from '@dramatis/core';
import { cardId, instanceId, newId, nowIso, roomId, sceneId } from '@dramatis/core';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type TurnRunnerApi, type TurnRunnerOptions, useTurnRunner } from './useTurnRunner';

const runtime = vi.hoisted(() => ({
  plan: '{"speakers":[{"key":"C1","name":"秦娘","intent":"先回答","mode":"reply"},{"key":"C2","name":"陈九","intent":"补充","mode":"reply"}]}',
  failFirst: false,
  hangDirector: false,
  directorCalls: 0,
  generationSpeakers: [] as string[],
  generationHistories: [] as string[][],
  observerIds: [] as string[],
  records: [] as Array<{ category: string; speaker?: { name: string } }>,
}));

vi.mock('@dramatis/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dramatis/core')>();
  return {
    ...actual,
    createOpenAICompatibleProvider: () => ({}),
    collectCompletionWithTools: async () => {
      runtime.directorCalls += 1;
      if (runtime.hangDirector) return new Promise<never>(() => {});
      return { text: runtime.plan, usage: null };
    },
    recallForPrompt: (_pool: unknown, query: { observerId: string }) => {
      runtime.observerIds.push(query.observerId);
      return { selected: [] };
    },
    runTurn: async function* (input: { instance: CharacterInstance; history: Message[] }) {
      runtime.generationSpeakers.push(input.instance.displayName);
      runtime.generationHistories.push(input.history.map((message) => message.speakerName));
      if (runtime.failFirst && runtime.generationSpeakers.length === 1) throw new Error('模拟断网');
      const text = `「${input.instance.displayName}回应。」`;
      yield { type: 'text', text };
      yield { type: 'done', text, usage: null };
    },
  };
});

vi.mock('../lib/turn-bookkeeping', () => ({
  recordModelCall: async (_db: unknown, input: { category: string; speaker?: { name: string } }) => {
    runtime.records.push(input);
  },
  enqueueSceneSummary: async () => {},
  enqueueMemoryConsolidation: async () => {},
  enqueueTurnAnalysis: async () => {},
}));

function actor(name: string, room: ReturnType<typeof roomId>): CharacterInstance {
  const now = nowIso();
  return {
    id: instanceId(newId()),
    roomId: room,
    cardId: cardId(newId()),
    displayName: name,
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

function harness() {
  const room = roomId(newId());
  const a = actor('秦娘', room);
  const b = actor('陈九', room);
  const saved: Message[] = [];
  const errors: Array<string | null> = [];
  const busy: boolean[] = [];
  const scene = {
    id: sceneId(newId()),
    roomId: room,
    conversationId: 'conversation-1',
    location: '酒馆',
    cast: [a.id, b.id],
    worldTime: '',
  };
  const options = {
    db: {},
    session: {
      cards: [{ id: a.cardId }, { id: b.cardId }],
      memories: [],
      worldBooks: [],
      chapters: [],
      allChapters: [],
      scenes: [scene],
      appendMessages: async (batch: Message[]) => {
        saved.push(...batch);
      },
      markRecalled: async () => {},
    },
    providers: {
      active: {
        baseUrl: 'https://example.invalid',
        model: 'test-model',
        maxTokens: 8000,
        reserveForReply: 1000,
        temperature: 0,
        price: null,
      },
      background: null,
      apiKey: 'test-key',
    },
    usage: { reload: async () => {} },
    worker: { kick: () => {} },
    sync: { requestAutoSync: () => {} },
    world: { id: room, playerName: '旅人', playerPersona: '' },
    conversation: {
      id: 'conversation-1',
      modes: { playerFirst: false, silent: false, intentFirst: true, maxSpeakers: 2 },
    },
    scene,
    messages: [],
    instances: [a, b],
    burned: false,
    budgetReason: null,
    busy: false,
    setBusy: (value: boolean) => {
      busy.push(value);
    },
    setError: (value: string | null) => {
      errors.push(value);
    },
    setWarnings: () => {},
    setBridge: () => {},
    setLastPrompt: () => {},
  } as unknown as TurnRunnerOptions;

  let api: TurnRunnerApi | null = null;
  function Capture() {
    api = useTurnRunner(options);
    return null;
  }
  renderToString(createElement(Capture));
  if (api === null) throw new Error('未取得回合控制器');
  return { api: api as TurnRunnerApi, saved, errors, busy, a, b, scene };
}

beforeEach(() => {
  runtime.plan =
    '{"speakers":[{"key":"C1","name":"秦娘","intent":"先回答","mode":"reply"},{"key":"C2","name":"陈九","intent":"补充","mode":"reply"}]}';
  runtime.failFirst = false;
  runtime.hangDirector = false;
  runtime.directorCalls = 0;
  runtime.generationSpeakers = [];
  runtime.generationHistories = [];
  runtime.observerIds = [];
  runtime.records = [];
});

describe('一轮多人自动生成', () => {
  it('一次导演选两人，各自生成记账，第二人看见第一人但仅召回自己视角', async () => {
    const { api, saved, a, b } = harness();
    await api.handleSend('你们觉得呢？');
    expect(runtime.directorCalls).toBe(1);
    expect(runtime.generationSpeakers).toEqual(['秦娘', '陈九']);
    expect(runtime.observerIds).toEqual([a.id, b.id]);
    expect(runtime.generationHistories[1]).toContain('秦娘');
    expect(saved.map((message) => message.role)).toEqual(['player', 'character', 'character']);
    expect(new Set(saved.map((message) => message.turnId)).size).toBe(1);
    expect(
      runtime.records.filter((record) => record.category === 'generation').map((record) => record.speaker?.name),
    ).toEqual(['秦娘', '陈九']);
  });

  it('首位模型断网后仍落一条动作保底，错误指出角色并释放 busy', async () => {
    runtime.failFirst = true;
    const { api, saved, errors, busy } = harness();
    await api.handleSend('秦娘，你听见了吗？');
    expect(saved.map((message) => message.role)).toEqual(['player', 'character']);
    expect(saved[1]?.content).toContain('# 秦娘看向你');
    expect(errors.at(-1)).toContain('秦娘');
    expect(busy.at(-1)).toBe(false);
  });

  it('明确 @ 场外角色时发送前拒绝，不能让世界里其他 onstage 者代答', async () => {
    const { api, saved, errors, scene, a } = harness();
    scene.cast = [a.id];
    await api.handleSend('@陈九，你看见了吗？');
    expect(saved).toHaveLength(0);
    expect(errors.at(-1)).toContain('不在当前场景');
  });

  it('导演超时即使供应商不响应取消也回规则保底一人', async () => {
    vi.useFakeTimers();
    runtime.hangDirector = true;
    try {
      const { api, saved } = harness();
      let completed = false;
      const send = api.handleSend('你们觉得呢？').then(() => {
        completed = true;
      });
      await vi.advanceTimersByTimeAsync(8_000);
      expect(completed).toBe(true);
      await send;
      expect(runtime.directorCalls).toBe(1);
      expect(saved.filter((message) => message.role === 'character')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
