import type { MemoryEvent } from '../model/message.js';
import { heuristicTokenCounter, type TokenCounter } from '../token/estimate.js';
import type { RecalledMemory, RecallQuery, RecallReason } from './types.js';

export interface RecallWeights {
  keyword: number;
  importance: number;
  recency: number;
  participant: number;
  location: number;
  pinned: number;
  rehearsal: number;
}

export const DEFAULT_RECALL_WEIGHTS: RecallWeights = {
  keyword: 40,
  importance: 25,
  recency: 20,
  participant: 12,
  location: 8,
  pinned: 100,
  rehearsal: 1.5,
};

/** 时效衰减半衰期（天）。三天前的记忆权重减半。 */
export const RECENCY_HALF_LIFE_DAYS = 3;

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const ASCII_WORD = /[a-z0-9_]{2,}/g;

/**
 * 把查询文本切成用于匹配的词元。
 *
 * 中文没有空格，所以用二元组（bigram）近似分词：「酒馆的老板」会切出
 * 「酒馆 / 馆的 / 的老 / 老板」。这不需要引入分词库，对「召回相关的记忆」
 * 这个精度要求已经够用，而且行为完全可预测。
 */
export function tokenizeQuery(text: string): string[] {
  const lower = text.toLowerCase();
  const terms = new Set<string>();

  for (const match of lower.matchAll(ASCII_WORD)) {
    terms.add(match[0]);
  }

  let run: string[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    if (run.length === 1) {
      terms.add(run[0] ?? '');
    } else {
      for (let index = 0; index < run.length - 1; index += 1) {
        terms.add(`${run[index] ?? ''}${run[index + 1] ?? ''}`);
      }
    }
    run = [];
  };

  for (const char of lower) {
    if (CJK.test(char)) {
      run.push(char);
      continue;
    }
    flush();
  }
  flush();

  terms.delete('');
  return [...terms];
}

function ageInDays(createdAt: string, now: string): number {
  const created = Date.parse(createdAt);
  const current = Date.parse(now);
  if (!Number.isFinite(created) || !Number.isFinite(current)) return 0;
  return Math.max(0, (current - created) / 86_400_000);
}

function textOf(event: MemoryEvent): string {
  return `${event.summary} ${event.perception}`.toLowerCase();
}

export function scoreMemory(
  event: MemoryEvent,
  query: RecallQuery,
  terms: readonly string[],
  weights: RecallWeights = DEFAULT_RECALL_WEIGHTS,
): RecalledMemory {
  const reasons: RecallReason[] = [];
  const haystack = textOf(event);

  if (terms.length > 0) {
    let matched = 0;
    for (const term of terms) {
      if (haystack.includes(term)) matched += 1;
    }
    if (matched > 0) {
      const ratio = Math.min(1, matched / terms.length);
      reasons.push({
        code: 'keyword',
        label: `命中 ${matched}/${terms.length} 个关键词`,
        delta: ratio * weights.keyword,
      });
    }
  }

  if (event.importance > 0) {
    reasons.push({
      code: 'importance',
      label: `重要度 ${event.importance.toFixed(2)}`,
      delta: event.importance * weights.importance,
    });
  }

  const age = ageInDays(event.createdAt, query.now);
  const recency = 0.5 ** (age / RECENCY_HALF_LIFE_DAYS);
  if (recency > 0.01) {
    reasons.push({
      code: 'recency',
      label: age < 1 ? '今天的事' : `${Math.round(age)} 天前的事`,
      delta: recency * weights.recency,
    });
  }

  if (event.participants.some((id) => query.participantIds.includes(id))) {
    reasons.push({ code: 'participant', label: '涉及当前在场的人', delta: weights.participant });
  }

  if (query.location.trim() !== '' && event.location === query.location) {
    reasons.push({ code: 'location', label: '发生在同一个地点', delta: weights.location });
  }

  if (event.pinned) {
    reasons.push({ code: 'pinned', label: '被置顶', delta: weights.pinned });
  }

  if (event.recallCount > 0) {
    reasons.push({
      code: 'rehearsal',
      label: `被回想过的次数 ${event.recallCount}`,
      delta: Math.min(event.recallCount, 5) * weights.rehearsal,
    });
  }

  return {
    event,
    score: reasons.reduce((total, reason) => total + reason.delta, 0),
    reasons,
  };
}

export interface RecallOptions {
  weights?: RecallWeights;
  limit?: number;
}

/**
 * 混合召回 v1（ROADMAP P1-3）。
 *
 * 只看视角条目：客观条目是留给用户看的，不属于任何人的记忆。
 * 刻意不做向量检索——先把确定性部分调准，等评测证明关键词不够用
 * 再上向量（P1-11）。
 */
