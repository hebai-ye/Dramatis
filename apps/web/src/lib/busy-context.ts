import { createContext, useContext } from 'react';

/**
 * 「正在生成」这个开关（顺序 91）。
 *
 * 顺序 59 把它当 prop 一条条传下去，用来禁用消息上的重抽 / 编辑 / 删除。问题是它每轮翻转
 * 两次（开始、结束），而它是 `MessageList` → `MessageItem` 的 prop：两次翻转各让整张消息表
 * 重画一遍，几百条消息连 `renderMessageContent` 一起重跑——顺序 62 量到的一轮「4 次整表
 * 重画」里有两次就是它，当时留下的下一步是「把 `busy` 从每条消息的 prop 里拿掉（改成
 * context 或只让按钮自己订阅）」。
 *
 * 现在按那条留的活办了：`busy` 只走 context，订阅它的只有按钮那一小块（`RowActions`），
 * 翻转时 `MessageItem` / `MessageBody` 的 `memo` 都能真的跳过。这是应用里第一个 context，
 * `busy` 是唯一值得为它开一个的 prop：它变、而几千条消息都不该变。
 *
 * 默认 `false`：在 Provider 外面（比如测试里单画一条消息）按钮就是可用的。
 */
export const BusyContext = createContext(false);

export function useBusy(): boolean {
  return useContext(BusyContext);
}
