/**
 * 本地助手（顺序 38）。
 *
 * 网页版桥接原本是「复制提示词 → 贴进模型网页 → 复制回复 → 贴回来」。这条路能用，
 * 但一轮四下点击加两次切换标签页，长期用下来很累。本地助手把中间那几步自动化：
 * 一个跑在**你自己机器上**的小进程，用 Chrome 的调试端口驱动你已经登录的那个标签页。
 *
 * ```
 * 网页（https://dramatissync.com）  ──fetch──▶  http://127.0.0.1:8791/ask
 *                                                   └─CDP─▶ 你自己的 Chrome 里的模型网页
 * ```
 *
 * 三件必须说清楚的事：
 *
 * 1. **默认不用**。没起那个进程时这里静默退化成「没有助手」，界面照旧走手动粘贴；
 * 2. **只连本机**（`127.0.0.1`），提示词与回复不经过任何第三方；
 * 3. **它不是官方接口**——驱动的是网页本身，条款风险由用户自己判断（README 里写了一整段）。
 */

/** 助手默认端口。改端口就用 `--port` 起它，同时改这里。 */
const HELPER_URL = 'http://127.0.0.1:8791';

export interface LocalBridgeStatus {
  /** 助手进程在不在。 */
  reachable: boolean;
  /** 那个模型网页的标签页找没找到（找到了才真的能自动发）。 */
  attached: boolean;
  /** 没连上时给人看的一句话。 */
  hint?: string;
}

/** 探一次（不轮询）。任何失败都当成「没有助手」，不打扰用户。 */
export async function probeLocalBridge(timeoutMs = 1200): Promise<LocalBridgeStatus> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`${HELPER_URL}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return { reachable: false, attached: false };
    const body = (await response.json()) as { attached?: boolean; hint?: string };
    return {
      reachable: true,
      attached: body.attached === true,
      ...(body.hint === undefined ? {} : { hint: body.hint }),
    };
  } catch {
    return { reachable: false, attached: false };
  }
}

/** 让助手发一轮。返回模型网页上的回复文字。 */
export async function askLocalBridge(prompt: string, timeoutMs = 240_000): Promise<string> {
  const response = await fetch(`${HELPER_URL}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, timeoutMs }),
  });
  const body = (await response.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!response.ok) throw new Error(body.error ?? `本地助手回了 ${String(response.status)}。`);
  return typeof body.text === 'string' ? body.text : '';
}
