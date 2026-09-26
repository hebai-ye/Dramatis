import { describe, expect, it } from 'vitest';
import {
  calibrateCounts,
  calibrateTokenCounter,
  counterFromCalibration,
  formatCalibration,
  MAX_NARROW_DIVISOR,
  MIN_NARROW_DIVISOR,
  ratioOf,
  suggestedNarrowDivisorFor,
} from './calibrate.js';
import { NARROW_CHARS_PER_TOKEN } from './estimate.js';

describe('token 估算校准（顺序 71）', () => {
  it('没有样本时不下结论：ratio 为 null，除数保持默认 4', () => {
    const report = calibrateCounts([]);
    expect(report.samples).toBe(0);
    expect(report.estimated).toBe(0);
    expect(report.actual).toBe(0);
    expect(report.ratio).toBeNull();
    expect(report.suggestedNarrowDivisor).toBe(NARROW_CHARS_PER_TOKEN);
    expect(report.worst).toEqual([]);
    expect(counterFromCalibration(report)).toBeNull();
    expect(formatCalibration(report)).toContain('还没有可用的配对样本');
  });

  it('估准就是 1：除数不动', () => {
    const report = calibrateCounts([{ estimated: 100, actual: 100 }]);
    expect(report.ratio).toBe(1);
    expect(report.suggestedNarrowDivisor).toBe(4);
  });

  it('真实值比估算高 → 比例大于 1，建议把除数调小', () => {
    const report = calibrateCounts([{ estimated: 100, actual: 130 }]);
    expect(report.ratio).toBeCloseTo(1.3, 6);
    expect(report.suggestedNarrowDivisor).toBe(3.1);
    expect(formatCalibration(report)).toContain('低估 30%');
  });

  it('高估则反过来，并且提示词里的方向是「高估」', () => {
    const report = calibrateCounts([{ estimated: 100, actual: 90 }]);
    expect(report.ratio).toBeCloseTo(0.9, 6);
    expect(report.suggestedNarrowDivisor).toBe(4.4);
    expect(formatCalibration(report)).toContain('高估 10%');
  });

  it('除数建议有上下界：再离谱的样本也不会给出 0.4 或 13.3', () => {
    expect(suggestedNarrowDivisorFor(10)).toBe(MIN_NARROW_DIVISOR);
    expect(suggestedNarrowDivisorFor(0.3)).toBe(MAX_NARROW_DIVISOR);
    expect(suggestedNarrowDivisorFor(null)).toBe(NARROW_CHARS_PER_TOKEN);
    expect(suggestedNarrowDivisorFor(-2)).toBe(NARROW_CHARS_PER_TOKEN);
  });

  it('不可用的样本被丢掉，不算进比例（0、NaN、Infinity）', () => {
    const report = calibrateCounts([
      { estimated: 0, actual: 5 },
      { estimated: 5, actual: 0 },
      { estimated: Number.NaN, actual: 5 },
      { estimated: 5, actual: Number.POSITIVE_INFINITY },
      { estimated: 10, actual: 20 },
    ]);
    expect(report.samples).toBe(1);
    expect(report.ratio).toBe(2);
    expect(ratioOf(0, 10)).toBeNull();
    expect(ratioOf(10, 0)).toBeNull();
  });

  it('先求和再相除，不是逐条平均：大样本说话更大声', () => {
    const report = calibrateCounts([
      { estimated: 10, actual: 20 }, // 这一条低估 100%，但小得不该主导结论
      { estimated: 1000, actual: 1000 },
    ]);
    expect(report.ratio).toBeCloseTo(1020 / 1010, 6);
    expect(report.ratio).toBeLessThan(1.02);
    expect(report.estimated).toBe(1010);
    expect(report.actual).toBe(1020);
  });

  it('偏差最大的样本排在前面，并列按下标定序', () => {
    const report = calibrateCounts([
      { estimated: 100, actual: 110 }, // +10%
      { estimated: 100, actual: 200 }, // +100%
      { estimated: 100, actual: 50 }, // -50%
    ]);
    expect(report.worst.map((item) => item.index)).toEqual([1, 2, 0]);
    expect(report.worst[0]?.deviation).toBeCloseTo(1, 6);
    expect(report.worst[1]?.deviation).toBeCloseTo(-0.5, 6);
  });

  it('带原文的样本能看出是哪一段估偏了（预览折成一行、截到 80 字）', () => {
    const long = `第一段\n${'啊'.repeat(200)}`;
    const report = calibrateTokenCounter([
      { text: '你好世界', actual: 6 },
      { text: long, actual: 300 },
    ]);
    expect(report.samples).toBe(2);
    // 3 个汉字 + 200 个汉字 = 203 全角，加一个换行（窄字符）→ 203 + 1
    expect(report.estimated).toBe(4 + 204);
    const longPreview = report.worst.find((item) => item.index === 1)?.preview;
    expect(longPreview?.startsWith('第一段 啊')).toBe(true);
    expect(longPreview?.includes('\n')).toBe(false);
    expect(longPreview?.length).toBeLessThanOrEqual(80);
  });

  it('可以换一个计数器来估（真 tokenizer 接进来时不用改这里）', () => {
    const report = calibrateTokenCounter([{ text: '随便什么', actual: 3 }], { name: 'ones', count: () => 1 });
    expect(report.estimated).toBe(1);
    expect(report.ratio).toBe(3);
  });

  it('按比例放大的计数器：口径不改，倍数带上名字', () => {
    const report = calibrateCounts([{ estimated: 100, actual: 150 }]);
    const counter = counterFromCalibration(report);
    expect(counter?.name).toBe('heuristic-cjk-calibrated-x1.5');
    // 原名口径：abcd = 1、abcdefgh = 2 → 放大 1.5 倍
    expect(counter?.count('abcd')).toBe(2);
    expect(counter?.count('abcdefgh')).toBe(3);
  });

  it('比例不干净时倍数取两位小数，向上取整', () => {
    const report = calibrateCounts([{ estimated: 300, actual: 400 }]);
    const counter = counterFromCalibration(report);
    expect(counter?.name).toBe('heuristic-cjk-calibrated-x1.33');
    expect(counter?.count('abcd')).toBe(2); // ceil(1 × 1.33)
  });
});
