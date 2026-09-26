/**
 * 每轮结束后的自动同步（P2-6 的收尾项）。
 *
 * 现状是「启动时一次 + 用户手动按一次」。一轮聊完不动手就等于没同步：
 * 另一台设备要等到下次开应用才看得到。所以每轮结算之后排一次同步。
 *
 * 三件事必须同时成立，所以单独抽成一个可测的小状态机而不是散在界面里：
 *
 * 1. **节流**：一轮对话会连着写好几次（消息、记忆、情绪），每次写都请求同步
 *    就会连着推好几趟。所以两次自动同步之间有最小间隔，间隔内来的请求合并。
 * 2. **尾随补一次**：被节流挡掉的那些请求不能就这么丢了——否则最后一批背景写入
 *    （记忆通常在回复之后几秒才落库）永远赶不上这一趟，得等下一轮。
 * 3. **不重入**：正在同步时又来了请求，只在结束后再补一次，不并发跑两个循环
 *    （并发推送同一批记录会让服务端看到交错的 rev）。
 *
 * 失败**不重试**：同步失败会如实记在「上次结果」里，让用户手动重试。
 * 自动重试只会在网络断掉时把它变成一个后台刷屏的循环。
 */

export interface AutoSyncResult {
  ok: boolean;
  error: string | null;
  /** 这一趟是自动触发的还是手动 flush 的。 */
  manual: boolean;
}

export interface AutoSyncOptions {
  /** 真正跑一次同步；抛错表示这一趟没成。 */
  run: () => Promise<void>;
  /** 两次自动同步之间的最小间隔（默认 20 秒）。 */
  intervalMs?: number;
  /** 取当前时间，测试里换成假的。 */
  now?: () => number;
  /** 定时器，测试里换成假的。 */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** 每趟（含失败）都会回调一次。 */
  onResult?: (result: AutoSyncResult) => void;
  /** 正在同步的状态变化，界面拿它显示转圈。 */
  onBusyChange?: (busy: boolean) => void;
}

export interface AutoSync {
  /** 请求一次自动同步：立刻跑，或者排到节流窗口结束。 */
  request: () => void;
  /**
   * 不管节流，立刻跑一趟（手动「立即同步」用）。
   *
   * 正在跑的时候调用：**先等那一趟跑完，再补跑一趟**，两趟都完了才返回（审计 B1）。
   * 以前在运行中只记一笔「待补」就立刻返回，调用方以为已经同步完了。
   * 补跑那一趟失败时照样通过 `onResult` 回调，不从这里抛。
   */
  flush: () => Promise<void>;
  /** 有没有排着队的同步。 */
  isPending: () => boolean;
  /** 停掉排队的定时器（卸载/断开同步时用）。 */
  cancel: () => void;
}

const DEFAULT_INTERVAL_MS = 20_000;

export function createAutoSync(options: AutoSyncOptions): AutoSync {
  const intervalMs = Math.max(0, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const now = options.now ?? ((): number => Date.now());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  /** 上一次**真正跑完**的时刻；null 表示还没跑过（第一次请求不等）。 */
  let lastRunAt: number | null = null;
  let timer: unknown = null;
  let running = false;
  /** 正在跑的那一趟（flush 要等它）。 */
  let inFlight: Promise<void> | null = null;
  /** 运行期间又来了请求：结束后再补一趟。 */
  let dirty = false;

  const clearPending = (): void => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const runOnce = (manual: boolean): Promise<void> => {
    if (running && inFlight !== null) {
      dirty = true;
      return inFlight;
    }
    const current = execute(manual);
    inFlight = current;
    return current;
  };

  const execute = async (manual: boolean): Promise<void> => {
    running = true;
    options.onBusyChange?.(true);
    try {
      await options.run();
      lastRunAt = now();
      options.onResult?.({ ok: true, error: null, manual });
    } catch (error) {
      // 失败也记一次时刻：网络断着的时候不该每个请求都立刻重试
      lastRunAt = now();
      options.onResult?.({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        manual,
      });
    } finally {
      running = false;
      inFlight = null;
      options.onBusyChange?.(false);

      if (dirty) {
        dirty = false;
        schedule();
      }
    }
  };

  /** 排一趟：按节流窗口算还差多久。 */
  const schedule = (): void => {
    if (running) {
      dirty = true;
      return;
    }
    if (timer !== null) return;

    const wait = lastRunAt === null ? 0 : Math.max(0, lastRunAt + intervalMs - now());
    if (wait === 0) {
      void runOnce(false);
      return;
    }
    timer = setTimer(() => {
      timer = null;
      void runOnce(false);
    }, wait);
  };

  return {
    request: schedule,
    flush: async () => {
      clearPending();
      // 先等正在跑的那一趟（以及它结束时可能立刻补上的一趟）
      while (inFlight !== null) await inFlight;
      // 那一趟结束时可能排了一个节流定时器：手动这一趟就是它，别再多跑一次
      clearPending();
      dirty = false;
      await runOnce(true);
    },
    isPending: () => timer !== null || running || dirty,
    cancel: () => {
      clearPending();
      dirty = false;
    },
  };
}
