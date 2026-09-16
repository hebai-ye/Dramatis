import { describe, expect, it } from 'vitest';
import { cardId, type InstanceId, instanceId, newId, nowIso, roomId } from '../model/ids.js';
import { type CharacterInstance, neutralTraits, type Presence } from '../model/instance.js';
import { type ScheduleCandidate, scheduleSpeakers, turnsSinceLastSpoke } from './scheduler.js';

function actor(name: string, presence: Presence = 'onstage', extroversion = 0): CharacterInstance {
  const now = nowIso();
  return {
    id: instanceId(newId()),
    roomId: roomId(newId()),
    cardId: cardId(newId()),
    displayName: name,
    presence,
    traits: { ...neutralTraits(), extroversion },
    affect: { valence: 0, arousal: 0, updatedAt: now, history: [] },
    relationships: [],
    traitsLocked: false,
    createdAt: now,
    updatedAt: now,
  };
}

function candidate(instance: CharacterInstance, turnsSinceSpoke: number | null): ScheduleCandidate {
  return { instance, turnsSinceSpoke };
}

/** 固定随机源，让打分结果可预期。 */
const noJitter = (): number => 0;

/** 依次返回给定值的随机源，用于验证「不同角色拿到不同抖动」。 */
function sequence(...values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index % values.length] ?? 0;
    index += 1;
    return value;
  };
}

describe('scheduleSpeakers / 资格', () => {
  it('只有 onstage 的角色可以发言', () => {
    const muted = actor('Bob', 'muted');
    const offscreen = actor('Carol', 'offscreen');
    const absent = actor('Dave', 'absent');

    const result = scheduleSpeakers({
      playerInput: '有人吗？',
      candidates: [candidate(muted, null), candidate(offscreen, null), candidate(absent, null)],
      random: noJitter,
    });

    expect(result.speakers).toHaveLength(0);
    expect(result.scores.every((score) => score.excluded !== null)).toBe(true);
  });

  it('在场者沉默不发言时给出可读的原因', () => {
    const muted = actor('Bob', 'muted');
    const result = scheduleSpeakers({
      playerInput: '你好',
      candidates: [candidate(muted, null)],
      random: noJitter,
    });

    expect(result.scores[0]?.excluded).toContain('muted');
  });

  it('名单外的角色不能接话，哪怕他的 presence 是在场', () => {
    // 世界拆成多条对话之后会真的发生：陈九的 presence 还是 onstage，
    // 但他不在这条线的场景名单里。只按 presence 过滤的话他会凭空上台。
    const onstage = actor('陈九', 'onstage');
    const inCast = actor('秦娘', 'onstage');

    const result = scheduleSpeakers({
      playerInput: '陈九要是真带我去，你会拦着吗？',
      candidates: [candidate(onstage, null), candidate(inCast, null)],
      cast: [inCast.id],
      random: noJitter,
    });

    expect(result.speakers).toEqual([inCast.id]);
    expect(result.scores.find((score) => score.instanceId === onstage.id)?.excluded).toContain('不在当前场景名单');
  });

  it('玩家接着说给他听时，上一位压过冷却继续接话', () => {
    // 真实使用里踩到的：玩家用「你还记得吗」追问刚说过话的人，v1 因为冷却换了人
    const alice = actor('Alice');
    const bob = actor('Bob');

    const result = scheduleSpeakers({
      playerInput: '你还记得吗？',
      candidates: [candidate(alice, 0), candidate(bob, 3)],
      previousSpeakerId: alice.id,
      random: noJitter,
    });

    expect(result.speakers).toEqual([alice.id]);
    expect(
      result.scores.find((score) => score.instanceId === alice.id)?.reasons.map((reason) => reason.code),
    ).toContain('continuation');
  });

  it('问全场（你们）时按公平性轮换，不算延续', () => {
    const alice = actor('Alice');
    const bob = actor('Bob');

    const result = scheduleSpeakers({
      playerInput: '你们觉得这件事该怎么办？',
      candidates: [candidate(alice, 0), candidate(bob, 3)],
      previousSpeakerId: alice.id,
      random: noJitter,
    });

    expect(result.speakers).toEqual([bob.id]);
  });

  it('玩家点了别人的名时，延续加成让位给点名', () => {
    const alice = actor('Alice');
    const bob = actor('Bob');

    const result = scheduleSpeakers({
      playerInput: 'Bob，你怎么看？',
      candidates: [candidate(alice, 0), candidate(bob, 0)],
      previousSpeakerId: alice.id,
      random: noJitter,
    });

    expect(result.speakers).toEqual([bob.id]);
    expect(
      result.scores.find((score) => score.instanceId === alice.id)?.reasons.map((reason) => reason.code),
    ).not.toContain('continuation');
  });

  it('一句里同时提到两个人时，句首称呼的那个接话', () => {
    // 长跑里踩到的：「小满，我和陈九进院子那会儿……」——两个名字都被提到，
    // 结果冷却决定了一切，回答的人跟被问的人不是同一个
    const xiaoman = actor('小满');
    const chenjiu = actor('陈九');

    const result = scheduleSpeakers({
      playerInput: '小满，我和陈九进院子那会儿，你在哪儿？',
      candidates: [candidate(xiaoman, 0), candidate(chenjiu, 3)],
      previousSpeakerId: xiaoman.id,
      random: noJitter,
    });

    expect(result.speakers).toEqual([xiaoman.id]);
    expect(result.scores.find((score) => score.instanceId === chenjiu.id)?.reasons.map((r) => r.code)).toContain(
      'mentioned',
    );
  });
});

