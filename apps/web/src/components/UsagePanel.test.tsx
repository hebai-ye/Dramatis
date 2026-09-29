import type { BudgetState, UsageSummary, UsageTotals } from '@dramatis/core';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UsagePanel } from './UsagePanel';

const totals: UsageTotals = {
  calls: 3,
  promptTokens: 120,
  completionTokens: 40,
  tokens: 160,
  cost: null,
  pricedCalls: 0,
  currency: null,
  costs: [],
  calibration: { calls: 0, estimated: 0, actual: 0 },
};
const summary: UsageSummary = {
  total: totals,
  byCategory: [
    { key: 'intent', label: '导演', totals: { ...totals, calls: 1 } },
    { key: 'generation', label: '生成', totals: { ...totals, calls: 2 } },
  ],
  bySpeaker: [],
  byModel: [],
  firstAt: null,
  lastAt: null,
};

describe('最近一轮用量', () => {
  it('把导演一次和两位角色生成分别显示，不把未设单价当作免费', () => {
    const html = renderToString(
      createElement(UsagePanel, {
        world: summary,
        conversation: summary,
        latestTurn: summary,
        conversationTitle: '酒馆',
        budget: { extraCalls: 1, cost: null, remainingCalls: null, burned: false, reason: null } as BudgetState,
        limits: null,
        onSaveBudget: () => {},
      }),
    );
    expect(html).toContain('最近一轮');
    expect(html).toContain('导演判断');
    expect(html).toContain('角色生成');
    expect(html.replaceAll('<!-- -->', '')).toContain('2 次');
    expect(html).toContain('汇总可能低估');
    expect(html).not.toContain('¥0');
  });
});
