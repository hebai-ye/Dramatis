import type { UsageTotals } from '@dramatis/core';
import { describe, expect, it } from 'vitest';
import { CALIBRATION_MIN_SAMPLES, formatCalibrationNote, formatCost } from './usage';

function totals(overrides: Partial<UsageTotals> = {}): UsageTotals {
  return {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    tokens: 0,
    cost: null,
    pricedCalls: 0,
    currency: null,
    costs: [],
    calibration: { calls: 0, estimated: 0, actual: 0 },
    ...overrides,
  };
}

describe('账单文案 · 审计 B9（多币种不加在一起）', () => {
  it('多种币种写成「另计」，而不是相加成一个数', () => {
    const text = formatCost(
      totals({
        calls: 3,
        pricedCalls: 3,
        cost: 30,
        currency: '¥',
        costs: [
          { currency: '¥', cost: 30, pricedCalls: 2 },
          { currency: '$', cost: 5, pricedCalls: 1 },
        ],
      }),
    );
    expect(text).toBe('¥30.00，另计 $5.00');
  });

  it('一条都没配单价时是 null，不编一个 0 出来', () => {
    expect(formatCost(totals({ calls: 4 }))).toBeNull();
  });
});

describe('账单文案 · 顺序 71（口径核对那一行）', () => {
  it('样本不够就不显示：三两条调用算出来的比例只会误导人', () => {
    const few = totals({
      calls: 3,
      calibration: { calls: CALIBRATION_MIN_SAMPLES - 1, estimated: 1000, actual: 1300 },
    });
    expect(formatCalibrationNote(few)).toBeNull();
  });

  it('没有配对样本时也不显示（本地模型不回 usage）', () => {
    expect(formatCalibrationNote(totals({ calls: 20 }))).toBeNull();
  });

  it('真实比估算高时说「少」并给出百分比', () => {
    const note = formatCalibrationNote(
      totals({ calls: 20, calibration: { calls: 12, estimated: 1000, actual: 1260 } }),
    );
    expect(note).toContain('少 26%');
    expect(note).toContain('12 次调用参与');
  });

  it('估得比真实还多时说「多」', () => {
    const note = formatCalibrationNote(totals({ calls: 20, calibration: { calls: 12, estimated: 1000, actual: 900 } }));
    expect(note).toContain('多 10%');
  });

  it('相差不到 5% 就直说基本一致，省得人去调一个没必要的除数', () => {
    const note = formatCalibrationNote(
      totals({ calls: 20, calibration: { calls: 20, estimated: 1000, actual: 1020 } }),
    );
    expect(note).toContain('基本一致');
  });
});
