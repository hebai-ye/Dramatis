import type { BudgetLimits, BudgetState, CurrencyBudgetState } from './budget.js';

export interface BudgetCurrencyDraft {
  /** Stable within the draft, including while the currency label is being edited. */
  id: number;
  currency: string;
  amount: string;
}

export interface BudgetEditorDraft {
  calls: string;
  legacyCost: string;
  mode: 'legacy' | 'per-currency';
  currencies: BudgetCurrencyDraft[];
  /** Selection alone never migrates the old scalar. */
  migrationCurrency: string;
}

export type BudgetDraftResult = { ok: true; limits: BudgetLimits | null } | { ok: false; errors: string[] };

/** Compatibility-only legacy saves may proceed; explicit currency writes require caller identity. */
export function budgetDraftSaveBlockReason(draft: BudgetEditorDraft, worldId?: string | null): string | null {
  if (draft.mode === 'legacy' || (typeof worldId === 'string' && worldId.trim() !== '')) return null;
  return '尚未接通明确世界标识：逐币种配置、迁移和清空只能暂存草稿，暂不能提交；请等待上游接通。';
}

/** Display labels are not ISO codes. Preserve punctuation and spaces: CNY and 'CNY ' are distinct. */
export function budgetCurrencyError(currency: string): string | null {
  if (
    currency.trim().length === 0 ||
    currency.length > 64 ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(currency) ||
    ['__proto__', 'prototype', 'constructor'].includes(currency)
  ) {
    return '币种标签须非空白且不超过 64 个字符，不能含控制字符、换行或危险保留键名；允许可打印空格和标点，原值不会自动 trim 或更名。';
  }
  return null;
}

export function createBudgetDraft(limits: BudgetLimits | null | undefined): BudgetEditorDraft {
  return {
    calls: limits?.maxExtraCalls == null ? '' : String(limits.maxExtraCalls),
    legacyCost: limits?.maxCost == null ? '' : String(limits.maxCost),
    mode: limits?.maxCostByCurrency === undefined ? 'legacy' : 'per-currency',
    currencies: Object.entries(limits?.maxCostByCurrency ?? {}).map(([currency, amount], id) => ({
      id,
      currency,
      amount: amount == null ? '' : String(amount),
    })),
    migrationCurrency: '',
  };
}

/** Absence means legacy; null and {} both explicitly disable the scalar policy. */
export function budgetLimitsSignature(limits: BudgetLimits | null | undefined): string {
  const mapping = limits?.maxCostByCurrency;
  return JSON.stringify([
    limits?.maxExtraCalls == null ? null : String(limits.maxExtraCalls),
    limits?.maxCost == null ? null : String(limits.maxCost),
    mapping === undefined ? 'legacy' : 'per-currency',
    Object.keys(mapping ?? {})
      .sort()
      .map((currency) => [currency, mapping?.[currency] == null ? null : String(mapping[currency])]),
  ]);
}

/** Includes invalid text and the unconfirmed selection, not just parsed limits. */
export function budgetDraftSignature(draft: BudgetEditorDraft): string {
  return JSON.stringify([
    draft.calls,
    draft.legacyCost,
    draft.mode,
    draft.currencies.map(({ currency, amount }) => [currency, amount]),
    draft.migrationCurrency,
  ]);
}

