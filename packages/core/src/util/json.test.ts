import { describe, expect, it } from 'vitest';
import { asRecord, str, text, toFinite } from './json.js';

/**
 * 这几个函数是**七处重复收敛出来的**（顺序 65），所以测试盯的就是那句契约：
 * 「拿不准就退回默认值，绝不抛」。真实数据来自模型与第三方卡文件，形状不可信。
 */
describe('json 工具', () => {
  it('asRecord 只认普通对象：数组、null、标量都给 null', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([])).toBeNull();
    expect(asRecord(null)).toBeNull();
    expect(asRecord('{}')).toBeNull();
    expect(asRecord(3)).toBeNull();
    // 要注意的边界：`undefined` 与函数都不是对象
    expect(asRecord(undefined)).toBeNull();
  });

  it('str 不 trim、只认字符串；text 会 trim 两头空白', () => {
    expect(str('  留着空格  ')).toBe('  留着空格  ');
    expect(str(3, '兜底')).toBe('兜底');
    expect(str(null)).toBe('');
    expect(text('  收干净  ')).toBe('收干净');
    expect(text(undefined)).toBe('');
    expect(text(42, '兜底')).toBe('兜底');
  });

  it('toFinite 丢掉 NaN 与 ±Infinity，其余数字照收', () => {
    expect(toFinite(0.6)).toBe(0.6);
    expect(toFinite(-1)).toBe(-1);
    expect(toFinite(Number.NaN, 0.5)).toBe(0.5);
    expect(toFinite(Number.POSITIVE_INFINITY, 0.5)).toBe(0.5);
    expect(toFinite('0.6', 0.5)).toBe(0.5);
    expect(toFinite(undefined)).toBe(0);
  });
});
