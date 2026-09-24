import { useEffect, useState } from 'react';
import type { WebBridgeState } from '../components/WebBridgePanel';
import { loadBridge, saveBridge } from '../lib/bridge-store';

/**
 * 网页版桥接的状态（顺序 66 从 App.tsx 里搬出来）。
 *
 * 非 null 表示「正等着用户把网页版的输出贴回来」：`reply` 阶段等角色回复，
 * `analysis` 阶段等这一轮的记忆与情绪。
 *
 * 进度落进 sessionStorage（顺序 25）：刷新或切后台回来之后还在原来的那一步。
 * 返回值用原来的名字，调用点不用改。
 */
export interface WebBridgeApi {
  bridge: WebBridgeState | null;
  setBridge: (next: WebBridgeState | null) => void;
}

export function useWebBridge(scope: 'main' | 'admin' = 'main'): WebBridgeApi {
  const [bridge, setBridge] = useState<WebBridgeState | null>(() => loadBridge<WebBridgeState>(scope));

  useEffect(() => {
    saveBridge(scope, bridge);
  }, [scope, bridge]);

  return { bridge, setBridge };
}
