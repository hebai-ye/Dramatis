import { describe, expect, it } from 'vitest';
import { type BudgetLimits, type BudgetState, evaluateBudget } from './budget.js';
import {
  budgetCurrencyError,
  budgetCurrencyRows,
  budgetDraftSaveBlockReason,
  budgetDraftSignature,
  budgetLimitsSignature,
  clearBudgetCostDraft,
  confirmBudgetMigration,
  createBudgetDraft,
  reconcileBudgetDraft,
  validateBudgetDraft,
} from './budget-editor.js';
import { summarizeUsage, type UsageRecord } from './usage.js';

function record(currency: string | null, tokens = 1_000_000): UsageRecord {
  return {
    id: `record-${currency}`,
    roomId: null,
    conversationId: null,
    turnId: null,
    category: 'analysis',
    model: 'test-model',
    promptTokens: tokens,
    completionTokens: 0,
    speakerInstanceId: null,
    speakerName: '',
    price: currency === null ? null : { currency, inputPerMillion: 2, outputPerMillion: 1 },
    createdAt: '2026-10-08T00:00:00.000Z',
    updatedAt: '2026-10-08T00:00:00.000Z',
  };
}

function parsed(limits: BudgetLimits | null) {
  const result = validateBudgetDraft(createBudgetDraft(limits));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.errors.join(';'));
  return result.limits;
}

describe('D07 budget editor: explicit legacy migration', () => {
  it('does not preselect a currency, migrate or change the policy while editing calls', () => {
    const original = { maxExtraCalls: 5, maxCost: 12 };
    const draft = createBudgetDraft(original);
    expect(draft.migrationCurrency).toBe('');
    expect(draft.mode).toBe('legacy');
    expect(confirmBudgetMigration(draft).ok).toBe(false);
    expect(validateBudgetDraft({ ...draft, calls: '8' })).toEqual({
      ok: true,
      limits: { maxExtraCalls: 8, maxCost: 12 },
    });
    expect(original).toEqual({ maxExtraCalls: 5, maxCost: 12 });
  });

  it('selection without confirmation preserves the legacy scalar and absent map', () => {
    const draft = { ...createBudgetDraft({ maxCost: 12 }), migrationCurrency: 'USD' };
    const result = validateBudgetDraft(draft);
    expect(result).toEqual({ ok: true, limits: { maxExtraCalls: null, maxCost: 12 } });
    expect(draft.mode).toBe('legacy');
    expect(draft.currencies).toEqual([]);
  });

  it('refuses to silently write rows in an unconfirmed legacy draft', () => {
    const draft = createBudgetDraft({ maxCost: 12 });
    draft.currencies = [{ id: 0, currency: 'CNY', amount: '12' }];
    expect(validateBudgetDraft(draft).ok).toBe(false);
    expect(confirmBudgetMigration({ ...draft, migrationCurrency: 'USD' }).ok).toBe(false);
  });

  it('explicit confirmation binds exactly one selected currency and clears the scalar only in the new draft', () => {
    const draft = { ...createBudgetDraft({ maxExtraCalls: 8, maxCost: 12 }), migrationCurrency: '¥' };
    const confirmed = confirmBudgetMigration(draft);
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) throw new Error('migration failed');
    expect(validateBudgetDraft(confirmed.draft)).toEqual({
      ok: true,
      limits: { maxExtraCalls: 8, maxCost: null, maxCostByCurrency: { '¥': 12 } },
    });
    expect(draft.legacyCost).toBe('12');
    expect(draft.currencies).toEqual([]);
    expect(draft.mode).toBe('legacy');
  });

  it('cannot copy a stale scalar over an existing mapping', () => {
    const draft = { ...createBudgetDraft({ maxCost: 9, maxCostByCurrency: { USD: 5 } }), migrationCurrency: 'CNY' };
    expect(confirmBudgetMigration(draft).ok).toBe(false);
    expect(validateBudgetDraft(draft)).toEqual({
      ok: true,
      limits: { maxExtraCalls: null, maxCost: 9, maxCostByCurrency: { USD: 5 } },
    });
  });

  it('explicit clearing disables the old scalar and preserves calls', () => {
    const legacy = createBudgetDraft({ maxCost: 12, maxExtraCalls: 5 });
    const cleared = clearBudgetCostDraft(legacy);
    expect(validateBudgetDraft(cleared)).toEqual({
      ok: true,
      limits: { maxExtraCalls: 5, maxCost: null, maxCostByCurrency: {} },
    });
    expect(legacy.mode).toBe('legacy');
    expect(legacy.legacyCost).toBe('12');
  });

  it.each([{}, null])('keeps an explicitly empty map %s distinct from no migration', (maxCostByCurrency) => {
    const saved = parsed({ maxCost: 1, maxCostByCurrency });
    expect(saved?.maxCostByCurrency).toEqual({});
    expect(evaluateBudget(summarizeUsage([record('USD')]), saved).burned).toBe(false);
    expect(budgetLimitsSignature(saved)).not.toBe(budgetLimitsSignature({ maxCost: 1 }));
  });

  it('preserves an explicit empty map even with no other limits', () => {
    expect(parsed(null)).toBeNull();
    expect(parsed({ maxCostByCurrency: {} })).toEqual({ maxExtraCalls: null, maxCost: null, maxCostByCurrency: {} });
  });
});

