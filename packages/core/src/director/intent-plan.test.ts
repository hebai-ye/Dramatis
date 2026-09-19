import { describe, expect, it } from 'vitest';
import { instanceId, newId, nowIso, roomId, sceneId } from '../model/ids.js';
import type { CharacterInstance, Presence } from '../model/instance.js';
import { neutralTraits } from '../model/instance.js';
import type { Scene } from '../model/room.js';
import { buildIntentPlanMessages, parseIntentPlan, pickPlannedSpeaker } from './intent-plan.js';

function actor(name: string, presence: Presence = 'onstage'): CharacterInstance {
  const now = nowIso();
  return {
    id: instanceId(newId()),
    roomId: roomId(newId()),
    cardId: newId() as never,
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

const scene: Scene = {
  id: sceneId(newId()),
  roomId: roomId(newId()),
  conversationId: null,
  title: '雨夜',
  location: '旧城东侧的夜间酒馆',
  worldTime: '',
  castPolicy: 'locked',
  cast: [],
  summary: '',
  createdAt: nowIso(),
  endedAt: null,
};

describe('buildIntentPlanMessages', () => {
  it('把在场名单与玩家刚说的话交给导演调用，并声明最多几人开口', () => {
    const built = buildIntentPlanMessages({
      scene,
      cast: [actor('秦娘'), actor('陈九')],
      playerName: '旅人',
      playerInput: '那批货到底是谁点过数的？',
      recentMessages: [],
      maxSpeakers: 1,
    });

    const body = built.map((message) => message.content).join('\n');
    expect(body).toContain('在场角色：秦娘、陈九');
    expect(body).toContain('那批货到底是谁点过数的？');
    expect(body).toContain('最多让 1 个人开口');
    expect(body).toContain('speakers');
    expect(body).toContain('hold_back');
  });
});

describe('parseIntentPlan', () => {
  it('解析标准形状', () => {
    const plan = parseIntentPlan('{"speakers":[{"name":"陈九","intent":"想按住话头","mode":"hold_back"}]}');
    expect(plan).toEqual([{ name: '陈九', intent: '想按住话头', mode: 'hold_back' }]);
  });

  it('认裸数组与单个对象，也认代码块包裹', () => {
    expect(parseIntentPlan('[{"name":"秦娘","intent":"接话"}]')).toHaveLength(1);
    expect(parseIntentPlan('{"name":"秦娘","intent":"接话"}')).toHaveLength(1);
    expect(parseIntentPlan('```json\n{"speakers":[]}\n```')).toEqual([]);
  });

  it('没写 mode 时按正常接话处理，写了乱七八糟的值也按正常接话处理', () => {
    expect(parseIntentPlan('{"speakers":[{"name":"秦娘"}]}')[0]?.mode).toBe('reply');
    expect(parseIntentPlan('{"speakers":[{"name":"秦娘","mode":"乱七八糟"}]}')[0]?.mode).toBe('reply');
  });

  it('完全不是 JSON 时返回空数组，不抛异常', () => {
    expect(parseIntentPlan('我觉得该陈九说话。')).toEqual([]);
  });
});

describe('pickPlannedSpeaker', () => {
  it('挑出计划里第一个能开口的人', () => {
    const qinniang = actor('秦娘');
    const chenjiu = actor('陈九');
    const picked = pickPlannedSpeaker(
      [
        { name: '陈九', intent: '抢着解释', mode: 'cut_in' },
        { name: '秦娘', intent: '接话', mode: 'reply' },
      ],
      [qinniang, chenjiu],
    );

    expect(picked?.instance.displayName).toBe('陈九');
    expect(picked?.intent).toBe('抢着解释');
  });

  it('计划里的名字不在场（或干脆不在名单里）时一律丢弃', () => {
    const picked = pickPlannedSpeaker(
      [{ name: '胡掌柜', intent: '从门外插话', mode: 'reply' }],
      [actor('秦娘'), actor('陈九')],
    );

    expect(picked).toBeNull();
  });

  it('幕后的人不能被计划叫上台', () => {
    const offstage = actor('小满', 'offscreen');
    const picked = pickPlannedSpeaker([{ name: '小满', intent: '想说点什么', mode: 'reply' }], [offstage]);

    expect(picked).toBeNull();
  });

  it('hold_back 不发言：它是「想说没说」，该由生成端写成动作', () => {
    const qinniang = actor('秦娘');
    const picked = pickPlannedSpeaker([{ name: '秦娘', intent: '想拦但没开口', mode: 'hold_back' }], [qinniang]);

    expect(picked).toBeNull();
  });
});
