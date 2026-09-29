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
  manual: false,
  timeoutHandoff: false,
  reloads: 0,
  reloadFails: false,
  directorCalls: 0,
  generationSpeakers: [] as string[],
  generationHistories: [] as string[][],
  intentModes: [] as Array<string | undefined>,
  observerIds: [] as string[],
  records: [] as Array<{ category: string; speaker?: { name: string } }>,
  handoffs: [] as string[],
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
    runTurn: async function* (input: {
      instance: CharacterInstance;
      history: Message[];
      intent?: string;
      intentMode?: string;
    }) {
      runtime.generationSpeakers.push(input.instance.displayName);
      runtime.generationHistories.push(input.history.map((message) => message.speakerName));
      runtime.intentModes.push(input.intentMode);
      if (runtime.manual) {
        yield {
          type: 'prompt',
          prompt: {
            messages: [
              {
                role: 'user',
                content: `请让${input.instance.displayName}回应；意图：${input.intent ?? '无'}；模式：${input.intentMode ?? '无'}`,
              },
            ],
          },
        };
        yield { type: 'done', text: '', usage: null };
        return;
      }
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

vi.mock('../lib/stream-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/stream-store')>();
  return {
    ...actual,
    waitForStreamHandoff: async (_scope: string, messageId: string) => {
      runtime.handoffs.push(messageId);
      if (runtime.timeoutHandoff) throw new Error('消息已保存但显示确认超时');
    },
  };
});

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

function harness(withBackground = false) {
  const room = roomId(newId());
  const a = actor('秦娘', room);
  const b = actor('陈九', room);
  const saved: Message[] = [];
  const errors: Array<string | null> = [];
  const warnings: unknown[] = [];
  const busy: boolean[] = [];
  const bridges: unknown[] = [];
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
      reloadWorld: async () => {
        runtime.reloads += 1;
        if (runtime.reloadFails) throw new Error('模拟重载失败');
      },
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
      background: withBackground
        ? {
            baseUrl: 'https://example.invalid',
            apiKey: 'director-key',
            model: 'director-model',
            temperature: 0,
            price: null,
          }
        : null,
      apiKey: runtime.manual ? '' : 'test-key',
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
    setWarnings: (value: unknown) => {
      warnings.push(value);
    },
    setBridge: (value: unknown) => {
      bridges.push(value);
    },
    setLastPrompt: () => {},
  } as unknown as TurnRunnerOptions;

  let api: TurnRunnerApi | null = null;
  function Capture() {
    api = useTurnRunner(options);
    return null;
  }
  renderToString(createElement(Capture));
  if (api === null) throw new Error('未取得回合控制器');
  return { api: api as TurnRunnerApi, saved, errors, warnings, busy, bridges, a, b, scene, options };
}

