import type { ConversationId, RoomId, UsageSummary, UsageTotals } from '@dramatis/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DramatisDb } from './db';

export interface UsageApi {
  /** 整个世界的账（这个世界的所有对话、所有调用）。 */
  world: UsageSummary | null;
  /** 当前这条对话的账。 */
  conversation: UsageSummary | null;
  reload: () => Promise<void>;
}

/**
 * 用量账单（P3-7 / T7）。
 *
 * 数字全部来自落盘的流水，而不是某次渲染里的内存计数——长跑中途重载页面、
 * 换一台设备打开同一个库，看到的都是同一份账。刷新时机由调用方决定：
 * 生成完成、意图调用完成、后台任务写完之后各调一次 `reload()`。
 */
export function useUsage(
  db: DramatisDb | null,
  scope: { roomId: RoomId | null; conversationId: ConversationId | null },
): UsageApi {
  const [world, setWorld] = useState<UsageSummary | null>(null);
  const [conversation, setConversation] = useState<UsageSummary | null>(null);
  const { roomId, conversationId } = scope;

  const reload = useCallback(async () => {
    if (!db) return;
    if (roomId === null) {
      setWorld(null);
      setConversation(null);
      return;
    }

    setWorld(await db.ledger.summary({ roomId }));
    setConversation(conversationId === null ? null : await db.ledger.summary({ roomId, conversationId }));
  }, [conversationId, db, roomId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 返回对象要稳定（顺序 59）：它是 App 里一串 useCallback 的依赖，每次渲染新造一个就等于没 memo
  return useMemo(() => ({ world, conversation, reload }), [world, conversation, reload]);
}

/** 生成之外的所有调用（意图、后台分析、副对话的旧任务）。 */
export function extraCalls(summary: UsageSummary | null): number {
  if (summary === null) return 0;
  const generation = summary.byCategory.find((group) => group.key === 'generation');
  return summary.total.calls - (generation?.totals.calls ?? 0);
}

export function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 100_000) return `${(value / 1000).toFixed(1)}k`;
  return `${Math.round(value / 1000)}k`;
}

/**
 * 花费。
 *
 * 没有一条记录配过单价时是 null——界面上要写「未设单价」，而不是显示 0：
 * 0 会被读成「不要钱」。只覆盖了一部分调用时会带上分数（例如 3/5 次），
 * 让人知道这个数是不完整的。
 *
 * **混用多种币种时不加在一起**（审计 B9）：`cost` 只是最主要的那一种，
 * 其余写成「另计」。相加会得出一个谁都不认识的数（¥10 + $10 = 20），
 * 而换算汇率要联网取——为一份账单不值得。
 */
export function formatCost(totals: UsageTotals): string | null {
  if (totals.cost === null) return null;
  const partial =
    totals.pricedCalls < totals.calls ? `（${String(totals.pricedCalls)}/${String(totals.calls)} 次有单价）` : '';
  const others = totals.costs.slice(1).map((item) => formatMoney(item.cost, item.currency));
  const also = others.length === 0 ? '' : `，另计 ${others.join(' + ')}`;
  return `${formatMoney(totals.cost, totals.currency)}${also}${partial}`;
}

/** 单独一个金额的写法（账单合计、预算里的「已用多少」）。 */
export function formatMoney(amount: number, currency: string | null): string {
  const symbol = currency ?? '';
  const value = amount < 0.01 ? amount.toFixed(4) : amount.toFixed(2);
  return `${symbol}${value}`;
}

export const CATEGORY_LABELS: Record<string, string> = {
  generation: '角色生成',
  intent: '意图判断',
  analysis: '一轮分析（记忆 + 状态）',
  summary: '前情摘要',
  admin: '世界管理员',
  memory: '记忆抽取（旧版）',
  affect: '状态推演（旧版）',
};