describe('D07 budget editor: validation and lossless editing', () => {
  it('preserves both currencies across repeated call-count edits and never mutates the input', () => {
    const original = { maxExtraCalls: 5, maxCostByCurrency: { CNY: 100, USD: 3, EUR: null } };
    let limits: BudgetLimits | null = original;
    for (const calls of ['8', '10', '', '3']) {
      const draft = { ...createBudgetDraft(limits), calls };
      const result = validateBudgetDraft(draft);
      if (!result.ok) throw new Error(result.errors.join(';'));
      limits = result.limits;
      expect(limits?.maxCostByCurrency).toEqual(original.maxCostByCurrency);
    }
    expect(original.maxExtraCalls).toBe(5);
  });

  it('keeps CNY, ¥ and lower-case labels separate, including new currencies', () => {
    const mapping = { CNY: 10, '¥': 20, cny: 30, X_NEW: 40, 人民币: 50, US$: 60 };
    expect(parsed({ maxCostByCurrency: mapping })?.maxCostByCurrency).toEqual(mapping);
  });

  it.each([
    '',
    ' ',
    '\u00a0',
    '\u3000',
    'USD\n',
    'a\u0000b',
    'USD\tlabel',
    'a\u007fb',
    'a\u0085b',
    'a\u202eb',
    'a\u2028b',
    'a\u2029b',
    '__proto__',
    'constructor',
    'prototype',
    'A'.repeat(65),
  ])('rejects an illegal label without normalizing or discarding it: %j', (currency) => {
    const draft = createBudgetDraft({ maxCostByCurrency: { CNY: 10 } });
    draft.currencies.push({ id: 1, currency, amount: '5' });
    expect(budgetCurrencyError(currency)).not.toBeNull();
    expect(validateBudgetDraft(draft).ok).toBe(false);
    expect(draft.currencies[1]?.currency).toBe(currency);
    expect(draft.currencies[0]?.amount).toBe('10');
  });

  it('rejects duplicates instead of overwriting a saved row', () => {
    const draft = createBudgetDraft({ maxCostByCurrency: { USD: 10 } });
    draft.currencies.push({ id: 1, currency: 'USD', amount: '20' });
    const result = validateBudgetDraft(draft);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain('重复');
    expect(draft.currencies).toHaveLength(2);
  });

  it.each(['0', '-1', 'NaN', 'Infinity', '1e309', '1e-9999', '0x10', '0b11', '1,000', '1 2', '+', 'five'])(
    'rejects nonpositive, nonfinite or malformed amount %j and retains the raw draft',
    (amount) => {
      const draft = createBudgetDraft({ maxCostByCurrency: { USD: 10 } });
      draft.currencies[0] = { id: 0, currency: 'USD', amount };
      expect(validateBudgetDraft(draft).ok).toBe(false);
      expect(draft.currencies[0]?.amount).toBe(amount);
    },
  );

  it.each(['0', '-2', '1.5', 'Infinity', '9007199254740992', '0x10', 'bad'])(
    'rejects an invalid calls limit %j',
    (calls) => {
      expect(validateBudgetDraft({ ...createBudgetDraft(null), calls }).ok).toBe(false);
    },
  );

  it('accepts positive decimal/scientific amounts and explicitly blank unlimited rows', () => {
    const draft = createBudgetDraft({ maxCostByCurrency: {} });
    draft.currencies = [
      { id: 0, currency: 'USD', amount: '.25' },
      { id: 1, currency: 'CNY', amount: ' 1e-8 ' },
      { id: 2, currency: 'EUR', amount: '' },
    ];
    expect(validateBudgetDraft(draft)).toEqual({
      ok: true,
      limits: { maxExtraCalls: null, maxCost: null, maxCostByCurrency: { USD: 0.25, CNY: 1e-8, EUR: null } },
    });
  });

  it('ignores inherited map keys without losing own entries', () => {
    const mapping = Object.assign(Object.create({ USD: 1 }), { CNY: 10 });
    expect(parsed({ maxCostByCurrency: mapping })?.maxCostByCurrency).toEqual({ CNY: 10 });
  });
});

