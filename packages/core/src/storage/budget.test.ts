import { describe, expect, it } from 'vitest';
import { evaluateBudget, extraCallsOf } from './budget.js';
import type { UsageRecord } from './usage.js';
import { summarizeUsage } from './usage.js';

const PRICE = { inputPerMillion: 10, outputPerMillion: 10, currency: '¥' };

function summaryOf(records: Array<Partial<UsageRecord>>) {
  return summarizeUsage(
    records.map((record, index) => ({
      id: `u${String(index)}`,
      roomId: null,
      conversationId: null,
      turnId: null,
      category: 'analysis',
      model: 'm',
      promptTokens: 0,
      completionTokens: 0,
      speakerInstanceId: null,
      speakerName: '',
      price: null,
      createdAt: '2026-09-19T00:00:00.000Z',
      // 账单的 updatedAt 恒等于 createdAt（顺序 68）；这里只是构造汇总入参，跟着补上。
      updatedAt: '2026-09-19T00:00:00.000Z',
      ...record,
    })),
  );
}

describe('调用预算', () => {
  it('没设上限就不熔断', () => {
    const summary = summaryOf([{ category: 'generation' }, { category: 'intent' }]);
    const state = evaluateBudget(summary, null);
    expect(state.burned).toBe(false);
    expect(state.extraCalls).toBe(1);
    expect(state.remainingCalls).toBeNull();
  });

  it('只算生成之外的调用：角色回复不吃预算', () => {
    const summary = summaryOf([
      { category: 'generation' },
      { category: 'generation' },
      { category: 'generation' },
      { category: 'intent' },
      { category: 'analysis' },
    ]);
    expect(extraCallsOf(summary)).toBe(2);
    expect(evaluateBudget(summary, { maxExtraCalls: 3 }).burned).toBe(false);
    expect(evaluateBudget(summary, { maxExtraCalls: 2 }).burned).toBe(true);
  });

  it('到点即熔断，并说明是哪一条撞的', () => {
    const summary = summaryOf([{ category: 'intent' }, { category: 'intent' }]);
    const state = evaluateBudget(summary, { maxExtraCalls: 2 });
    expect(state.burned).toBe(true);
    expect(state.reason).toContain('2 次');
    expect(state.remainingCalls).toBe(0);
  });

  it('金额上限：没配单价时它不参与判定（不编钱）', () => {
    const noPrice = summaryOf([{ category: 'intent', promptTokens: 1_000_000 }]);
    const state = evaluateBudget(noPrice, { maxCost: 0.01 });
    expect(state.cost).toBeNull();
    expect(state.burned).toBe(false);
    expect(state.remainingCost).toBeNull();

    const priced = summaryOf([{ category: 'intent', promptTokens: 1_000_000, price: PRICE }]);
    const burned = evaluateBudget(priced, { maxCost: 5 });
    expect(burned.cost).toBeCloseTo(10, 6);
    expect(burned.burned).toBe(true);
    expect(burned.reason).toContain('花费');
    expect(burned.remainingCost).toBe(0);
  });

  it('两条都撞上时说清楚两条都到了', () => {
    const summary = summaryOf([{ category: 'analysis', promptTokens: 1_000_000, price: PRICE }]);
    const state = evaluateBudget(summary, { maxExtraCalls: 1, maxCost: 1 });
    expect(state.burned).toBe(true);
    expect(state.reason).toContain('额外调用');
    expect(state.reason).toContain('花费');
  });

  it('0 或负数当作「没设」：填错了不该把功能全关掉', () => {
    const summary = summaryOf([{ category: 'intent' }]);
    expect(evaluateBudget(summary, { maxExtraCalls: 0 }).burned).toBe(false);
    expect(evaluateBudget(summary, { maxCost: -1 }).burned).toBe(false);
  });

  it('还没开聊（没有账单）时不熔断', () => {
    expect(evaluateBudget(null, { maxExtraCalls: 1 }).burned).toBe(false);
  });
});
