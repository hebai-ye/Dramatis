import { describe, expect, it } from 'vitest';
import { evaluateRecall, formatRecallReport } from './recall-eval.js';
import { RECALL_SCENARIO } from './recall-scenario.js';

describe('混合召回评测（P1-11 的决策依据）', () => {
  const report = evaluateRecall(RECALL_SCENARIO);

  it('该想起来的都能想起来，而且排在前面', () => {
    for (const result of report.probes) {
      if (result.probe.expectIds.length === 0) continue;
      expect(result.rank, `探针「${result.probe.text}」没命中`).not.toBeNull();
      // 排在第一名是目标；排到第三名之后说明排序已经不可信了
      expect(result.rank ?? 99, `探针「${result.probe.text}」排到了 #${String(result.rank)}`).toBeLessThanOrEqual(3);
    }
    expect(report.hitRate).toBe(1);
  });

  it('命中之后能通过 800 token 预算，真的进得了 prompt', () => {
    expect(report.inBudgetRate).toBe(1);
    expect(report.tokensPerProbe).toBeLessThanOrEqual(800);
  });

  it('视角隔离成立：不该知道的事一条都不会冒出来', () => {
    expect(report.leakRate).toBe(0);
  });

  it('噪音有上限：不能把预算塞满无关条目', () => {
    // 现在是关键词 + 重要度 + 时效的混合排序，没有向量；噪音就是它的代价。
    // 这个上限是「再差也不能差到这样」的红线，不是目标值。
    expect(report.noisePerProbe).toBeLessThanOrEqual(6);
  });

  it('兜底上限确实把预算让给了命中的条目（T22）', () => {
    const unlimited = evaluateRecall(RECALL_SCENARIO, { fallbackLimit: null });
    // 默认（与线上一致）不该带来回归：命中率与进预算都不掉
    expect(report.hitRate).toBeGreaterThanOrEqual(unlimited.hitRate);
    expect(report.inBudgetRate).toBeGreaterThanOrEqual(unlimited.inBudgetRate);
    // 而无关条目变少（省下来的额度给了命中的那些）
    expect(report.noisePerProbe).toBeLessThan(unlimited.noisePerProbe);
  });

  it('报告能被打印出来（CLI 与文档共用同一份数字）', () => {
    const text = formatRecallReport(report);
    // 与 prompt-samples 一样，这个测试的用途之一就是把表打出来给人看
    console.log(`\n${text}\n`);
    expect(text).toContain('命中 100%');
    expect(text).toContain('旧城长跑线索');
  });
});