describe('D07 budget editor: diagnostics and draft signatures', () => {
  it('includes configured currencies without bills and never labels their cost or remaining as zero', () => {
    const limits = { maxCostByCurrency: { EUR: 10 } };
    const state = evaluateBudget(null, limits);
    expect(budgetCurrencyRows(state, limits)).toEqual([
      { currency: 'EUR', cost: null, limit: 10, remaining: null, exceeded: false },
    ]);
    const legacyState: BudgetState = {
      extraCalls: 0,
      cost: null,
      remainingCalls: null,
      remainingCost: null,
      burned: false,
      reason: null,
    };
    expect(budgetCurrencyRows(legacyState, limits)).toEqual(budgetCurrencyRows(state, limits));
  });

  it('leaves unknown-price records unknown without stopping purely because currencies are mixed', () => {
    const summary = summarizeUsage([record(null), record('CNY'), record('USD')]);
    const limits = { maxCostByCurrency: { CNY: 10, EUR: 5 } };
    const state = evaluateBudget(summary, limits);
    const before = structuredClone(state);
    expect(state.unpricedCalls).toBe(1);
    expect(state.burned).toBe(false);
    expect(budgetCurrencyRows(state, limits)).toEqual([
      { currency: 'CNY', cost: 2, limit: 10, remaining: 8, exceeded: false },
      { currency: 'EUR', cost: null, limit: 5, remaining: null, exceeded: false },
      { currency: 'USD', cost: 2, limit: null, remaining: null, exceeded: false },
    ]);
    expect(state).toEqual(before);
  });

  it('keeps zero-token priced records distinct from unknown records without inventing free status', () => {
    const limits = { maxCostByCurrency: { CNY: 1, USD: 1 } };
    const state = evaluateBudget(summarizeUsage([record('CNY', 0), record(null, 0)]), limits);
    expect(state.unpricedCalls).toBe(1);
    expect(budgetCurrencyRows(state, limits)).toEqual([
      { currency: 'CNY', cost: 0, limit: 1, remaining: 1, exceeded: false },
      { currency: 'USD', cost: null, limit: 1, remaining: null, exceeded: false },
    ]);
  });

  it('reports the exceeded currency and separate remaining amounts', () => {
    const limits = { maxCostByCurrency: { CNY: 1, USD: 10 } };
    const state = evaluateBudget(summarizeUsage([record('CNY'), record('USD')]), limits);
    expect(state.reason).toContain('CNY');
    expect(
      budgetCurrencyRows(state, limits).map(({ currency, remaining, exceeded }) => ({ currency, remaining, exceeded })),
    ).toEqual([
      { currency: 'CNY', remaining: 0, exceeded: true },
      { currency: 'USD', remaining: 8, exceeded: false },
    ]);
  });

  it('ignores map insertion order but detects currency, amount and policy changes in saved signatures', () => {
    const signature = budgetLimitsSignature({ maxCostByCurrency: { CNY: 1, USD: 2 } });
    expect(budgetLimitsSignature({ maxCostByCurrency: { USD: 2, CNY: 1 } })).toBe(signature);
    expect(budgetLimitsSignature({ maxCostByCurrency: { CNY: 1, USD: 3 } })).not.toBe(signature);
    expect(budgetLimitsSignature({ maxCostByCurrency: { '¥': 1, USD: 2 } })).not.toBe(signature);
    expect(budgetLimitsSignature({ maxCostByCurrency: {} })).not.toBe(budgetLimitsSignature(null));
    expect(budgetLimitsSignature({ maxCostByCurrency: null })).toBe(budgetLimitsSignature({ maxCostByCurrency: {} }));
  });

  it('detects invalid text and unconfirmed selection changes instead of comparing only parsed values', () => {
    const draft = createBudgetDraft({ maxCost: 10 });
    const signature = budgetDraftSignature(draft);
    expect(budgetDraftSignature({ ...draft, calls: 'oops' })).not.toBe(signature);
    expect(budgetDraftSignature({ ...draft, calls: '0' })).not.toBe(signature);
    expect(budgetDraftSignature({ ...draft, migrationCurrency: 'USD' })).not.toBe(signature);
    expect(budgetDraftSignature(createBudgetDraft({ maxCost: 10 }))).toBe(signature);
  });

  it('detects configured mapping changes even when calls and legacy cost are unchanged', () => {
    const original = { maxExtraCalls: 5, maxCost: 10, maxCostByCurrency: { CNY: 5 } };
    const changed = { ...original, maxCostByCurrency: { CNY: 5, USD: 10 } };
    expect(budgetLimitsSignature(original)).not.toBe(budgetLimitsSignature(changed));
    expect(budgetDraftSignature(createBudgetDraft(original))).not.toBe(
      budgetDraftSignature(createBudgetDraft(changed)),
    );
  });
});

