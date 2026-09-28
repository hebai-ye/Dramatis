import { describe, expect, it } from 'vitest';
import { instanceId, newId, nowIso, roomId, sceneId } from '../model/ids.js';
import type { CharacterInstance, Presence } from '../model/instance.js';
import { neutralTraits } from '../model/instance.js';
import type { Scene } from '../model/room.js';
import { buildIntentPlanMessages, parseIntentPlan, pickPlannedSpeaker, pickPlannedSpeakers } from './intent-plan.js';

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
    deletedAt: null,
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
  updatedAt: nowIso(),
  endedAt: null,
  deletedAt: null,
};

describe('buildIntentPlanMessages', () => {
  it('把在场名单与玩家刚说的话交给导演调用，并声明最多几人开口', () => {
    const built = buildIntentPlanMessages({
      scene,
      cast: [actor('秦娘'), actor('陈九')],
      playerName: '旅人',
      playerInput: '那批货到底是谁点过数的？',
      recentMessages: [],
      lastIntentByInstance: new Map(),
      playerActionOnly: false,
      actionsOnly: false,
      maxSpeakers: 1,
    });

    const body = built.map((message) => message.content).join('\n');
    expect(body).toContain('当前场景可发言名单');
    expect(body).toContain('那批货到底是谁点过数的？');
    expect(body).toContain('本轮最多参与人数：1');
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

describe('多人导演计划', () => {
  it('按编号选择两人，错配姓名、重复和场外建议被拒绝', () => {
    const a = actor('秦娘');
    const b = actor('陈九');
    const picked = pickPlannedSpeakers(
      [
        { key: 'C2', name: '陈九', intent: '想解释', mode: 'cut_in' },
        { key: 'C1', name: '秦娘', intent: '想追问', mode: 'hold_back' },
        { key: 'C1', name: '陈九', intent: '错配', mode: 'reply' },
        { key: 'C2', name: '陈九', intent: '重复', mode: 'reply' },
        { key: 'C3', name: '胡掌柜', intent: '场外', mode: 'reply' },
      ],
      [a, b],
      2,
    );
    expect(picked.speakers.map((entry) => [entry.instance.id, entry.mode])).toEqual([
      [b.id, 'cut_in'],
      [a.id, 'hold_back'],
    ]);
    expect(picked.rejectedEntries).toBe(3);
  });

  it('提示词给出动作条件、上一条意图、两人上限且不允许空数组', () => {
    const a = actor('秦娘');
    a.affect.arousal = 0.45;
    const built = buildIntentPlanMessages({
      scene,
      cast: [a, actor('陈九')],
      playerName: '旅人',
      playerInput: '# 我推开门',
      recentMessages: [],
      lastIntentByInstance: new Map([[a.id, '等待回答']]),
      playerActionOnly: true,
      actionsOnly: true,
      maxSpeakers: 2,
    });
    const body = built.map((message) => message.content).join('\n');
    expect(body).toContain('C1｜秦娘｜上一条意图：等待回答｜激动程度：0.45');
    expect(body).toContain('本轮最多参与人数：2');
    expect(body).toContain('本轮回复形式：只许动作');
    expect(body).toContain('speakers 至少给一项');
    expect(body).toContain('"key":"C1"');
    expect(body).not.toContain('speakers 给空数组');
  });

  it('解析新编号格式，旧姓名格式仍可用', () => {
    expect(parseIntentPlan('{"speakers":[{"key":"C1","name":"秦娘","intent":"回答","mode":"reply"}]}')).toEqual([
      { key: 'C1', name: '秦娘', intent: '回答', mode: 'reply' },
    ]);
    const a = actor('秦娘');
    expect(
      pickPlannedSpeakers([{ name: '秦娘', intent: '回答', mode: 'reply' }], [a], 2).speakers[0]?.instance.id,
    ).toBe(a.id);
  });
});
