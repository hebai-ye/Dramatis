import { describe, expect, it } from 'vitest';
import { cardId, instanceId, newId, nowIso, PLAYER, roomId, sceneId } from '../model/ids.js';
import { neutralTraits, type CharacterInstance } from '../model/instance.js';
import type { Card } from '../model/card.js';
import { createPlayerMessage } from '../session/turn.js';
import type { Room, Scene } from '../model/room.js';
import { assemblePrompt } from './assemble.js';

function fixtures(castPolicy: Scene['castPolicy'] = 'locked') {
  const now = nowIso();
  const roomIdValue = roomId(newId());
  const instanceIdValue = instanceId(newId());
  const sceneIdValue = sceneId(newId());

  const card: Card = {
    id: cardId(newId()),
    name: 'Alice',
    nickname: '',
    description: '酒馆的老板',
    personality: '爽朗健谈',
    scenario: '雨夜的酒馆',
    firstMessage: '欢迎光临。',
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
    source: { kind: 'json', spec: 'chara_card_v2', specVersion: '2.0', importedAt: now },
  };

  const instance: CharacterInstance = {
    id: instanceIdValue,
    roomId: roomIdValue,
    cardId: card.id,
    displayName: 'Alice',
    presence: 'onstage',
    traits: neutralTraits(),
    affect: { valence: 0.6, arousal: 0.5, updatedAt: now, history: [] },
    relationships: [
      {
        target: PLAYER,
        trust: 0.4,
        affinity: 0.5,
        fear: 0,
        respect: 0.2,
        tension: 0.1,
        updatedAt: now,
        history: [],
      },
    ],
    traitsLocked: false,
    createdAt: now,
    updatedAt: now,
  };

  const scene: Scene = {
    id: sceneIdValue,
    roomId: roomIdValue,
    title: '开场',
    location: '旧城东侧的酒馆',
    worldTime: '第三日 · 黄昏',
    castPolicy,
    cast: [instanceIdValue],
    summary: '',
    createdAt: now,
    endedAt: null,
  };

  const room: Room = {
    id: roomIdValue,
    title: '测试房间',
    playerName: '旅人',
    playerPersona: '',
    cardIds: [card.id],
    instanceIds: [instanceIdValue],
    worldBookIds: [],
    activeSceneId: sceneIdValue,
    createdAt: now,
    updatedAt: now,
  };

  return { card, instance, room, scene };
}

function history(...contents: string[]) {
  const { room, scene } = fixtures();
  return contents.map((content, index) =>
    createPlayerMessage({
      roomId: room.id,
      sceneId: scene.id,
      turnId: `turn-${String(index)}`,
      speakerName: room.playerName,
      content,
    }),
  );
}

describe('assemblePrompt', () => {
  it('生成 system + 历史 + 本轮输入的对话结构', () => {
    const { card, instance, room, scene } = fixtures();
    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      history: history('你好'),
      playerInput: '今晚有空吗？',
      budget: { maxTokens: 8000, reserveForReply: 1000 },
    });

    expect(prompt.messages[0]?.role).toBe('system');
    expect(prompt.messages.at(-1)).toEqual({ role: 'user', content: '今晚有空吗？' });
    expect(prompt.messages).toHaveLength(3);
  });

  it('把角色卡内容写进 system', () => {
    const { card, instance, room, scene } = fixtures();
    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      history: [],
      playerInput: '嗨',
      budget: { maxTokens: 8000, reserveForReply: 1000 },
    });

    const system = prompt.messages[0]?.content ?? '';
    expect(system).toContain('酒馆的老板');
    expect(system).toContain('爽朗健谈');
    expect(system).toContain('信任 +0.40');
  });

  it('锁场时把导演指令写进 prompt', () => {
    const { card, instance, room, scene } = fixtures('locked');
    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      history: [],
      playerInput: '嗨',
      budget: { maxTokens: 8000, reserveForReply: 1000 },
    });

    expect(prompt.messages[0]?.content).toContain('不得引入任何新角色');
  });

  it('锁场指令随策略变化', () => {
    const { card, instance, room, scene } = fixtures('open');
    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      history: [],
      playerInput: '嗨',
      budget: { maxTokens: 8000, reserveForReply: 1000 },
    });

    expect(prompt.messages[0]?.content).not.toContain('不得引入任何新角色');
  });

  it('预算不足时仍产出可用 prompt 并记录降级', () => {
    const { card, instance, room, scene } = fixtures();
    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      history: history(...Array.from({ length: 40 }, (_, index) => `第${String(index)}句话`.repeat(20))),
      playerInput: '继续',
      budget: { maxTokens: 2000, reserveForReply: 1500 },
    });

    expect(prompt.report.stages.length).toBeGreaterThan(0);
    expect(prompt.messages.at(-1)?.content).toBe('继续');
    expect(prompt.messages[0]?.role).toBe('system');
    expect(prompt.report.fits).toBe(true);
  });

  it('历史按时间顺序映射成 user / assistant', () => {
    const { card, instance, room, scene } = fixtures();
    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      history: history('第一句', '第二句'),
      playerInput: '第三句',
      budget: { maxTokens: 8000, reserveForReply: 1000 },
    });

    expect(prompt.messages.map((message) => message.role)).toEqual(['system', 'user', 'user', 'user']);
    expect(prompt.messages[1]?.content).toBe('第一句');
  });
});