describe('D07 budget editor: refresh and optimistic save reconciliation', () => {
  const original = { maxExtraCalls: 5, maxCostByCurrency: { CNY: 10 } };
  const initialDraft = createBudgetDraft(original);
  const initial = {
    draft: initialDraft,
    baseSignature: budgetLimitsSignature(original),
    cleanSignature: budgetDraftSignature(initialDraft),
  };

  it('refreshes a clean draft for a genuinely changed saved mapping', () => {
    const changed = { ...original, maxCostByCurrency: { CNY: 10, USD: 3 } };
    const refreshed = reconcileBudgetDraft(initial, changed);
    expect(refreshed.draft.currencies.map((row) => row.currency)).toEqual(['CNY', 'USD']);
    expect(refreshed.baseSignature).toBe(budgetLimitsSignature(changed));
    expect(refreshed.cleanSignature).toBe(budgetDraftSignature(refreshed.draft));
    expect(reconcileBudgetDraft(initial, structuredClone(original))).toBe(initial);
  });

  it('preserves an invalid user draft and the prior baseline when an external mapping changes', () => {
    const dirty = { ...initial, draft: { ...initialDraft, calls: 'not-a-number' } };
    const changed = { ...original, maxCostByCurrency: { CNY: 10, EUR: 5 } };
    expect(reconcileBudgetDraft(dirty, changed)).toBe(dirty);
    expect(dirty.baseSignature).not.toBe(budgetLimitsSignature(changed));
    expect(changed.maxCostByCurrency).toEqual({ CNY: 10, EUR: 5 });
  });

  it('keeps an optimistic save dirty and does not erase its draft when persistence rolls back', () => {
    const dirty = { ...initial, draft: { ...initialDraft, calls: '8' } };
    const updated = { ...original, maxExtraCalls: 8 };
    const request = {
      signature: budgetLimitsSignature(updated),
      baseSignature: initial.baseSignature,
      draftSignature: budgetDraftSignature(dirty.draft),
      confirmed: false,
    };
    const echoed = reconcileBudgetDraft(dirty, updated, request);
    expect(echoed.draft).toBe(dirty.draft);
    expect(echoed.cleanSignature).toBe(initial.cleanSignature);
    expect(echoed.baseSignature).toBe(request.signature);
    expect(reconcileBudgetDraft(echoed, original, request)).toBe(echoed);
    expect(echoed.draft.calls).toBe('8');
  });

  it('acknowledges only the submitted draft after confirmed persistence, retaining newer edits', () => {
    const submitted = { ...initialDraft, calls: '8' };
    const updated = { ...original, maxExtraCalls: 8 };
    const request = {
      signature: budgetLimitsSignature(updated),
      baseSignature: initial.baseSignature,
      draftSignature: budgetDraftSignature(submitted),
      confirmed: true,
    };
    const newer = { ...initial, draft: { ...submitted, calls: '9' } };
    const echoed = reconcileBudgetDraft(newer, updated, request);
    expect(echoed.cleanSignature).toBe(request.draftSignature);
    expect(echoed.draft.calls).toBe('9');
    expect(budgetDraftSignature(echoed.draft)).not.toBe(echoed.cleanSignature);
  });
});