describe('scheduleSpeakers / 打分', () => {
  it('被点名的角色优先接话', () => {
    const alice = actor('Alice');
    const bob = actor('Bob');

    const result = scheduleSpeakers({
      playerInput: 'Bob，你觉得呢？',
      candidates: [candidate(alice, 5), candidate(bob, 5)],
      random: noJitter,
    });

    expect(result.speakers).toEqual([bob.id]);
    const bobScore = result.scores.find((score) => score.instanceId === bob.id);
    expect(bobScore?.reasons.some((reason) => reason.code === 'mentioned')).toBe(true);
  });

  it('别名也能触发点名', () => {
    const alice = actor('Alice');
    const result = scheduleSpeakers({
      playerInput: '老板，来一杯',
      candidates: [{ instance: alice, turnsSinceSpoke: 5, aliases: ['老板'] }],
      random: noJitter,
    });

    expect(result.scores[0]?.reasons.some((reason) => reason.code === 'mentioned')).toBe(true);
  });

  it('刚发过言的角色会被冷却压下去', () => {
    const alice = actor('Alice');
    const bob = actor('Bob');

    const result = scheduleSpeakers({
      playerInput: '你们怎么看',
      candidates: [candidate(alice, 0), candidate(bob, 4)],
      random: noJitter,
    });

    expect(result.speakers).toEqual([bob.id]);
    const aliceScore = result.scores.find((score) => score.instanceId === alice.id);
    expect(aliceScore?.reasons.some((reason) => reason.code === 'cooldown')).toBe(true);
    expect(aliceScore?.score).toBeLessThan(0);
  });

  it('没说过话的角色得到公平性加成', () => {
    const newcomer = actor('Newcomer');
    const result = scheduleSpeakers({
      playerInput: '你好',
      candidates: [candidate(newcomer, null)],
      random: noJitter,
    });

    expect(result.scores[0]?.reasons.some((reason) => reason.code === 'fairness')).toBe(true);
    expect(result.scores[0]?.score).toBeGreaterThanOrEqual(0);
  });

  it('外向角色比内向角色更容易接话', () => {
    const outgoing = actor('Outgoing', 'onstage', 1);
    const shy = actor('Shy', 'onstage', -1);

    const result = scheduleSpeakers({
      playerInput: '随便聊聊',
      candidates: [candidate(outgoing, 3), candidate(shy, 3)],
      random: noJitter,
    });

    expect(result.speakers).toEqual([outgoing.id]);
  });
});

describe('scheduleSpeakers / 选择', () => {
  it('单人场景永远有人接话', () => {
    const only = actor('Only');
    const result = scheduleSpeakers({
      playerInput: '继续说',
      candidates: [candidate(only, 0)],
      random: noJitter,
    });

    expect(result.speakers).toEqual([only.id]);
    expect(result.fallback).toBe(true);
  });

  it('maxSpeakers 限制同时发言的人数', () => {
    const cast = ['A', 'B', 'C'].map((name) => actor(name));
    const result = scheduleSpeakers({
      playerInput: '大家都说说',
      candidates: cast.map((instance) => candidate(instance, 5)),
      maxSpeakers: 2,
      random: noJitter,
    });

    expect(result.speakers).toHaveLength(2);
  });

  it('随机扰动让同分角色不会永远由同一人接话', () => {
    const alice = actor('Alice');
    const bob = actor('Bob');
    const input = {
      playerInput: '嗯',
      candidates: [candidate(alice, 5), candidate(bob, 5)],
    };

    // 候选顺序是 [Alice, Bob]，两次给出相反的抖动值
    const first = scheduleSpeakers({ ...input, random: sequence(0.1, 0.9) });
    const second = scheduleSpeakers({ ...input, random: sequence(0.9, 0.1) });

    expect(first.speakers).toEqual([bob.id]);
    expect(second.speakers).toEqual([alice.id]);
  });
});

describe('turnsSinceLastSpoke', () => {
  function message(turnId: string, speaker: InstanceId | null) {
    return { turnId, speakerInstanceId: speaker };
  }

  it('统计每个角色距上次发言的回合数', () => {
    const alice = instanceId('alice');
    const bob = instanceId('bob');

    const history = [message('t1', alice), message('t2', bob), message('t3', alice)];
    const result = turnsSinceLastSpoke(history, 't4');

    // 0 表示「上一回合刚说过」
    expect(result.get(alice)).toBe(0);
    expect(result.get(bob)).toBe(1);
  });

  it('同一回合内多人发言只算一个回合', () => {
    const alice = instanceId('alice');
    const bob = instanceId('bob');

    const history = [message('t1', alice), message('t1', bob), message('t2', null)];
    const result = turnsSinceLastSpoke(history, 't3');

    expect(result.get(alice)).toBe(1);
    expect(result.get(bob)).toBe(1);
  });

  it('从未发言的角色不出现在结果里', () => {
    const result = turnsSinceLastSpoke([message('t1', null)], 't2');
    expect(result.size).toBe(0);
  });

  it('查不到的角色按「从未发言」处理，仍然拿到公平性加成', () => {
    const fresh = actor('Fresh');
    const looked1 = actor('Looked1');
    const looked2 = actor('Looked2');
    const since = turnsSinceLastSpoke([], 't1');

    const result = scheduleSpeakers({
      playerInput: '你好',
      candidates: [
        { instance: fresh, turnsSinceSpoke: since.get(fresh.id) },
        { instance: looked1, turnsSinceSpoke: since.get(looked1.id) },
        { instance: looked2, turnsSinceSpoke: since.get(looked2.id) },
      ],
      random: noJitter,
    });

    expect(result.scores.every((score) => score.reasons.some((reason) => reason.code === 'fairness'))).toBe(true);
  });
});
