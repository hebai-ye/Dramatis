import { describe, expect, it } from 'vitest';
import { evaluateBudget } from './budget.js';
import { summarizeUsage, summarizeUsageForBudget, type UsageRecord } from './usage.js';

function row(currency: string | null, amount: number, id: string, tokens = 1000000): UsageRecord {
  return {
    id,
    roomId: null,
    conversationId: null,
    turnId: null,
    category: 'generation',
    model: 'fixture-model',
    promptTokens: tokens,
    completionTokens: 0,
    speakerInstanceId: null,
    speakerName: '',
    price: currency === null ? null : { currency, inputPerMillion: amount, outputPerMillion: amount },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}
const mixed = () => [
  row('CNY', 60, 'a'),
  row('CNY', 60, 'b'),
  row('USD', 1, 'c'),
  row('USD', 1, 'd'),
  row('USD', 1, 'e'),
];
describe('顺序118：显式逐币种预算（不自动迁移旧标量）', () => {
  it('即使USD是展示主币种，CNY超过自己的上限也必须熔断', () => {
    const summary = summarizeUsage(mixed());
    expect(summary.total.currency).toBe('USD');
    const state = evaluateBudget(summary, { maxCostByCurrency: { CNY: 100, USD: 100 } });
    expect(state.burned).toBe(true);
    expect(state.reason).toContain('CNY');
    expect(state.costPolicy).toBe('per-currency');
    expect(state.currencyBudgets?.find((entry) => entry.currency === 'CNY')).toMatchObject({
      cost: 120,
      limit: 100,
      remaining: 0,
      exceeded: true,
    });
    expect(state.remainingCost).toBeNull();
    expect(state.needsCurrencySelection).toBe(false);
  });
  it('追加零token计费调用改变主币种，也不能解除另一币种的超限', () => {
    const rows = mixed();
    const limits = { maxCostByCurrency: { CNY: 100, USD: 100 } };
    for (const [currency, id] of [
      ['CNY', 'zero-cny'],
      ['USD', 'zero-usd'],
      ['USD', 'zero-usd-2'],
    ]) {
      rows.push(row(currency ?? '', 1, id ?? '', 0));
      expect(evaluateBudget(summarizeUsage(rows), limits).burned).toBe(true);
    }
  });
  it('各币种使用各自阈值，不将不同币种相加', () => {
    const summary = summarizeUsage([row('CNY', 80, 'a'), row('USD', 80, 'b')]);
    expect(evaluateBudget(summary, { maxCostByCurrency: { CNY: 100, USD: 100 } }).burned).toBe(false);
    const state = evaluateBudget(summary, { maxCostByCurrency: { CNY: 100, USD: 50 } });
    expect(state.burned).toBe(true);
    expect(state.reason).toContain('USD');
    expect(state.reason).not.toContain('CNY');
  });
  it('到点即触发，多个币种和次数同时越界时原因均可定位', () => {
    const records = mixed().map((r) => ({ ...r, category: 'analysis' as const }));
    const state = evaluateBudget(summarizeUsage(records), {
      maxExtraCalls: 5,
      maxCostByCurrency: { CNY: 120, USD: 3 },
    });
    expect(state.reason).toContain('CNY');
    expect(state.reason).toContain('USD');
    expect(state.reason).toContain('额外调用');
    expect(state.currencyBudgets?.every((entry) => entry.exceeded)).toBe(true);
  });
  it('未配置上限的币种保持未设限，不仅因混币而暂停', () => {
    const state = evaluateBudget(summarizeUsage([row('CNY', 1, 'a'), row('USD', 10000, 'b')]), {
      maxCostByCurrency: { CNY: 10 },
    });
    expect(state.burned).toBe(false);
    expect(state.currencyBudgets?.find((entry) => entry.currency === 'USD')).toMatchObject({
      limit: null,
      remaining: null,
      exceeded: false,
    });
  });
  it.each([{}, null])('显式空映射%s清空金额限制，不回退套用旧maxCost', (maxCostByCurrency) => {
    const state = evaluateBudget(summarizeUsage(mixed()), { maxCost: 1, maxCostByCurrency });
    expect(state.burned).toBe(false);
    expect(state.costPolicy).toBe('per-currency');
  });
  it('没有映射时保留旧接口并标注需要明确绑定，不猜旧上限的币种', () => {
    const state = evaluateBudget(summarizeUsage(mixed()), { maxCost: 100 });
    expect(state.costPolicy).toBe('legacy-primary');
    expect(state.needsCurrencySelection).toBe(true);
    expect(state.currencyBudgets?.every((entry) => entry.limit === null)).toBe(true);
    expect(state.cost).toBe(3); // 旧兼容模式仍不能算作已修复，迁移必须由用户确认。
  });
  it('未知价格仍为未知，额外调用护栏独立工作', () => {
    const records = [row(null, 0, 'a'), row(null, 0, 'b')].map((r) => ({ ...r, category: 'analysis' as const }));
    const state = evaluateBudget(summarizeUsage(records), { maxExtraCalls: 2, maxCostByCurrency: { CNY: 1 } });
    expect(state.burned).toBe(true);
    expect(state.unpricedCalls).toBe(2);
    expect(state.currencyBudgets).toEqual([
      { currency: 'CNY', cost: null, limit: 1, remaining: null, exceeded: false },
    ]);
  });
  it('有价零token保留调用数但不制造费用，缺失usage不据此推断免费', () => {
    const state = evaluateBudget(summarizeUsage([row('CNY', 10, 'zero', 0)]), { maxCostByCurrency: { CNY: 1 } });
    expect(state.burned).toBe(false);
    expect(state.unpricedCalls).toBe(0);
    expect(state.currencyBudgets?.[0]?.cost).toBe(0);
  });
  it('完整和预算专用投影在新策略下也完全一致，且不改历史汇总', () => {
    const rows = mixed(),
      full = summarizeUsage(rows),
      before = structuredClone(full);
    const limits = { maxCostByCurrency: { CNY: 100, USD: 10 } };
    expect(evaluateBudget(summarizeUsageForBudget(rows), limits)).toEqual(evaluateBudget(full, limits));
    expect(full).toEqual(before);
  });
  it('币种按原标签精确匹配，不把符号和代码当作同币种或自动换汇', () => {
    const state = evaluateBudget(summarizeUsage([row('¥', 200, 'a')]), { maxCostByCurrency: { CNY: 100 } });
    expect(state.burned).toBe(false);
    expect(state.currencyBudgets?.find((entry) => entry.currency === '¥')?.limit).toBeNull();
  });
  it('只采用映射自己的键，不误用原型上的同名值', () => {
    const limits = Object.create({ USD: 1 }) as Record<string, number>;
    const state = evaluateBudget(summarizeUsage([row('USD', 100, 'a')]), { maxCostByCurrency: limits });
    expect(state.burned).toBe(false);
    expect(state.currencyBudgets?.[0]?.limit).toBeNull();
  });
});
