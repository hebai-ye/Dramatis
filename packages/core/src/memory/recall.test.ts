import { describe, expect, it } from 'vitest';
import { eventId, instanceId, newId, roomId } from '../model/ids.js';
import type { MemoryEvent } from '../model/message.js';
import {
  dedupeRecalled,
  limitFallbackItems,
  recallMemories,
  scoreMemory,
  selectWithinBudget,
  textSimilarity,
  tokenizeQuery,
} from './recall.js';
import type { RecallQuery } from './types.js';

const OBSERVER = instanceId('observer-1');

function memory(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: eventId(newId()),
    roomId: roomId('room-1'),
    conversationId: null,
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
    updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
    deletedAt: null,
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

describe('近似去重（T22）', () => {
  it('相似度有区分度：几乎一样 > 换了说法 > 完全不同', () => {
    const base = '玩家问起船上的夹层，陈九说后艄舱板底下能塞两个麻包。';
    const nearlySame = '玩家问起船上的夹层，陈九说后艄舱板底下能塞两个麻包。';
    const paraphrase = '陈九说后艄舱板底下有夹层，能塞两个麻包，外头看不出来。';
    const different = '小满说先生烧过一批盖着断角鹿印的货单。';

    const same = textSimilarity(base, nearlySame);
    const reworded = textSimilarity(base, paraphrase);
    const other = textSimilarity(base, different);

    expect(same).toBe(1);
    expect(reworded).toBeGreaterThan(other);
    expect(reworded).toBeGreaterThan(0.4);
    expect(other).toBeLessThan(0.2);
  });

  it('留下分数最高的那条，别的近重复丢掉', () => {
    const ranked = [
      {
        event: memory({ id: eventId('high'), summary: '玩家问起船上的夹层，陈九说后艄舱板底下能塞两个麻包。' }),
        score: 90,
        reasons: [],
      },
      {
        event: memory({
          id: eventId('dup'),
          summary: '玩家问起船上的夹层，陈九说后艄舱板底下能塞两个麻包，外头看不出来。',
        }),
        score: 80,
        reasons: [],
      },
      {
        event: memory({ id: eventId('other'), summary: '小满说先生烧过一批盖着断角鹿印的货单。' }),
        score: 70,
        reasons: [],
      },
    ];

    const kept = dedupeRecalled(ranked);
    expect(kept.map((item) => item.event.id)).toEqual(['high', 'other']);
  });

  it('阈值可调：调高之后「换了说法」的那条会被留下', () => {
    const ranked = [
      {
        event: memory({ id: eventId('a'), summary: '玩家问起船上的夹层，陈九说后艄舱板底下能塞两个麻包。' }),
        score: 90,
        reasons: [],
      },
      {
        event: memory({ id: eventId('b'), summary: '陈九说后艄舱板底下有夹层，能塞两个麻包，外头看不出来。' }),
        score: 80,
        reasons: [],
      },
    ];

    // 实测这种换说法约 0.48：阈值 0.4 判为重复，0.9 则不判
    expect(dedupeRecalled(ranked, { threshold: 0.4 })).toHaveLength(1);
    expect(dedupeRecalled(ranked, { threshold: 0.9 })).toHaveLength(2);
  });

  it('没有词元的条目不会被误判成重复', () => {
    expect(textSimilarity('。。。', '！？')).toBe(0);
    expect(textSimilarity('', '任何东西')).toBe(0);
  });

  it('去重之后预算能装下更多不同的线索', () => {
    // 三条近重复 + 一条别的事：不去重时预算只够两条近重复，去重后另一条线索进得来
    const events = [
      memory({ summary: `玩家问船上夹层，陈九说后艄舱板底下能塞两个麻包${'。'}` }),
      memory({ summary: '陈九说后艄舱板底下有夹层，能塞两个麻包，外头看不出来。' }),
      memory({ summary: '陈九提到后艄舱板底下的夹层，说能塞两个麻包。' }),
      memory({ summary: '小满说先生收过一批盖着断角鹿印的货单，第二天叫她全烧了。' }),
    ];
    const recalled = recallMemories(events, query({ text: '夹层 鹿印' }));

    const withoutDedupe = selectWithinBudget(recalled, 60);
    const withDedupe = selectWithinBudget(dedupeRecalled(recalled, { threshold: 0.4 }), 60);

    expect(withoutDedupe.length).toBeGreaterThan(0);
    expect(withDedupe.some((item) => item.event.summary.includes('鹿印'))).toBe(true);
  });
});

describe('兜底条目上限（T22 实测结论）', () => {
  /** 造一条「被问到的东西」：有关键词命中。 */
  function onTopic(summary: string) {
    const recalled = recallMemories([memory({ summary })], query({ text: '夹层' }));
    const item = recalled[0];
    if (!item) throw new Error('没造出命中条目');
    return item;
  }

  /** 造一条「顺带想起来的」：没有关键词命中，只靠重要度与时效。 */
  function offTopic(summary: string) {
    const recalled = recallMemories([memory({ summary, importance: 0.6 })], query({ text: '夹层' }));
    const item = recalled[0];
    if (!item) throw new Error('没造出兜底条目');
    return item;
  }

  it('有命中时，兜底条目最多留 N 条', () => {
    const items = [
      onTopic('玩家问起后艄舱板底下的夹层。'),
      offTopic('秦娘说店里还剩三间空房。'),
      offTopic('小满提醒前头滩口子底下有淤泥。'),
      offTopic('陈九说渡口还有夜船。'),
      offTopic('玩家问起巷口那半堵新墙。'),
    ];

    const limited = limitFallbackItems(items, 2);
    expect(limited).toHaveLength(3); // 1 条命中 + 2 条兜底
    expect(limited[0]?.event.summary).toContain('夹层');
  });

  it('一条命中都没有时保持原来的兜底（不能什么都不给）', () => {
    const items = [
      offTopic('秦娘说店里还剩三间空房。'),
      offTopic('小满提醒前头滩口子底下有淤泥。'),
      offTopic('陈九说渡口还有夜船。'),
    ];

    expect(limitFallbackItems(items, 2)).toHaveLength(3);
  });

  it('置顶的条目不算兜底：用户要求它一定要在', () => {
    const pinned = recallMemories(
      [memory({ summary: '一件很久以前的事。', pinned: true, importance: 0.2 })],
      query({ text: '夹层' }),
    )[0];
    if (!pinned) throw new Error('没造出置顶条目');

    const items = [onTopic('玩家问起后艄舱板底下的夹层。'), offTopic('秦娘说店里还剩三间空房。'), pinned];
    expect(limitFallbackItems(items, 0).map((item) => item.event.summary)).toEqual([
      '玩家问起后艄舱板底下的夹层。',
      '一件很久以前的事。',
    ]);
  });
});