beforeEach(() => {
  runtime.plan =
    '{"speakers":[{"key":"C1","name":"秦娘","intent":"先回答","mode":"reply"},{"key":"C2","name":"陈九","intent":"补充","mode":"reply"}]}';
  runtime.failFirst = false;
  runtime.hangDirector = false;
  runtime.manual = false;
  runtime.timeoutHandoff = false;
  runtime.reloads = 0;
  runtime.reloadFails = false;
  runtime.directorCalls = 0;
  runtime.generationSpeakers = [];
  runtime.generationHistories = [];
  runtime.intentModes = [];
  runtime.observerIds = [];
  runtime.records = [];
  runtime.handoffs = [];
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
    expect(runtime.handoffs).toEqual(
      saved.filter((message) => message.role === 'character').map((message) => message.id),
    );
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

  it('句首称呼场外但 onstage 的角色也在发送前拒绝', async () => {
    const { api, saved, errors, scene, a } = harness();
    scene.cast = [a.id];
    await api.handleSend('陈九，你看见了吗？');
    expect(saved).toHaveLength(0);
    expect(errors.at(-1)).toContain('不在当前场景');
  });

  it('导演超时即使供应商不响应取消也回规则保底一人', async () => {
    vi.useFakeTimers();
    runtime.hangDirector = true;
    try {
      const { api, saved, warnings } = harness();
      let completed = false;
      const send = api.handleSend('你们觉得呢？').then(() => {
        completed = true;
      });
      await vi.advanceTimersByTimeAsync(8_000);
      expect(completed).toBe(true);
      await send;
      expect(runtime.directorCalls).toBe(1);
      expect(saved.filter((message) => message.role === 'character')).toHaveLength(1);
      expect(warnings.flat().some((item) => (item as { code?: string }).code === 'intent.fallback')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('网页版两人桥接先只准备第一份提示词，玩家输入尚不落盘', async () => {
    runtime.manual = true;
    const { api, saved, bridges, a, b } = harness();
    await api.handleSend('@秦娘 @陈九，你们怎么看？');
    expect(saved).toHaveLength(0);
    expect(runtime.generationSpeakers).toEqual(['秦娘']);
    expect(bridges.at(-1)).toMatchObject({
      stage: 'reply',
      pendingTurn: {
        playerText: '@秦娘 @陈九，你们怎么看？',
        speakerIds: [a.id, b.id],
        nextIndex: 0,
      },
    });
    const pendingTurn = (bridges.at(-1) as { pendingTurn: import('../components/WebBridgePanel').PendingBridgeTurn })
      .pendingTurn;
    const prompt = await api.prepareBridgeReply({
      pendingTurn: { ...pendingTurn, nextIndex: 1 },
      history: [
        { role: 'player', speakerName: '旅人', content: pendingTurn.playerText } as Message,
        { role: 'character', speakerName: '秦娘', content: '「先听我说。」' } as Message,
      ],
    });
    expect(runtime.generationSpeakers).toEqual(['秦娘', '陈九']);
    expect(runtime.observerIds).toEqual([a.id, b.id]);
    expect(runtime.generationHistories[1]).toContain('秦娘');
    expect(prompt).toContain('陈九');
  });

  it('网页版第二人保留导演的 hold_back 意图与纯动作提示词', async () => {
    runtime.manual = true;
    runtime.plan =
      '{"speakers":[{"key":"C1","name":"秦娘","intent":"先回答","mode":"reply"},{"key":"C2","name":"陈九","intent":"欲言又止","mode":"hold_back"}]}';
    const { api, bridges } = harness(true);
    await api.handleSend('你们觉得呢？');
    const pendingTurn = (bridges.at(-1) as { pendingTurn: import('../components/WebBridgePanel').PendingBridgeTurn })
      .pendingTurn;
    expect(pendingTurn.speakerPlans?.[1]).toEqual({ intent: '欲言又止', mode: 'hold_back' });
    const prompt = await api.prepareBridgeReply({
      pendingTurn: { ...pendingTurn, nextIndex: 1 },
      history: [
        { role: 'player', speakerName: '旅人', content: pendingTurn.playerText } as Message,
        { role: 'character', speakerName: '秦娘', content: '「先听我说。」' } as Message,
      ],
    });
    expect(runtime.intentModes).toEqual(['reply', 'hold_back']);
    expect(prompt).toContain('欲言又止');
    expect(prompt).toContain('模式：hold_back');
  });

  it('首位消息交接超时后保留首位、停止第二位并重载列表', async () => {
    runtime.timeoutHandoff = true;
    runtime.reloadFails = true;
    const { api, saved, errors, busy } = harness();
    await expect(api.handleSend('你们觉得呢？')).resolves.toBeUndefined();
    expect(saved.map((message) => message.role)).toEqual(['player', 'character']);
    expect(runtime.generationSpeakers).toEqual(['秦娘']);
    expect(runtime.reloads).toBe(1);
    expect(errors.at(-1)).toContain('显示确认超时');
    expect(errors.at(-1)).toContain('重载失败');
    expect(busy.at(-1)).toBe(false);
  });

  it('导演选择 hold_back 时即使模型违令说话也只落动作', async () => {
    runtime.plan = '{"speakers":[{"key":"C1","name":"秦娘","intent":"","mode":"hold_back"}]}';
    const { api, saved } = harness();
    await api.handleSend('# 我推开门');
    const reply = saved.find((message) => message.role === 'character');
    expect(reply?.content).toContain('# 秦娘看向你');
    expect(reply?.content).not.toContain('回应');
  });

  it('无导演的静默模式保底仍向生成器声明 hold_back', async () => {
    runtime.plan = '{"speakers":[]}';
    const { api, options } = harness();
    (options.conversation as { modes: { silent: boolean } }).modes.silent = true;
    await api.handleSend('你们怎么看？');
    expect(runtime.intentModes).toEqual(['hold_back']);
  });
});
