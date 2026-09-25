import { describe, expect, it } from 'vitest';
import { isNearBottom } from './scroll';

describe('isNearBottom（审计 B17）', () => {
  it('80px 内算贴底', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 500 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 420, clientHeight: 500 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 419, clientHeight: 500 })).toBe(false);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 0, clientHeight: 500 })).toBe(false);
  });
});
