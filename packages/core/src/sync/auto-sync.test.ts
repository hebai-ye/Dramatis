import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AutoSyncResult, createAutoSync } from './auto-sync.js';

describe('createAutoSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('第一次请求立刻跑，不等节流窗口', async () => {
    const run = vi.fn(async () => {});
    const auto = createAutoSync({ run, intervalMs: 20_000 });

    auto.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('窗口内的请求合并成一趟，并在窗口结束时补一次', async () => {
    const run = vi.fn(async () => {});
    const auto = createAutoSync({ run, intervalMs: 20_000 });

    auto.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    // 一轮对话里连着写了好几次（消息、记忆、情绪）
    vi.advanceTimersByTime(1_000);
    auto.request();
    auto.request();
    auto.request();
    expect(run).toHaveBeenCalledTimes(1);
    expect(auto.isPending()).toBe(true);

    // 走到窗口末尾才补这一趟，而不是每次都推
    await vi.advanceTimersByTimeAsync(19_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(auto.isPending()).toBe(false);
  });

  it('同步跑着的时候来的请求，结束后再补一趟而不是并发跑', async () => {
    const gates: Array<() => void> = [];
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          gates.push(resolve);
        }),
    );
    const auto = createAutoSync({ run, intervalMs: 20_000 });

    auto.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    auto.request();
    auto.request();
    expect(run).toHaveBeenCalledTimes(1);

    gates[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    // 补的那一趟被节流挡住，排在窗口末尾
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('失败不重试，但会如实回调；下一轮请求照样能跑', async () => {
    const results: AutoSyncResult[] = [];
    const run = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValue(undefined);
    const auto = createAutoSync({ run, intervalMs: 20_000, onResult: (result) => results.push(result) });

    auto.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(results[0]).toEqual({ ok: false, error: 'Failed to fetch', manual: false });
    expect(auto.isPending()).toBe(false);

    // 失败之后的 20 秒内不再自动重试
    await vi.advanceTimersByTimeAsync(19_000);
    expect(run).toHaveBeenCalledTimes(1);

    auto.request();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(results[1]).toEqual({ ok: true, error: null, manual: false });
  });

  it('手动 flush 不等节流，并且清掉排着的那一趟', async () => {
    const run = vi.fn(async () => {});
    const auto = createAutoSync({ run, intervalMs: 20_000 });

    auto.request();
    await vi.advanceTimersByTimeAsync(0);
    auto.request();
    expect(auto.isPending()).toBe(true);

    await auto.flush();
    expect(run).toHaveBeenCalledTimes(2);
    expect(auto.isPending()).toBe(false);
  });

  it('cancel 之后排着的那一趟不会跑', async () => {
    const run = vi.fn(async () => {});
    const auto = createAutoSync({ run, intervalMs: 20_000 });

    auto.request();
    await vi.advanceTimersByTimeAsync(0);
    auto.request();
    auto.cancel();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('busy 状态只在真正跑的时候为真', async () => {
    const states: boolean[] = [];
    const auto = createAutoSync({
      run: async () => {},
      intervalMs: 20_000,
      onBusyChange: (busy) => states.push(busy),
    });

    auto.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual([true, false]);
  });
});
