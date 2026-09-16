import { describe, expect, it } from 'vitest';
import { eventId, instanceId, newId, roomId } from '../model/ids.js';
import type { MemoryEvent } from '../model/message.js';
import { recallMemories, scoreMemory, selectWithinBudget, tokenizeQuery } from './recall.js';
import type { RecallQuery } from './types.js';

const OBSERVER = instanceId('observer-1');

function memory(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: eventId(newId()),
    roomId: roomId('room-1'),
    sceneId: null,
    timeline: { worldTime: '第三日', sequence: 1 },
    location: '',
    participants: [],
    summary: '发生了某件事',
    observerId: OBSERVER,
    perception: '',
    importance: 0.5,
    pinned: false,
    importanceLocked: false,
    affects: [],
    sourceTurnIds: ['turn-1'],
    createdAt: '2026-01-01T00:00:00.000Z',
    lastRecalledAt: null,
    recallCount: 0,
    ...overrides,
  };
}

function query(overrides: Partial<RecallQuery> = {}): RecallQuery {
  return {
    observerId: OBSERVER,
    text: '',
    participantIds: [],
    location: '',
    now: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('tokenizeQuery', () => {
  it('把中文切成二元组', () => {
    expect(tokenizeQuery('酒馆老板').sort()).toEqual(
      ['馆老', '板', '酒馆', '老板'].filter((t) => t.length === 2).sort(),
    );
  });

  it('单个汉字也保留', () => {
    expect(tokenizeQuery('雨')).toEqual(['雨']);
  });

  it('英文按词切分并忽略单字符', () => {
    const terms = tokenizeQuery('I met Alice at the Tavern');
    expect(terms).toContain('met');
    expect(terms).toContain('alice');
    expect(terms).toContain('tavern');
    expect(terms).not.toContain('i');
  });

  it('中英混排都能切出来', () => {
    const terms = tokenizeQuery('Alice 去了酒馆');
    expect(terms).toContain('alice');
    expect(terms).toContain('酒馆');
  });

  it('重复词只保留一次', () => {
    const terms = tokenizeQuery('酒馆 酒馆 alice alice');
    expect(terms.filter((term) => term === '酒馆')).toHaveLength(1);
    expect(terms.filter((term) => term === 'alice')).toHaveLength(1);
  });
});

describe('scoreMemory', () => {
  it('关键词命中加分', () => {
    const scored = scoreMemory(memory({ summary: '商队在雨夜失踪了' }), query({ text: '商队' }), ['商队']);
    expect(scored.reasons.some((reason) => reason.code === 'keyword')).toBe(true);
  });

  it('关键词不命中就不加关键词分', () => {
    const scored = scoreMemory(memory({ summary: '无关的事' }), query({ text: '商队' }), ['商队']);
    expect(scored.reasons.some((reason) => reason.code === 'keyword')).toBe(false);
  });

  it('时间越久时效分越低', () => {
    const fresh = scoreMemory(
      memory({ createdAt: '2026-01-01T00:00:00.000Z' }),
      query({ now: '2026-01-01T00:00:00.000Z' }),
      [],
    );
    const old = scoreMemory(
      memory({ createdAt: '2026-01-01T00:00:00.000Z' }),
      query({ now: '2026-01-11T00:00:00.000Z' }),
      [],
    );

    expect(fresh.score).toBeGreaterThan(old.score);
  });

  it('涉及当前在场者时加分', () => {
    const scored = scoreMemory(memory({ participants: [instanceId('a')] }), query({ participantIds: ['a', 'b'] }), []);
    expect(scored.reasons.some((reason) => reason.code === 'participant')).toBe(true);
  });

  it('同一地点时加分', () => {
    const scored = scoreMemory(memory({ location: '旧城酒馆' }), query({ location: '旧城酒馆' }), []);
    expect(scored.reasons.some((reason) => reason.code === 'location')).toBe(true);
  });

  it('置顶的记忆拿到最高权重', () => {
    const pinned = scoreMemory(memory({ pinned: true }), query(), []);
    const plain = scoreMemory(memory(), query(), []);
    expect(pinned.score).toBeGreaterThan(plain.score + 50);
  });
});

describe('recallMemories', () => {
  it('只召回这个人自己的视角条目', () => {
    const mine = memory({ observerId: OBSERVER, summary: '我记得的事' });
    const others = memory({ observerId: instanceId('someone-else'), summary: '别人记得的事' });
    const objective = memory({ observerId: null, summary: '客观发生的事' });

    const recalled = recallMemories([mine, others, objective], query({ text: '' }));

    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.event.summary).toBe('我记得的事');
  });

  it('按分数从高到低排序', () => {
    const high = memory({ summary: '商队失踪', importance: 1 });
    const low = memory({ summary: '无关紧要', importance: 0.1 });

    const recalled = recallMemories([low, high], query({ text: '商队' }));

    expect(recalled[0]?.event.summary).toBe('商队失踪');
  });

  it('limit 截断结果', () => {
    const events = Array.from({ length: 5 }, (_, index) => memory({ summary: `第 ${index} 件` }));
    expect(recallMemories(events, query(), { limit: 2 })).toHaveLength(2);
  });

  it('没有记忆时返回空数组', () => {
    expect(recallMemories([], query())).toEqual([]);
  });
});

describe('selectWithinBudget', () => {
  it('预算充足时全部保留', () => {
    const events = [memory({ summary: '短' }), memory({ summary: '也短' })];
    const recalled = recallMemories(events, query());
    expect(selectWithinBudget(recalled, 1000)).toHaveLength(2);
  });

  it('预算不足时跳过装不下的条目而不是超支', () => {
    // 中文按一字一 token 估算，两条各 50 token，预算 60 只装得下一条
    const events = [memory({ summary: '记'.repeat(50) }), memory({ summary: '忆'.repeat(50) })];
    const recalled = recallMemories(events, query());

    const selected = selectWithinBudget(recalled, 60);

    expect(selected).toHaveLength(1);
  });

  it('预算为 0 时返回空', () => {
    const recalled = recallMemories([memory()], query());
    expect(selectWithinBudget(recalled, 0)).toEqual([]);
  });
});