function parseAmount(text: string): number | null {
  const trimmed = text.trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return null;
  const amount = Number(trimmed);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

/** Invalid input is an error, never an implicit request to clear a saved limit. */
export function validateBudgetDraft(draft: BudgetEditorDraft): BudgetDraftResult {
  const errors: string[] = [];
  const calls = draft.calls.trim() === '' ? null : parseAmount(draft.calls);
  if (draft.calls.trim() !== '' && (calls === null || !Number.isSafeInteger(calls))) {
    errors.push('额外调用上限必须是正的安全整数，或留空表示不限。');
  }
  const legacyCost = draft.legacyCost === '' ? null : parseAmount(draft.legacyCost);
  if (draft.legacyCost !== '' && legacyCost === null) errors.push('旧金额上限无效，请主动清除后重新配置。');
  const entries: Array<[string, number | null]> = [];
  const seen = new Set<string>();
  if (draft.mode === 'per-currency') {
    for (const [index, row] of draft.currencies.entries()) {
      const prefix = `第 ${index + 1} 行：`;
      const currencyError = budgetCurrencyError(row.currency);
      if (currencyError !== null) errors.push(prefix + currencyError);
      if (seen.has(row.currency)) errors.push(`${prefix}币种「${row.currency}」重复，请合并为一行。`);
      seen.add(row.currency);
      const amount = row.amount.trim() === '' ? null : parseAmount(row.amount);
      if (row.amount.trim() !== '' && amount === null) errors.push(`${prefix}金额必须为有限正数，或留空表示未设限。`);
      entries.push([row.currency, amount]);
    }
  } else if (draft.currencies.length > 0) {
    errors.push('旧上限尚未确认迁移，不能写入逐币种映射。');
  }
  if (errors.length > 0) return { ok: false, errors };
  if (draft.mode === 'legacy') {
    return {
      ok: true,
      limits: calls === null && legacyCost === null ? null : { maxExtraCalls: calls, maxCost: legacyCost },
    };
  }
  return {
    ok: true,
    limits: { maxExtraCalls: calls, maxCost: legacyCost, maxCostByCurrency: Object.fromEntries(entries) },
  };
}

/** This function is called only by the explicit confirmation button, never on selection/change. */
export function confirmBudgetMigration(
  draft: BudgetEditorDraft,
): { ok: true; draft: BudgetEditorDraft } | { ok: false; errors: string[] } {
  const error = budgetCurrencyError(draft.migrationCurrency);
  if (error !== null) return { ok: false, errors: [`请先明确选择旧上限的币种。${error}`] };
  if (draft.mode !== 'legacy' || parseAmount(draft.legacyCost) === null || draft.currencies.length > 0) {
    return { ok: false, errors: ['没有可迁移的旧标量上限；不会覆盖已配置的币种映射。'] };
  }
  return {
    ok: true,
    draft: {
      ...draft,
      mode: 'per-currency',
      legacyCost: '',
      currencies: [{ id: 0, currency: draft.migrationCurrency, amount: draft.legacyCost }],
      migrationCurrency: '',
    },
  };
}

/** Explicit clear, not an absent mapping that would reactivate legacy maxCost. */
export function clearBudgetCostDraft(draft: BudgetEditorDraft): BudgetEditorDraft {
  return { ...draft, mode: 'per-currency', legacyCost: '', currencies: [], migrationCurrency: '' };
}

/** Include configured currencies even before their first bill; never fabricate a zero cost. */
export function budgetCurrencyRows(state: BudgetState, limits: BudgetLimits | null | undefined): CurrencyBudgetState[] {
  const rows = new Map((state.currencyBudgets ?? []).map((entry) => [entry.currency, { ...entry }]));
  for (const [currency, value] of Object.entries(limits?.maxCostByCurrency ?? {})) {
    if (rows.has(currency)) continue;
    const limit = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
    rows.set(currency, { currency, cost: null, limit, remaining: null, exceeded: false });
  }
  return [...rows.values()].sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));
}

export interface BudgetEditorSession {
  draft: BudgetEditorDraft;
  baseSignature: string;
  cleanSignature: string;
}

export interface BudgetDraftSave {
  signature: string;
  draftSignature: string;
  baseSignature: string;
  /** True only after a returned persistence promise fulfills, never just a props echo. */
  confirmed: boolean;
}

/** Preserve both sides of conflicts, including optimistic echoes followed by rollback. */
export function reconcileBudgetDraft(
  editor: BudgetEditorSession,
  limits: BudgetLimits | null | undefined,
  request: BudgetDraftSave | null = null,
): BudgetEditorSession {
  const signature = budgetLimitsSignature(limits);
  if (signature === editor.baseSignature) {
    if (
      request?.confirmed === true &&
      request.signature === signature &&
      editor.cleanSignature !== request.draftSignature
    ) {
      return { ...editor, cleanSignature: request.draftSignature };
    }
    return editor;
  }
  if (request !== null && request.signature === signature && request.baseSignature === editor.baseSignature) {
    return {
      ...editor,
      baseSignature: signature,
      cleanSignature: request.confirmed ? request.draftSignature : editor.cleanSignature,
    };
  }
  if (budgetDraftSignature(editor.draft) !== editor.cleanSignature) return editor;
  const draft = createBudgetDraft(limits);
  return { draft, baseSignature: signature, cleanSignature: budgetDraftSignature(draft) };
}
