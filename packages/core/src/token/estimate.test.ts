import { describe, expect, it } from 'vitest';
import { estimateTokens } from './estimate.js';

describe('estimateTokens', () => {
  it('中文按一字一 token 估算', () => {
    expect(estimateTokens('你好世界')).toBe(4);
  });

  it('英文按四字符一 token 估算并向上取整', () => {
    expect(estimateTokens('hello')).toBe(2);
    expect(estimateTokens('hello world!')).toBe(3);
  });

  it('中英混排分别计算', () => {
    expect(estimateTokens('你好 world')).toBe(2 + 2);
  });

  it('空串为 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('emoji 等辅助平面字符只算一次', () => {
    expect(estimateTokens('🎲')).toBe(1);
  });

  it('估算值单调不减', () => {
    const short = estimateTokens('一段文字');
    const long = estimateTokens('一段文字'.repeat(10));
    expect(long).toBeGreaterThan(short);
  });
});