export function recallMemories(
  events: readonly MemoryEvent[],
  query: RecallQuery,
  options: RecallOptions = {},
): RecalledMemory[] {
  const terms = tokenizeQuery(query.text);
  const weights = options.weights ?? DEFAULT_RECALL_WEIGHTS;

  const scored = events
    .filter((event) => event.observerId === query.observerId)
    .map((event) => scoreMemory(event, query, terms, weights))
    .filter((recalled) => recalled.score > 0)
    .sort((a, b) => b.score - a.score || a.event.createdAt.localeCompare(b.event.createdAt));

  return options.limit === undefined ? scored : scored.slice(0, options.limit);
}

/** 按 token 预算裁剪，超出部分宁可丢掉也不让 prompt 爆掉。 */
export function selectWithinBudget(
  recalled: readonly RecalledMemory[],
  budgetTokens: number,
  counter: TokenCounter = heuristicTokenCounter,
): RecalledMemory[] {
  const selected: RecalledMemory[] = [];
  let used = 0;

  for (const item of recalled) {
    const cost = counter.count(item.event.summary) + counter.count(item.event.perception);
    if (used + cost > budgetTokens) continue;
    selected.push(item);
    used += cost;
  }

  return selected;
}

/**
 * 近似去重（ROADMAP T22）。
 *
 * 长跑里同一件事会被反复提起——「夹层」「半堵新墙」「那壶酒」各聊过好几轮，
 * 每一轮都落一条记忆。它们用词接近、说的却是同一件事，于是**同一线索把预算
 * 占掉一大半**：真实数据实测 800 token 里约一半是这种重复条目（EVAL 第五节）。
 *
 * 解决办法不需要嵌入模型：中文没有空格，二元组（bigram）已经能说明两句话像不像——
 * 与关键词召回用的是同一套词元，零依赖、零调用、完全可预测。
 *
 * 保留规则：**留下分数最高的那条**（输入本来就按分数从高到低排好），
 * 后面的近重复直接丢。丢掉的原文一个字都没删，只是这一轮不带进 prompt。
 */
export const DEFAULT_DEDUPE_THRESHOLD = 0.6;

/** 用汇总 + 观感做相似度判断：同一件事在不同回合的两种写法，词元重合度很高。 */
function defaultTextOf(event: MemoryEvent): string {
  return `${event.summary} ${event.perception}`;
}

/** 二元组集合的 Jaccard 相似度（0~1）。两边都没有词元时算 0：无话可说谈不上重复。 */
export function textSimilarity(left: string, right: string): number {
  const a = new Set(tokenizeQuery(left));
  const b = new Set(tokenizeQuery(right));
  if (a.size === 0 || b.size === 0) return 0;

  let shared = 0;
  for (const term of a) {
    if (b.has(term)) shared += 1;
  }
  return shared / (a.size + b.size - shared);
}

export interface DedupeOptions {
  /** 相似度阈值：达到就算重复。默认 0.6——实测值见 EVAL 第五节。 */
  threshold?: number;
  /** 自定义比较用的文字；缺省是 summary + perception。 */
  textOf?: (event: MemoryEvent) => string;
}

export function dedupeRecalled(items: readonly RecalledMemory[], options: DedupeOptions = {}): RecalledMemory[] {
  const threshold = options.threshold ?? DEFAULT_DEDUPE_THRESHOLD;
  const textOf = options.textOf ?? defaultTextOf;

  const kept: RecalledMemory[] = [];
  const keptTexts: string[] = [];

  for (const item of items) {
    const text = textOf(item.event);
    const duplicate = keptTexts.some((other) => textSimilarity(text, other) >= threshold);
    if (duplicate) continue;
    kept.push(item);
    keptTexts.push(text);
  }

  return kept;
}

/**
 * 兜底条目的上限（T22 的实测结论）。
 *
 * 召回分数里有一半是「重要度 + 时效」——它们让玩家说「你好」时角色也能想起几件事，
 * 这是 P1-3 有意留的兜底。但真实数据实测发现：**800 token 预算里平均有 5 条是这样
 * 进来的**，同一角色的其它不相干记忆占掉一半额度；而选中条目之间的相似度只有 0.03
 * ——它不是「重复」，就是「无关」（EVAL 第五节）。
 *
 * 所以这里给兜底设个上限：**有命中时最多再带几条无关的**。一句泛泛的话（一条命中
 * 都没有）仍然照旧兜底，否则角色会什么都想不起来。
 *
 * 置顶条目不算兜底：那是用户明确要求「这条一定要在」。
 */
export const DEFAULT_FALLBACK_LIMIT = 2;

/** 这条记忆是「被问到的东西」，还是「顺带想起来的」。 */
function isOnTopic(item: RecalledMemory): boolean {
  return item.reasons.some((reason) => reason.code === 'keyword' || reason.code === 'pinned');
}

export function limitFallbackItems(
  items: readonly RecalledMemory[],
  maxFallback: number = DEFAULT_FALLBACK_LIMIT,
): RecalledMemory[] {
  // 一条命中的都没有（闲聊、开场白）：保持原来的兜底行为
  if (!items.some(isOnTopic)) return [...items];

  let used = 0;
  return items.filter((item) => {
    if (isOnTopic(item)) return true;
    used += 1;
    return used <= maxFallback;
  });
}
