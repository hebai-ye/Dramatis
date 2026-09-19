import { limitFallbackItems, recallMemories, selectWithinBudget } from '../memory/recall.js';
import type { RecallReason } from '../memory/types.js';
import type { MemoryEvent } from '../model/message.js';
import { heuristicTokenCounter, type TokenCounter } from '../token/estimate.js';

/**
 * 混合召回的评测（ROADMAP P1-10 / P1-11 的前置证据）。
 *
 * 要回答的问题只有一个：**关键词召回够不够用**。
 *
 * 做法是「出题—对答案」：给定一批记忆与一批探针问题（每个问题写明该想起哪几条、
 * 不该想起哪几条），跑真实的 `recallMemories` + `selectWithinBudget`，看
 * 该想起来的排在第几、有没有被预算挤掉、有没有把别人的记忆混进来。
 *
 * 它是**纯函数 + 数据**，所以同一套题可以喂给不同的实现（关键词版、加了向量的版本），
 * 数字直接可比——这正是 P1-11「只有在评测证明关键词不够用时才做」需要的依据。
 */
export interface RecallProbe {
  id: string;
  /** 玩家这一轮说的话（就是查询文本）。 */
  text: string;
  /** 正在回忆的人（记忆按视角隔离，别人的条目不该出现）。 */
  observerId: string;
  /** 该想起来的条目；命中任意一条就算这一题答对。 */
  expectIds: readonly string[];
  /** 明确不该出现在召回结果里的条目（比如他不可能知道的事）。 */
  forbidIds?: readonly string[];
  /** 复现真实查询条件：在场的人与地点，缺省为空。 */
  participantIds?: readonly string[];
  location?: string;
  now?: string;
}

export interface RecallDataset {
  name: string;
  memories: readonly MemoryEvent[];
  probes: readonly RecallProbe[];
}

export interface ProbeResult {
  probe: RecallProbe;
  /** 期望条目在排序里的位置（1 起）；一条都没命中是 null。 */
  rank: number | null;
  /** 预算裁剪之后还在不在——**这才是模型真正看得到的**。 */
  inBudget: boolean;
  /** 命中那条的加权理由，用来解释「为什么是它」。 */
  hitReasons: readonly RecallReason[];
  /** 最终进入 prompt 的条目 id。 */
  selectedIds: readonly string[];
  /** 明确不该来的却来了。 */
  leaked: readonly string[];
  /** 进了预算、但既不是期望也不是禁项——噪音，占的是别人的位置。 */
  noise: readonly string[];
  tokens: number;
}

export interface RecallReport {
  dataset: string;
  probes: ProbeResult[];
  /** 期望条目出现在排序里的比例。 */
  hitRate: number;
  /** 期望条目通过预算裁剪、真的进了 prompt 的比例。 */
  inBudgetRate: number;
  /** 禁项混进 prompt 的比例（视角串味的底线）。 */
  leakRate: number;
  /** 每题平均带进去多少条噪音。 */
  noisePerProbe: number;
  /** 每题平均占多少 token。 */
  tokensPerProbe: number;
}

export interface EvaluateRecallOptions {
  /** 每个角色每轮最多带入多少 token 的记忆（与线上一致）。 */
  budgetTokens?: number;
  counter?: TokenCounter;
  /** 收集理由时是否只算期望命中的那条。 */
  weights?: Parameters<typeof recallMemories>[2];
  /**
   * 兜底条目的上限：null 表示不限。
   *
   * 缺省与线上一致（有命中时最多两条无关条目），这样评测数字就是用户实际看到的东西。
   * 想对比「不限」时的表现，传 `null`。
   */
  fallbackLimit?: number | null;
}

export function evaluateRecall(dataset: RecallDataset, options: EvaluateRecallOptions = {}): RecallReport {
  const budgetTokens = options.budgetTokens ?? 800;
  const counter = options.counter ?? heuristicTokenCounter;
  const now = '2026-09-20T00:00:00.000Z';

  const results: ProbeResult[] = dataset.probes.map((probe) => {
    const ranked = recallMemories(
      dataset.memories,
      {
        observerId: probe.observerId,
        text: probe.text,
        participantIds: probe.participantIds ?? [],
        location: probe.location ?? '',
        now: probe.now ?? now,
      },
      options.weights ?? {},
    );

    const candidates =
      options.fallbackLimit === null ? ranked : limitFallbackItems(ranked, options.fallbackLimit ?? undefined);
    const selected = selectWithinBudget(candidates, budgetTokens, counter);
    const expected = new Set(probe.expectIds);
    const forbidden = new Set(probe.forbidIds ?? []);

    const hit = ranked.find((item) => expected.has(item.event.id)) ?? null;
    const selectedIds = selected.map((item) => item.event.id);

    return {
      probe,
      rank: hit === null ? null : ranked.indexOf(hit) + 1,
      inBudget: hit !== null && selectedIds.includes(hit.event.id),
      hitReasons: hit?.reasons ?? [],
      selectedIds,
      leaked: selectedIds.filter((id) => forbidden.has(id)),
      noise: selectedIds.filter((id) => !expected.has(id) && !forbidden.has(id)),
      tokens: selected.reduce(
        (total, item) => total + counter.count(item.event.summary) + counter.count(item.event.perception),
        0,
      ),
    };
  });

  // 负向探针（expectIds 为空）只用来测「有没有串味」，不算命中率的分母
  const positive = results.filter((result) => result.probe.expectIds.length > 0);
  const count = positive.length === 0 ? 1 : positive.length;
  return {
    dataset: dataset.name,
    probes: results,
    hitRate: positive.filter((result) => result.rank !== null).length / count,
    inBudgetRate: positive.filter((result) => result.inBudget).length / count,
    leakRate: results.filter((result) => result.leaked.length > 0).length / count,
    noisePerProbe: results.reduce((total, result) => total + result.noise.length, 0) / count,
    tokensPerProbe: results.reduce((total, result) => total + result.tokens, 0) / count,
  };
}

/** 给人看的一行结论（CLI 与文档都用它，免得两边手抄数字）。 */
export function formatRecallReport(report: RecallReport): string {
  const lines = [
    `# ${report.dataset}`,
    `命中 ${(report.hitRate * 100).toFixed(0)}% · 进预算 ${(report.inBudgetRate * 100).toFixed(0)}% · 串味 ${(report.leakRate * 100).toFixed(0)}% · 平均噪音 ${report.noisePerProbe.toFixed(1)} 条 · 平均 ${report.tokensPerProbe.toFixed(0)} token`,
    '',
    '| 探针 | 排名 | 进预算 | 噪音 | token |',
    '| --- | --- | --- | --- | --- |',
  ];

  for (const result of report.probes) {
    lines.push(
      `| ${result.probe.text.slice(0, 18)} | ${result.rank === null ? '未命中' : `#${String(result.rank)}`} | ${
        result.inBudget ? '✅' : '❌'
      } | ${String(result.noise.length)} | ${String(result.tokens)} |`,
    );
  }

  return lines.join('\n');
}
