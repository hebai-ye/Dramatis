import type { UsageBudgetSummary, UsageSummary } from './usage.js';

/**
 * 调用预算与熔断（ROADMAP P1-9）。
 *
 * 定位：这是一道**保险**，不是省钱开关。BYOK 用户最怕的不是花得多，而是
 * 「我以为只在聊天，结果后台一直在偷偷花钱」。所以上限管的是**生成之外的调用**
 * ——意图判断、一轮分析、分层摘要——角色回复本身永远不被拦下：聊到一半突然说不出话，
 * 比多花几分钱糟糕得多。
 *
 * 两个上限都可以留空表示不限。次数上限不依赖单价，谁都能用；金额上限需要先在
 * 模型接入里填单价（没填就不参与判定，界面上会说明）。
 */
export interface BudgetLimits {
  /** 生成之外最多还能调用几次。null / undefined 表示不限。 */
  maxExtraCalls?: number | null;
  /** 本局最多花多少钱（用配置里的币种）。null / undefined 表示不限。 */
  maxCost?: number | null;
  /** Explicit map; present (including null/empty) overrides maxCost. No automatic currency migration. */
  maxCostByCurrency?: Record<string, number | null> | null;
}

export interface CurrencyBudgetState {
  currency: string;
  /** Known priced amount only; null if there are no priced records in this currency. */
  cost: number | null;
  limit: number | null;
  remaining: number | null;
  exceeded: boolean;
}

export interface BudgetState {
  /** 生成之外的调用次数（意图 + 后台分析 + 摘要）。 */
  extraCalls: number;
  /** 已经花掉的钱；没有单价时是 null。 */
  cost: number | null;
  /** true 表示该熔断了：不再发后台调用。 */
  burned: boolean;
  /** 熔断原因，给用户看的一句话；没熔断时是 null。 */
  reason: string | null;
  /** 还剩几次额外调用；不限时是 null。已经超了按 0 记。 */
  remainingCalls: number | null;
  /** 还剩多少钱；不限或没单价时是 null。已经超了按 0 记。 */
  remainingCost: number | null;
  /** Additive diagnostics; optional for consumers constructing legacy BudgetState objects. */
  costPolicy?: 'legacy-primary' | 'per-currency';
  currencyBudgets?: CurrencyBudgetState[];
  unpricedCalls?: number;
  needsCurrencySelection?: boolean;
}

function numberOrNull(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

export function evaluateBudget(
  summary: UsageSummary | UsageBudgetSummary | null,
  limits: BudgetLimits | null,
): BudgetState {
  const extraCalls = summary === null ? 0 : extraCallsOf(summary);
  const cost = summary?.total.cost ?? null;

  const maxCalls = numberOrNull(limits?.maxExtraCalls);
  const maxCost = numberOrNull(limits?.maxCost);

  const perCurrency = limits?.maxCostByCurrency !== undefined;
  const configured: Record<string, number | null> = perCurrency ? (limits?.maxCostByCurrency ?? {}) : {};
  const costs = summary?.total.costs ?? [];
  const currencies = new Set([...costs.map((entry) => entry.currency), ...Object.keys(configured)]);
  const currencyBudgets: CurrencyBudgetState[] = [...currencies].sort().map((currency) => {
    const amount = costs.find((entry) => entry.currency === currency)?.cost ?? null;
    const limit = numberOrNull(Object.hasOwn(configured, currency) ? configured[currency] : undefined);
    return {
      currency,
      cost: amount,
      limit,
      remaining: limit === null || amount === null ? null : Math.max(0, limit - amount),
      exceeded: limit !== null && amount !== null && amount >= limit,
    };
  });
  const callsExceeded = maxCalls !== null && extraCalls >= maxCalls;
  const exceededCurrencies = currencyBudgets.filter((entry) => entry.exceeded);
  const costExceeded = perCurrency
    ? exceededCurrencies.length > 0
    : maxCost !== null && cost !== null && cost >= maxCost;

  let reason: string | null = null;
  if (perCurrency && costExceeded) {
    const moneyReason = exceededCurrencies
      .map((entry) => `${entry.currency}花费已到${String(entry.limit)}上限`)
      .join('；');
    reason = callsExceeded ? `额外调用已到${String(maxCalls)}次；${moneyReason}` : moneyReason;
  } else if (callsExceeded && costExceeded) reason = `额外调用已到 ${String(maxCalls)} 次，花费也到了上限`;
  else if (callsExceeded) reason = `额外调用已到 ${String(maxCalls)} 次`;
  else if (costExceeded) reason = '本局花费已到上限';

  return {
    extraCalls,
    cost,
    burned: reason !== null,
    reason,
    remainingCalls: maxCalls === null ? null : Math.max(0, maxCalls - extraCalls),
    remainingCost: perCurrency || maxCost === null || cost === null ? null : Math.max(0, maxCost - cost),
    costPolicy: perCurrency ? 'per-currency' : 'legacy-primary',
    currencyBudgets,
    unpricedCalls: summary === null ? 0 : Math.max(0, summary.total.calls - summary.total.pricedCalls),
    needsCurrencySelection: !perCurrency && maxCost !== null,
  };
}

/** 生成之外的调用次数：总次数减去角色生成那部分。 */
export function extraCallsOf(summary: UsageSummary | UsageBudgetSummary): number {
  if ('extraCalls' in summary) return summary.extraCalls;
  const generation = summary.byCategory.find((group) => group.key === 'generation');
  return summary.total.calls - (generation?.totals.calls ?? 0);
}