describe('D07 budget editor: fail closed without explicit world identity', () => {
  it.each([undefined, null, '', ' ', '\t\n'])('blocks all explicit currency writes without identity %j', (worldId) => {
    const drafts = [
      createBudgetDraft({ maxCostByCurrency: { USD: 5 } }),
      createBudgetDraft({ maxCostByCurrency: {} }),
      createBudgetDraft({ maxCostByCurrency: null }),
      clearBudgetCostDraft(createBudgetDraft({ maxCost: 10 })),
    ];
    const migration = confirmBudgetMigration({ ...createBudgetDraft({ maxCost: 10 }), migrationCurrency: 'CNY' });
    if (!migration.ok) throw new Error('migration fixture failed');
    drafts.push(migration.draft);
    for (const draft of drafts) {
      const before = structuredClone(draft);
      expect(budgetDraftSaveBlockReason(draft, worldId)).toContain('只能暂存草稿');
      expect(draft).toEqual(before);
    }
  });

  it('allows a valid explicitly scoped mapping or clear without inferring or changing its labels', () => {
    const draft = createBudgetDraft({ maxCostByCurrency: { CNY: 3, '¥': 4 } });
    expect(budgetDraftSaveBlockReason(draft, 'world-a')).toBeNull();
    expect(budgetDraftSaveBlockReason(clearBudgetCostDraft(draft), 'world-b')).toBeNull();
    expect(draft.currencies.map((row) => row.currency)).toEqual(['CNY', '¥']);
  });

  it('retains legacy save compatibility without a world identity or automatic migration', () => {
    const draft = { ...createBudgetDraft({ maxCost: 10 }), calls: '5', migrationCurrency: 'USD' };
    expect(budgetDraftSaveBlockReason(draft)).toBeNull();
    expect(validateBudgetDraft(draft)).toEqual({ ok: true, limits: { maxExtraCalls: 5, maxCost: 10 } });
    expect(budgetDraftSaveBlockReason(createBudgetDraft(null), null)).toBeNull();
  });
});

