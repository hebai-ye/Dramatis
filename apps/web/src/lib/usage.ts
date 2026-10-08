import {
  type ConversationId,
  createUsageScopeOwner,
  createUsageScopeReader,
  type RoomId,
  type UsageScopeOwner,
  type UsageScopeSummary,
  type UsageSummary,
  type UsageTotals,
  usageCalibration,
} from '@dramatis/core';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DramatisDb } from './db';

export interface UsageApi {
  /** 整个世界的账（这个世界的所有对话、所有调用）。 */
  world: UsageSummary | null;
  /** 当前这条对话的账。 */
  conversation: UsageSummary | null;
  /** 最近一轮，按 turnId 从现有流水汇总。 */
  latestTurn: UsageSummary | null;
  reload: () => Promise<void>;
  /** Latest active-scope read failure; stale failures are discarded. */
  error?: string | null;
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
  scope: { roomId: RoomId | null; conversationId: ConversationId | null; turnId?: string | null },
): UsageApi {
  const readerRef = useRef<ReturnType<typeof createUsageScopeReader> | null>(null);
  if (readerRef.current === null) readerRef.current = createUsageScopeReader();
  const reader = readerRef.current;
  const ledger = db?.ledger ?? null;
  const { roomId, conversationId } = scope;
  const turnId = scope.turnId ?? null;
  const owner = useMemo(
    () => createUsageScopeOwner(ledger, { roomId, conversationId, turnId }),
    [ledger, roomId, conversationId, turnId],
  );
  // Activate only committed ownership; a discarded concurrent render must not cancel the visible scope.
  useLayoutEffect(() => {
    reader.activate(owner);
    return () => reader.deactivate(owner);
  }, [reader, owner]);
  const [snapshot, setSnapshot] = useState<{
    owner: UsageScopeOwner;
    value: UsageScopeSummary;
    error: string | null;
  } | null>(null);
  const reload = useCallback(async () => {
    const result = await reader.read(owner);
    if (result === null || !reader.isLatest(result)) return;
    if (result.error !== null) {
      const failure = result.error;
      setSnapshot((previous) => ({
        owner,
        value: previous?.owner === owner ? previous.value : { world: null, conversation: null, latestTurn: null },
        error: failure.message,
      }));
      throw failure;
    }
    setSnapshot({ owner, value: result.value, error: null });
  }, [reader, owner]);
  useEffect(() => {
    // Automatic reads must not create unhandled rejections; explicit reload callers still receive the failure.
    void reload().catch(() => undefined);
  }, [reload]);
  const visible = snapshot?.owner === owner ? snapshot : null;
  return useMemo(
    () => ({
      world: visible?.value.world ?? null,
      conversation: visible?.value.conversation ?? null,
      latestTurn: visible?.value.latestTurn ?? null,
      error: visible?.error ?? null,
      reload,
    }),
    [visible, reload],
  );
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

/**
 * 配对样本少于这个条数就不下结论（顺序 71）。
 *
 * 三两条调用算出来的比例会被「这一轮提示词特别长」这种偶然因素主导，
 * 写出来只会让人以为口径已经测准了。攒够十轮再说。
 */
export const CALIBRATION_MIN_SAMPLES = 10;

/**
 * 本地估算 vs 服务端真实 prompt token 的一句话（顺序 71）。
 *
 * 为什么要把这个数摆给用户看：估算口径决定预算守卫留多少余量，而它**从没跟真实
 * 分词器对齐过**（离线装不了 tokenizer）。真机上跑起来之后，这份账单就是唯一的实测
 * 数据来源——用户看到偏差可以直接反馈，我们按实测把除数调准，而不是凭感觉改公式。
 *
 * 返回 null 表示还不够格下结论（样本太少或没有配对），界面上不显示这一行。
 */
export function formatCalibrationNote(totals: UsageTotals): string | null {
  const report = usageCalibration(totals);
  const paired = totals.calibration.calls;
  if (report.ratio === null || paired < CALIBRATION_MIN_SAMPLES) return null;

  const percent = Math.round((report.ratio - 1) * 100);
  if (Math.abs(percent) < 5) {
    return `口径核对：本地估算与服务端真实 prompt token 基本一致（相差不到 5%，${String(paired)} 次调用）。`;
  }
  const direction = percent > 0 ? '少' : '多';
  return `口径核对：本地估算比服务端真实 prompt token ${direction} ${String(Math.abs(percent))}%（${String(paired)} 次调用参与）。预算守卫按估算留余量，偏差大时它算出来的可用量会偏。`;
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
