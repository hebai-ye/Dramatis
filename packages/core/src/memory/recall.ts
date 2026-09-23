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
  /**
   * 被印象取代的原文（`supersededBy` 非空）要不要参与（顺序 57）。
   *
   * 默认 **不参与**：合并（27a）的目的就是让池子不再线性涨。原文既然已经并进印象，
   * 常规召回就只看印象；原文留给 `recallForPrompt` 的「提到才想起」通路。
   */
  superseded?: 'exclude' | 'include';
}

/** 这条记忆已经被合并进某条印象。 */
export function isSuperseded(event: Pick<MemoryEvent, 'supersededBy'>): boolean {
  return event.supersededBy !== null && event.supersededBy !== undefined;
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
  const includeSuperseded = options.superseded === 'include';

  const scored = events
    .filter((event) => event.observerId === query.observerId)
    .filter((event) => includeSuperseded || !isSuperseded(event))
    .map((event) => scoreMemory(event, query, terms, weights))
    .filter((recalled) => recalled.score > 0)
    .sort((a, b) => b.score - a.score || a.event.createdAt.localeCompare(b.event.createdAt));

  return options.limit === undefined ? scored : scored.slice(0, options.limit);
}

/** 按 token 预算裁剪，超出部分宁可丢掉也不让 prompt 爆掉。 */
export function selectWithinBudget<T extends RecalledMemory>(
  recalled: readonly T[],
  budgetTokens: number,
  counter: TokenCounter = heuristicTokenCounter,
): T[] {
  const selected: T[] = [];
  let used = 0;

  for (const item of recalled) {
    const cost = memoryCost(item, counter);
    if (used + cost > budgetTokens) continue;
    selected.push(item);
    used += cost;
  }

  return selected;
}

