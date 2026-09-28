import { describe, expect, it } from 'vitest';
import { cardId, instanceId, newId, nowIso, roomId } from '../model/ids.js';
import { type CharacterInstance, neutralTraits, type Presence } from '../model/instance.js';
import type { IntentPlanEntry } from './intent-plan.js';
import { scheduleSpeakers } from './scheduler.js';
import { directAddressees, selectTurnSpeakers } from './turn-speakers.js';

function actor(name: string, presence: Presence = 'onstage'): CharacterInstance {
  const now = nowIso();
  return {
    id: instanceId(newId()),
    roomId: roomId(newId()),
    cardId: cardId(newId()),
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

function select(input: {
  text: string;
  cast: CharacterInstance[];
  plan: IntentPlanEntry[] | null;
  max?: 1 | 2 | 3;
  actionsOnly?: boolean;
}) {
  const schedule = scheduleSpeakers({
    playerInput: input.text,
    candidates: input.cast.map((instance) => ({ instance, turnsSinceSpoke: null })),
    cast: input.cast.map((instance) => instance.id),
    maxSpeakers: 1,
    random: () => 0,
  });
  return selectTurnSpeakers({
    playerInput: input.text,
    eligibleCast: input.cast,
    schedule,
    plan: input.plan,
    maxSpeakers: input.max ?? 2,
    actionsOnly: input.actionsOnly ?? false,
  });
}

describe('本轮多人发言选择', () => {
  it('句首称呼 A、句中提到 B 时，A 必须先于导演建议的 B', () => {
    const a = actor('小满');
    const b = actor('陈九');
    const result = select({
      text: '小满，我和陈九进院子那会儿，你看见什么？',
      cast: [a, b],
      plan: [{ name: '陈九', intent: '想补充所见', mode: 'cut_in' }],
    });
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(result.speakers.map((speaker) => speaker.instance.id)).toEqual([a.id, b.id]);
    expect(result.speakers[0]?.source).toBe('addressed');
  });

  it('多个直接称呼超过设置上限时拒绝，不能默默少选一个', () => {
    const a = actor('小满');
    const b = actor('陈九');
    expect(directAddressees('小满、陈九，你们觉得呢？', [a, b])).toEqual([a.id, b.id]);
    const result = select({ text: '小满、陈九，你们觉得呢？', cast: [a, b], plan: null, max: 1 });
    expect(result).toMatchObject({ kind: 'too-many-addressed', addressed: [a.id, b.id] });
  });

  it('导演只挑一个时不按规则分数填满人数；空计划仅由规则保底一人', () => {
    const a = actor('小满');
    const b = actor('陈九');
    const planned = select({
      text: '大家觉得呢？',
      cast: [a, b],
      plan: [{ name: '陈九', intent: '愿意回答', mode: 'reply' }],
    });
    expect(planned.kind).toBe('ready');
    if (planned.kind !== 'ready') return;
    expect(planned.speakers.map((speaker) => speaker.instance.id)).toEqual([b.id]);

    const fallback = select({ text: '大家觉得呢？', cast: [a, b], plan: [] });
    expect(fallback.kind).toBe('ready');
    if (fallback.kind !== 'ready') return;
    expect(fallback.speakers).toHaveLength(1);
    expect(fallback.speakers[0]?.source).toBe('rule');
  });

  it('不在当前合格场景的人不能被导演或规则带上台', () => {
    const a = actor('小满');
    const outside = actor('陈九');
    const result = select({
      text: '陈九怎么想？',
      cast: [a],
      plan: [{ name: outside.displayName, intent: '想回答', mode: 'reply' }],
    });
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(result.speakers.map((speaker) => speaker.instance.id)).toEqual([a.id]);
  });

  it('导演选中的 hold_back 消耗名额并生成动作；只许动作时所有人都改为 hold_back', () => {
    const a = actor('小满');
    const b = actor('陈九');
    const plan: IntentPlanEntry[] = [
      { name: '小满', intent: '欲言又止', mode: 'hold_back' },
      { name: '陈九', intent: '插话', mode: 'cut_in' },
    ];
    const result = select({ text: '# 我推开门', cast: [a, b], plan, actionsOnly: true });
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(result.speakers.map((speaker) => [speaker.instance.id, speaker.mode])).toEqual([
      [b.id, 'hold_back'],
      [a.id, 'hold_back'],
    ]);
  });

  it('无人合格时返回明确的不可发送结果', () => {
    const result = select({ text: '有人吗？', cast: [], plan: null });
    expect(result).toMatchObject({ kind: 'no-eligible-speaker', speakers: [] });
  });
});

describe('导演编号进入最终名单前的复核', () => {
  it('C1 编号却写成 B 的姓名时不让 B 接话', () => {
    const a = actor('小满');
    const b = actor('陈九');
    const result = select({
      text: '小满，你觉得呢？',
      cast: [a, b],
      plan: [{ key: 'C1', name: '陈九', intent: '想回答', mode: 'reply' }],
    });
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(result.speakers.map((speaker) => speaker.instance.id)).toEqual([a.id]);
    expect(result.rejectedPlanEntries).toBe(1);
  });
});

describe('抢话与人数上限', () => {
  it('导演超额建议中靠后的 cut_in 仍先于普通接话入选', () => {
    const a = actor('甲');
    const b = actor('乙');
    const c = actor('丙');
    const result = select({
      text: '你们觉得呢？',
      cast: [a, b, c],
      plan: [
        { key: 'C1', name: '甲', intent: '回答', mode: 'reply' },
        { key: 'C2', name: '乙', intent: '回答', mode: 'reply' },
        { key: 'C3', name: '丙', intent: '抢话', mode: 'cut_in' },
      ],
      max: 2,
    });
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(result.speakers.map((speaker) => speaker.instance.id)).toEqual([c.id, a.id]);
  });
});
