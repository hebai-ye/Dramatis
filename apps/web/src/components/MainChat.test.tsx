import { afterEach, describe, expect, it, vi } from 'vitest';
import { scrollChatTo } from './MainChat';

afterEach(() => vi.unstubAllGlobals());

describe('主聊天滚动尊重减少动效偏好', () => {
  it('减少动效时跳到原句或底部都请求立即滚动', () => {
    vi.stubGlobal('window', {
      matchMedia: (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' }),
    });
    const target = { scrollTo: vi.fn() };
    scrollChatTo(target, 150);
    expect(target.scrollTo).toHaveBeenCalledWith({ top: 150, behavior: 'auto' });
  });

  it('每次滚动读取当前偏好，切换偏好后不会继续smooth', () => {
    let reduced = false;
    vi.stubGlobal('window', {
      matchMedia: (query: string) => ({ matches: reduced && query === '(prefers-reduced-motion: reduce)' }),
    });
    const target = { scrollTo: vi.fn() };
    scrollChatTo(target, 250);
    expect(target.scrollTo).toHaveBeenLastCalledWith({ top: 250, behavior: 'smooth' });
    reduced = true;
    scrollChatTo(target, 350);
    expect(target.scrollTo).toHaveBeenLastCalledWith({ top: 350, behavior: 'auto' });
  });

  it('切对话仍立即滚动，不因正常动效偏好改为smooth', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    const target = { scrollTo: vi.fn() };
    scrollChatTo(target, 450, true);
    expect(target.scrollTo).toHaveBeenCalledWith({ top: 450, behavior: 'auto' });
  });
});
