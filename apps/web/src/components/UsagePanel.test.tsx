import {
  type BudgetLimits,
  type BudgetState,
  evaluateBudget,
  type UsageSummary,
  type UsageTotals,
} from '@dramatis/core';
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

function renderUsage(
  overrides: {
    world?: UsageSummary | null;
    limits?: BudgetLimits | null;
    usageError?: string | null;
    onRetryUsage?: () => Promise<void>;
  } = {},
): string {
  const world = overrides.world === undefined ? summary : overrides.world;
  const limits = overrides.limits ?? null;
  return renderToString(
    createElement(UsagePanel, {
      worldId: 'usage-ui-world',
      world,
      conversation: world,
      latestTurn: null,
      conversationTitle: '酒馆',
      budget: evaluateBudget(world, limits),
      limits,
      onSaveBudget: () => {},
      ...overrides,
    }),
  ).replaceAll('<!-- -->', '');
}

describe('账单读取反馈', () => {
  it('先说明本世界范围和未知费用，再展示预算编辑与账单分项', () => {
    const html = renderUsage();
    expect(html).toContain('统计范围：本世界的全部对话与模型调用');
    expect(html).toContain('未知费用调用');
    expect(html.indexOf('未知费用调用')).toBeLessThan(html.indexOf('本局上限'));
    expect(html.indexOf('本局上限')).toBeLessThan(html.indexOf('按用途'));
  });
  it('首次读取失败说明无法读取并提供重试，不冒充没有账单', () => {
    const html = renderUsage({ world: null, usageError: '账本暂不可读', onRetryUsage: async () => {} });
    expect(html).toContain('role="alert"');
    expect(html).toContain('账本暂不可读');
    expect(html).toContain('重试读取账单');
    expect(html).not.toContain('还没有账单');
  });

  it('刷新失败保留原数字，同时说明显示的是上次成功读取的数据', () => {
    const html = renderUsage({ usageError: '刷新失败' });
    expect(html).toContain('3 次调用');
    expect(html).toContain('上次成功读取');
    expect(html).toContain('刷新失败');
    expect(html).not.toContain('重试读取账单');
  });

  it('正常空账仍显示空状态，正常账单不标为旧数据', () => {
    expect(renderUsage({ world: null })).toContain('还没有账单');
    expect(renderUsage()).not.toContain('上次成功读取');
  });
});

describe('逐币种预算明细', () => {
  it('用逐项定义列表展示未知费用和剩余，不编造全额可用', () => {
    const html = renderUsage({ limits: { maxCostByCurrency: { EUR: 10 } } });
    expect(html).toContain('<dt>已知花费</dt>');
    expect(html).toContain('<dt>上限</dt>');
    expect(html).toContain('<dt>剩余</dt>');
    expect(html).toContain('未知（不能据此当作全额可用）');
    expect(html).toContain('<dt>触发原因</dt>');
  });

  it('币种原标签带边界引号，尾空格和连续空格可区分', () => {
    const html = renderUsage({ limits: { maxCostByCurrency: { CNY: 1, 'CNY ': 2, 'US  $': 3 } } });
    expect(html).toContain('&quot;CNY&quot;');
    expect(html).toContain('&quot;CNY &quot;');
    expect(html).toContain('&quot;US  $&quot;');
  });
});