describe('D07 budget editor: failure and late-completion draft safety', () => {
  const original = { maxExtraCalls: 5, maxCostByCurrency: { CNY: 10 } };
  const initialDraft = createBudgetDraft(original);
  const dirty = {
    draft: { ...initialDraft, calls: '8' },
    baseSignature: budgetLimitsSignature(original),
    cleanSignature: budgetDraftSignature(initialDraft),
  };
  const saved = { ...original, maxExtraCalls: 8 };
  const request = {
    baseSignature: dirty.baseSignature,
    signature: budgetLimitsSignature(saved),
    draftSignature: budgetDraftSignature(dirty.draft),
    confirmed: false,
  };

  it('retains the exact draft for an unconfirmed/failed request with unchanged props', () => {
    expect(reconcileBudgetDraft(dirty, original, request)).toBe(dirty);
    expect(dirty.draft.calls).toBe('8');
    expect(dirty.draft.currencies).toEqual([{ id: 0, currency: 'CNY', amount: '10' }]);
  });

  it('does not acknowledge a late fulfillment after an optimistic echo has become an external conflict', () => {
    const echoed = reconcileBudgetDraft(dirty, saved, request);
    const external = { maxExtraCalls: 20, maxCostByCurrency: { CNY: 10, USD: 30 } };
    const conflicted = reconcileBudgetDraft(echoed, external, request);
    expect(conflicted).toBe(echoed);
    expect(reconcileBudgetDraft(conflicted, external, { ...request, confirmed: true })).toBe(conflicted);
    expect(conflicted.baseSignature).not.toBe(budgetLimitsSignature(external));
    expect(budgetDraftSignature(conflicted.draft)).not.toBe(conflicted.cleanSignature);
    expect(external.maxCostByCurrency).toEqual({ CNY: 10, USD: 30 });
  });

  it('acknowledges a fulfilled request only while the current configuration still matches it', () => {
    const echoed = reconcileBudgetDraft(dirty, saved, request);
    const acknowledged = reconcileBudgetDraft(echoed, saved, { ...request, confirmed: true });
    expect(acknowledged.draft).toBe(dirty.draft);
    expect(acknowledged.cleanSignature).toBe(request.draftSignature);
  });
});

describe('D07 budget editor: arbitrary printable display labels remain exact', () => {
  it.each(['US $', '人民币(元)', '<USD>', ' CNY', 'CNY ', '💰 / token', 'USD\u00a0/token'])(
    'preserves and explicitly migrates to the printable label %j without normalization',
    (currency) => {
      expect(budgetCurrencyError(currency)).toBeNull();
      const mapping = { [currency]: 10 };
      expect(parsed({ maxCostByCurrency: mapping })?.maxCostByCurrency).toEqual(mapping);
      const legacy = { ...createBudgetDraft({ maxCost: 10 }), migrationCurrency: currency };
      const migration = confirmBudgetMigration(legacy);
      if (!migration.ok) throw new Error(migration.errors.join(';'));
      expect(migration.draft.currencies[0]?.currency).toBe(currency);
      expect(validateBudgetDraft(migration.draft)).toEqual({
        ok: true,
        limits: { maxExtraCalls: null, maxCost: null, maxCostByCurrency: mapping },
      });
      expect(budgetDraftSaveBlockReason(migration.draft)).not.toBeNull();
    },
  );

  it('keeps CNY and CNY-with-trailing-space as separate budget and billing keys', () => {
    const limits = parsed({ maxCostByCurrency: { CNY: 1, 'CNY ': 5 } });
    expect(limits?.maxCostByCurrency).toEqual({ CNY: 1, 'CNY ': 5 });
    const summary = summarizeUsage([record('CNY'), record('CNY ')]);
    const state = evaluateBudget(summary, limits);
    expect(budgetCurrencyRows(state, limits)).toEqual([
      { currency: 'CNY', cost: 2, limit: 1, remaining: 0, exceeded: true },
      { currency: 'CNY ', cost: 2, limit: 5, remaining: 3, exceeded: false },
    ]);
  });

  it('detects whitespace-only key differences in both saved and draft signatures', () => {
    const plain = { maxCostByCurrency: { CNY: 10 } };
    const spaced = { maxCostByCurrency: { 'CNY ': 10 } };
    expect(budgetLimitsSignature(plain)).not.toBe(budgetLimitsSignature(spaced));
    expect(budgetDraftSignature(createBudgetDraft(plain))).not.toBe(budgetDraftSignature(createBudgetDraft(spaced)));
  });

  it('still rejects an exact duplicate printable label rather than merging its limits', () => {
    const draft = createBudgetDraft({ maxCostByCurrency: { 'US $': 10 } });
    draft.currencies.push({ id: 1, currency: 'US $', amount: '20' });
    const result = validateBudgetDraft(draft);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain('重复');
    expect(draft.currencies.map((row) => row.amount)).toEqual(['10', '20']);
  });
});
