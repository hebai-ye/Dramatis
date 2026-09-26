import { describe, expect, it } from 'vitest';
import { estimateTokens, heuristicTokenCounter, NARROW_CHARS_PER_TOKEN } from './estimate.js';

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

describe('窄字符除数（顺序 71）', () => {
  it('默认口径就是常量里的 4：口径要改走校准，不在公式里手改数字', () => {
    expect(NARROW_CHARS_PER_TOKEN).toBe(4);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(heuristicTokenCounter.count('abcd')).toBe(estimateTokens('abcd'));
  });

  it('这个口径没有跟真实分词器对齐过：估算值只保证保守，不保证准', () => {
    // 真实 BPE 里 'hello' 就是 1 个 token，这里给 2——**故意偏保守**，
    // 不然预算守卫会在临界时低估、被服务端 400 整轮打回。
    expect(estimateTokens('hello')).toBeGreaterThan(1);
  });
});
