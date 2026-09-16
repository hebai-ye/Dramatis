import { describe, expect, it } from 'vitest';
import type { Card } from '../model/card.js';
import { cardId, type InstanceId, instanceId, newId, nowIso, PLAYER, roomId, sceneId } from '../model/ids.js';
import { type CharacterInstance, neutralTraits } from '../model/instance.js';
import type { Room, Scene } from '../model/room.js';
import { createCharacterMessage, createPlayerMessage } from '../session/turn.js';
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
    conversationId: null,
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
    personaId: null,
    playerName: '旅人',
    playerPersona: '',
    cardIds: [card.id],
    instanceIds: [instanceIdValue],
    worldBookIds: [],
    activeConversationId: null,
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

function makeInstance(
  room: Room,
  card: Card,
  name: string,
  presence: CharacterInstance['presence'] = 'onstage',
): CharacterInstance {
  const now = nowIso();
  return {
    id: instanceId(newId()),
    roomId: room.id,
    cardId: card.id,
    displayName: name,
    presence,
    traits: neutralTraits(),
    affect: { valence: 0, arousal: 0, updatedAt: now, history: [] },
    relationships: [],
    traitsLocked: false,
    createdAt: now,
    updatedAt: now,
  };
}

function line(room: Room, scene: Scene, speaker: CharacterInstance, content: string, audience: InstanceId[]) {
  return createCharacterMessage({
    roomId: room.id,
    sceneId: scene.id,
    turnId: 'turn-x',
    speakerInstanceId: speaker.id,
    speakerName: speaker.displayName,
    content,
    audience,
  });
}

const baseBudget = { maxTokens: 8000, reserveForReply: 1000 };

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

describe('assemblePrompt / 多角色场景', () => {
  it('场景块列出在场角色与各自的状态', () => {
    const { card, instance, room, scene } = fixtures();
    const bob = makeInstance(room, card, 'Bob', 'muted');

    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      cast: [instance, bob],
      history: [],
      playerInput: '你们好',
      budget: baseBudget,
    });

    const system = prompt.messages[0]?.content ?? '';
    expect(system).toContain('在场角色：');
    expect(system).toContain('Alice（正在与你对话）');
    expect(system).toContain('Bob（在场但一直没说话）');
  });

  it('多人同场时历史消息标出说话人，单人时不标', () => {
    const { card, instance, room, scene } = fixtures();
    const bob = makeInstance(room, card, 'Bob');
    const said = line(room, scene, bob, '今晚的雨真大', [instance.id, bob.id]);

    const group = assemblePrompt({
      card,
      instance,
      room,
      scene,
      cast: [instance, bob],
      history: [said],
      playerInput: '是啊',
      budget: baseBudget,
    });
    // 历史是独立的对话消息，不在 system 里
    const groupText = group.messages.map((message) => message.content).join('\n');
    expect(groupText).toContain('Bob：今晚的雨真大');

    const solo = assemblePrompt({
      card,
      instance,
      room,
      scene,
      cast: [instance],
      history: [said],
      playerInput: '是啊',
      budget: baseBudget,
    });
    const soloText = solo.messages.map((message) => message.content).join('\n');
    expect(soloText).toContain('今晚的雨真大');
    expect(soloText).not.toContain('Bob：');
  });

  it('指令提醒不要替其他在场角色发言', () => {
    const { card, instance, room, scene } = fixtures();
    const bob = makeInstance(room, card, 'Bob');

    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      cast: [instance, bob],
      history: [],
      playerInput: '你们好',
      budget: baseBudget,
    });

    expect(prompt.messages[0]?.content).toContain('不要替他们发言');
    expect(prompt.messages[0]?.content).toContain('Bob');
  });

  it('同一回合的第二名角色不重复插入玩家输入', () => {
    const { card, instance, room, scene } = fixtures();
    const bob = makeInstance(room, card, 'Bob');
    const playerLine = createPlayerMessage({
      roomId: room.id,
      sceneId: scene.id,
      turnId: 'turn-x',
      speakerName: room.playerName,
      content: '你们好',
      audience: [instance.id, bob.id],
    });
    const aliceReply = line(room, scene, instance, '欢迎光临', [instance.id, bob.id]);

    const prompt = assemblePrompt({
      card,
      instance: bob,
      room,
      scene,
      cast: [instance, bob],
      history: [playerLine, aliceReply],
      playerInput: '',
      budget: baseBudget,
    });

    const messages = prompt.messages;
    expect(messages.at(-1)?.content).toBe('Alice：欢迎光临');
    expect(messages.filter((message) => message.content === '你们好')).toHaveLength(1);
  });

  it('按视角裁掉不在场时的历史', () => {
    const { card, instance, room, scene } = fixtures();
    const bob = makeInstance(room, card, 'Bob');

    const prompt = assemblePrompt({
      card,
      instance: bob,
      room,
      scene,
      cast: [instance, bob],
      history: [
        line(room, scene, instance, '只有 Alice 在场时说的', [instance.id]),
        line(room, scene, instance, '两人都在时说的', [instance.id, bob.id]),
      ],
      playerInput: '继续',
      budget: baseBudget,
    });

    const rendered = prompt.messages.map((message) => message.content).join('\n');
    expect(rendered).toContain('两人都在时说的');
    expect(rendered).not.toContain('只有 Alice 在场时说的');
    expect(prompt.historyStats).toEqual({ total: 2, visible: 1 });
  });
});
