/**
 * 桥接进度不丢（顺序 25）。
 *
 * 网页版桥接要用户「复制出去、贴回来」——刷新一次就白贴一遍，那太欺负人了。
 * 所以把桥接状态存在 **sessionStorage**（同一个标签页内、刷新也在；关掉标签页就清），
 * 界面打开时自动接回上一步。
 *
 * 为什么不用 localStorage：它是「这台设备长期的事实」，而半截的桥接进度只属于这一次会话。
 * 关掉标签页还留着「等你贴回来」会让人困惑。
 */
const PREFIX = 'dramatis.bridge.v1:';

export function loadBridge<T>(slot: 'main' | 'admin'): T | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + slot);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

export function saveBridge(slot: 'main' | 'admin', value: unknown): void {
  try {
    if (value === null || value === undefined) sessionStorage.removeItem(PREFIX + slot);
    else sessionStorage.setItem(PREFIX + slot, JSON.stringify(value));
  } catch {
    // 隐私模式下写不进去：不影响这次会话的桥接，只是刷新后要重贴
  }
}
