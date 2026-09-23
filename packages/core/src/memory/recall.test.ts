import { describe, expect, it } from 'vitest';
import { eventId, instanceId, newId, roomId } from '../model/ids.js';
import type { MemoryEvent } from '../model/message.js';
import { heuristicTokenCounter } from '../token/estimate.js';
import {
  dedupeRecalled,
  isSuperseded,
  limitFallbackItems,
  recallForPrompt,
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

describe('顺序 57：被取代的原文退出常规召回，保留「提到才想起」', () => {
  const IMPRESSION = eventId('impression');

  /** 一条印象 + 它压掉的三条原文 + 一条没被合并的近事。 */
  function pool() {
    const impression = memory({
      id: IMPRESSION,
      summary: '这段时间我一直在留意账房那边的动静，也答应过阿箬先不声张。',
      supersedes: [eventId('old-a'), eventId('old-b'), eventId('old-c')],
      supersededBy: null,
    });
    const oldA = memory({
      id: eventId('old-a'),
      summary: '玩家问起后艄舱板底下的夹层，陈九说能塞两个麻包。',
      supersededBy: IMPRESSION,
    });
    const oldB = memory({
      id: eventId('old-b'),
      summary: '玩家在码头追问账房的货单，角色答了话。',
      supersededBy: IMPRESSION,
    });
    const oldC = memory({
      id: eventId('old-c'),
      summary: '秦娘说店里还剩三间空房。',
      supersededBy: IMPRESSION,
    });
    const fresh = memory({ id: eventId('fresh'), summary: '小满提醒前头滩口子底下有淤泥。', importance: 0.6 });
    return { impression, oldA, oldB, oldC, fresh, all: [impression, oldA, oldB, oldC, fresh] };
  }

  const ids = (items: ReadonlyArray<{ event: MemoryEvent }>): string[] => items.map((item) => String(item.event.id));

  it('isSuperseded：盖了章的才算被取代', () => {
    expect(isSuperseded({ supersededBy: null })).toBe(false);
    expect(isSuperseded({})).toBe(false);
    expect(isSuperseded({ supersededBy: IMPRESSION })).toBe(true);
  });

  it('recallMemories 默认不返回被取代的原文，哪怕关键词正好命中', () => {
    const { all } = pool();
    const recalled = recallMemories(all, query({ text: '夹层' }));

    expect(ids(recalled)).not.toContain('old-a');
    expect(ids(recalled)).not.toContain('old-b');
    expect(ids(recalled)).toContain('impression');
    expect(ids(recalled)).toContain('fresh');
  });

  it('显式 superseded: include 时原文仍然可以参与（面板、探针要用）', () => {
    const { all } = pool();
    const recalled = recallMemories(all, query({ text: '夹层' }), { superseded: 'include' });

    expect(ids(recalled)).toContain('old-a');
    expect(recalled[0]?.event.id).toBe('old-a'); // 关键词命中的那条排最前
  });

  it('玩家没提到旧事时，一轮的记忆只有常规通路', () => {
    const { all } = pool();
    const result = recallForPrompt(all, query({ text: '今晚喝点什么？' }), {
      budgetTokens: 1000,
      mentionText: '今晚喝点什么？',
    });

    expect(result.candidates).toEqual({ recall: 2, mention: 0, source: 0 });
    expect(result.selected.every((item) => item.origin === 'recall')).toBe(true);
    expect(ids(result.selected)).toEqual(expect.arrayContaining(['impression', 'fresh']));
    expect(ids(result.selected)).not.toContain('old-a');
  });

  it('玩家这句提到关键词时，被取代原文最多回来 2 条，且排在常规项之后、分数更低', () => {
    const { all } = pool();
    const text = '夹层的事，还有账房的货单，空房呢？';
    const result = recallForPrompt(all, query({ text }), { budgetTokens: 1000, mentionText: text });

    // 三条原文都命中了（夹层 / 账房货单 / 空房），只带两条：命中最多的那条优先
    expect(result.candidates.mention).toBe(2);
    const mentioned = result.selected.filter((item) => item.origin === 'mention');
    expect(ids(mentioned)).toEqual(['old-b', 'old-a']);
    expect(ids(result.selected)).not.toContain('old-c');

    // 常规项（印象 + 近事）全部排在补充项前面，分数也严格更高
    const origins = result.selected.map((item) => item.origin);
    expect(origins).toEqual(['recall', 'recall', 'mention', 'mention']);
    const lowestRecall = Math.min(
      ...result.selected.filter((item) => item.origin === 'recall').map((item) => item.score),
    );
    expect(mentioned.every((item) => item.score < lowestRecall)).toBe(true);
  });

  it('「提到」只看玩家这一句：历史里出现过的词不算', () => {
    const { all } = pool();
    const result = recallForPrompt(
      all,
      // 常规召回的查询文本照旧带着最近几轮——里面有「夹层」「账房」
      query({ text: '今晚喝点什么？\n玩家：夹层的事怎么样了\n陈九：账房的货单在我这' }),
      { budgetTokens: 1000, mentionText: '今晚喝点什么？' },
    );

    expect(result.candidates.mention).toBe(0);
    expect(ids(result.selected)).not.toContain('old-a');
    expect(ids(result.selected)).not.toContain('old-b');
  });

  it('玩家问过去时，印象顺着 supersedes 展开最多 2 条来源原文', () => {
    const { all } = pool();
    const text = '你还记得之前的事吗？';
    const result = recallForPrompt(all, query({ text }), { budgetTokens: 1000, mentionText: text, askingPast: true });

    expect(result.candidates).toEqual({ recall: 2, mention: 0, source: 2 });
    const sources = result.selected.filter((item) => item.origin === 'source');
    expect(ids(sources)).toEqual(['old-a', 'old-b']);
    // 来源在常规项之后
    const firstSource = result.selected.findIndex((item) => item.origin === 'source');
    const lastRecall = result.selected.map((item) => item.origin).lastIndexOf('recall');
    expect(firstSource).toBeGreaterThan(lastRecall);

    // 没在问过去：一条来源都不展开
    const plain = recallForPrompt(all, query({ text }), { budgetTokens: 1000, mentionText: text });
    expect(plain.candidates.source).toBe(0);
  });

  it('同一条原文不会既算「提到」又算「来源」', () => {
    const { all } = pool();
    const result = recallForPrompt(all, query({ text: '夹层呢？' }), {
      budgetTokens: 1000,
      mentionText: '夹层呢？',
      askingPast: true,
    });

    expect(result.candidates).toEqual({ recall: 2, mention: 1, source: 2 });
    const selectedIds = ids(result.selected);
    expect(new Set(selectedIds).size).toBe(selectedIds.length);
    expect(result.selected.find((item) => item.origin === 'mention')?.event.id).toBe('old-a');
    expect(ids(result.selected.filter((item) => item.origin === 'source'))).toEqual(['old-b', 'old-c']);
  });

  it('预算不够时先丢补充项，常规命中与印象一条不少', () => {
    const { impression, fresh, all } = pool();
    const cost = (event: MemoryEvent): number =>
      heuristicTokenCounter.count(event.summary) + heuristicTokenCounter.count(event.perception);
    const text = '夹层的事，还有账房的货单，空房呢？';
    const result = recallForPrompt(all, query({ text }), {
      budgetTokens: cost(impression) + cost(fresh),
      mentionText: text,
      askingPast: true,
    });

    expect(result.candidates.mention).toBe(2);
    expect(ids(result.selected).sort()).toEqual(['fresh', 'impression']);
    expect(result.selected.every((item) => item.origin === 'recall')).toBe(true);
  });

  it('近事把预算填满时，被提到的旧事仍留得住一小块位置（真机演练抓到的）', () => {
    const { all } = pool();
    // 三十条近事都带着「码头」——台词里反复出现的地名让它们全算命中，光它们就能把 800 token 填满
    const recent = Array.from({ length: 30 }, (_, index) =>
      memory({
        id: eventId(`recent-${String(index)}`),
        summary: `玩家在码头追问了第 ${String(index)} 句，角色答了话。`,
        perception: '他问得这么细，八成已经知道点什么了。',
        createdAt: `2026-01-01T00:${String(index).padStart(2, '0')}:00.000Z`,
      }),
    );
    const text = '码头呢？';
    const cost = (event: MemoryEvent): number =>
      heuristicTokenCounter.count(event.summary) + heuristicTokenCounter.count(event.perception);

    const result = recallForPrompt([...all, ...recent], query({ text }), { budgetTokens: 800, mentionText: text });

    // 被取代的原文里只有 old-b 提到码头；它进来了，排在最后，常规项只让出它那一点
    expect(result.candidates.mention).toBe(1);
    expect(result.selected.at(-1)?.event.id).toBe('old-b');
    expect(result.selected.at(-1)?.origin).toBe('mention');
    const primaryCount = result.selected.filter((item) => item.origin === 'recall').length;
    expect(primaryCount).toBeGreaterThanOrEqual(18);
    expect(result.selected.reduce((sum, item) => sum + cost(item.event), 0)).toBeLessThanOrEqual(800);

    // 不留位置的话它就进不来——这就是为什么要留
    const squeezed = recallForPrompt([...all, ...recent], query({ text }), {
      budgetTokens: 800,
      mentionText: text,
      supplementShare: 0,
    });
    expect(squeezed.candidates.mention).toBe(1);
    expect(ids(squeezed.selected)).not.toContain('old-b');
    expect(squeezed.selected.every((item) => item.origin === 'recall')).toBe(true);
  });
});
