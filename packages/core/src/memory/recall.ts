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