/** 一条记忆进提示词要花多少 token（与 `selectWithinBudget` 同一把尺子）。 */
function memoryCost(item: RecalledMemory, counter: TokenCounter): number {
  return counter.count(item.event.summary) + counter.count(item.event.perception);
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

/**
 * 给一轮生成挑记忆（顺序 57）：常规召回 + 「提到才想起」+ 「问过去时翻出印象背后的原文」。
 *
 * 用户拍板的语义：被印象取代的原文**不参与常规召回**（否则合并白做，池子反而多一条），
 * 但**保留索引**——玩家明确提到那件事时，仍然能把原文想起来。所以这里有三条通路：
 *
 * 1. **常规**：只在未被取代的条目里召回（印象在内），照旧限兜底、按预算裁剪；
 * 2. **提到**：被取代的原文只看**玩家这句话本身**（不看最近几轮历史，否则一个词会连着
 *    六轮把旧事翻出来）有没有命中它的关键词；命中的最多带 `mentionLimit` 条；
 * 3. **问过去**：玩家在问「还记得吗 / 上次」这类话时，把召回到的印象顺着 `supersedes`
 *    展开最多 `sourceLimit` 条来源原文——印象是概括，问细节时要给得出细节。
 *
 * 后两条通路的条目**分数一律压到低于所有常规条目**：它们是补充，窗口不够时预算守卫先丢它们；
 * 在提示词里也标出「旧事」，模型知道这是被提起才想起来的。
 *
 * 但记忆预算里要给它们**留一小块位置**（默认不超过 1/4，且只按实际装得下的量留）。
 * 真机演练抓到的：常规召回的查询文本带着最近几轮，台词里反复出现的地名按二元组一切，
 * 近几十条原文**全部**算命中、把预算填满——补充项排在最后就永远进不来，
 * 「提到才想起」形同虚设。预留只在补充项真的存在、也真的装得下时才占；预算小到
 * 一条补充项都装不下时预留为 0，常规项一条不少。
 */
export type RecallOrigin = 'recall' | 'mention' | 'source';

export interface RecallForPromptOptions {
  weights?: RecallWeights;
  /** 每个角色每轮最多带多少 token 的记忆。 */
  budgetTokens: number;
  counter?: TokenCounter;
  /** 有命中时最多再带几条「顺带想起」的（T22）。 */
  fallbackLimit?: number;
  /** 被取代原文按「提到」取回的上限。 */
  mentionLimit?: number;
  /** 问过去时，每轮最多展开几条印象来源。 */
  sourceLimit?: number;
  /** 补充项最多能占预算的几分之几（0~1）；默认 1/4。 */
  supplementShare?: number;
  /**
   * 用来判断「有没有明确提到」的文本：**只能是玩家这一句**，不含历史。
   *
   * 故意做成必填而不是缺省退回 `query.text`：常规召回的 `query.text` 通常带着
   * 最近六轮，拿它判「提到」会让一个词连着六轮把旧事翻出来——那就不是「提到才想起」了。
   */
  mentionText: string;
  /** 玩家是否在问过去；由调用方用 `asksAboutPast(玩家这句)` 判断。 */
  askingPast?: boolean;
}

export interface RecalledForPrompt extends RecalledMemory {
  origin: RecallOrigin;
}

export interface RecallForPromptResult {
  /** 已按预算裁剪、按「常规 → 提到 → 来源」排好的条目。 */
  selected: RecalledForPrompt[];
  /** 裁剪前各通路各有几条，给检查器与日志用。 */
  candidates: Record<RecallOrigin, number>;
}

export const DEFAULT_MENTION_LIMIT = 2;
export const DEFAULT_SOURCE_LIMIT = 2;
export const DEFAULT_SUPPLEMENT_SHARE = 0.25;

export function recallForPrompt(
  events: readonly MemoryEvent[],
  query: RecallQuery,
  options: RecallForPromptOptions,
): RecallForPromptResult {
  const weights = options.weights ?? DEFAULT_RECALL_WEIGHTS;
  const mentionText = options.mentionText;
  const mentionLimit = options.mentionLimit ?? DEFAULT_MENTION_LIMIT;
  const sourceLimit = options.sourceLimit ?? DEFAULT_SOURCE_LIMIT;

  // 1) 常规：未被取代的条目（印象在内）
  const primary: RecalledForPrompt[] = limitFallbackItems(
    recallMemories(events, query, { weights, superseded: 'exclude' }),
    options.fallbackLimit,
  ).map((item) => ({ ...item, origin: 'recall' }));
  const taken = new Set(primary.map((item) => item.event.id));

  // 补充通路的分数上限：严格低于常规里最低的那条，预算紧张时先让位
  const floor = primary.reduce((lowest, item) => Math.min(lowest, item.score), Number.POSITIVE_INFINITY);
  const demote = (item: RecalledMemory, order: number): number =>
    (Number.isFinite(floor) ? Math.min(item.score, floor) : item.score) - 1 - order * 0.001;

  // 2) 提到：被取代的原文，只认玩家这句话里的关键词（或置顶）
  const mentionTerms = tokenizeQuery(mentionText);
  const mentioned: RecalledForPrompt[] = events
    .filter((event) => event.observerId === query.observerId && isSuperseded(event) && !taken.has(event.id))
    .map((event) => scoreMemory(event, { ...query, text: mentionText }, mentionTerms, weights))
    .filter((item) => item.reasons.some((reason) => reason.code === 'keyword' || reason.code === 'pinned'))
    .sort((a, b) => b.score - a.score || a.event.createdAt.localeCompare(b.event.createdAt))
    .slice(0, mentionLimit)
    .map((item, index) => ({ ...item, score: demote(item, index), origin: 'mention' }));
  for (const item of mentioned) taken.add(item.event.id);

  // 3) 问过去：召回到的印象顺着 supersedes 展开来源原文
  const sources: RecalledForPrompt[] = [];
  if (options.askingPast === true) {
    const byId = new Map(events.map((event) => [event.id, event]));
    for (const impression of primary) {
      for (const id of impression.event.supersedes ?? []) {
        if (sources.length >= sourceLimit) break;
        const source = byId.get(id);
        if (source === undefined || taken.has(source.id) || source.deletedAt !== null) continue;
        taken.add(source.id);
        sources.push({
          event: source,
          score: demote(impression, mentioned.length + sources.length),
          reasons: [{ code: 'rehearsal', label: '玩家在问过去，从印象翻出来源', delta: 0 }],
          origin: 'source',
        });
      }
      if (sources.length >= sourceLimit) break;
    }
  }

  /*
   * 预算：常规项优先，但给补充项留一块「实际装得下」的位置。
   * 先在预留上限里试装补充项，装进多少就留多少；常规项用剩下的；最后补充项再按真正剩余的
   * 空间装一次（常规项没用满时，余下的也归它们）。
   */
  const counter = options.counter ?? heuristicTokenCounter;
  const supplements = [...mentioned, ...sources];
  const share = Math.max(0, Math.min(1, options.supplementShare ?? DEFAULT_SUPPLEMENT_SHARE));
  const reserved = selectWithinBudget(supplements, Math.floor(options.budgetTokens * share), counter);
  const reserve = reserved.reduce((sum, item) => sum + memoryCost(item, counter), 0);
  const primarySelected = selectWithinBudget(primary, options.budgetTokens - reserve, counter);
  const used = primarySelected.reduce((sum, item) => sum + memoryCost(item, counter), 0);
  const supplementSelected = selectWithinBudget(supplements, options.budgetTokens - used, counter);

  return {
    selected: [...primarySelected, ...supplementSelected],
    candidates: { recall: primary.length, mention: mentioned.length, source: sources.length },
  };
}
