import { useEffect, useState } from 'react';
import { QUOTA_WARN_RATIO } from '../lib/storage';

/** 一条可以堆叠给用户看的提示（与 App 里原来那个 `Notice` 同一个形状）。 */
export interface Notice {
  code: string;
  message: string;
  action?: { label: string; run: () => void };
}

/**
 * 界面上所有「要说给用户听的话」（顺序 66 从 App.tsx 里搬出来）。
 *
 * 四类来源合一：
 * - `error`：这一轮/这次导入失败的那句话（标题栏与列表顶部都会显示）；
 * - `warnings`：可以堆叠的提示（导入时未识别的字段、存储快满、归档回滚了多少条…）；
 * - `installHint`：手机上「装到桌面」的引导，只出现一次，关掉就记进 localStorage；
 *
 * 为什么不把这些散在 App 里：它们各自有自己的读写点与清理时机（配额提醒只提醒一次、
 * 引导关掉要落盘），混在 1900 行的组件里既难看也容易漏。返回值刻意用**原来的名字**
 * （`error` / `setError` / `warnings` / `setWarnings` / `installHint`），这样调用点不用改。
 */

/** 关掉安装引导之后写在 localStorage 的键（与旧版一致，老用户不会被再提一次）。 */
const INSTALL_HINT_KEY = 'dramatis.installHint.dismissed';

export interface NoticesApi {
  error: string | null;
  setError: (message: string | null) => void;
  warnings: Notice[];
  setWarnings: (next: Notice[] | ((previous: Notice[]) => Notice[])) => void;
  installHint: boolean;
  /** 关掉「装到桌面」的引导（并记住，下次不再提）。 */
  dismissInstallHint: () => void;
}

export function useNotices(quotaRatio: number | null): NoticesApi {
  const [warnings, setWarnings] = useState<Notice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [installHint, setInstallHint] = useState(
    () => typeof window !== 'undefined' && window.localStorage.getItem(INSTALL_HINT_KEY) !== '1',
  );

  /*
   * 存储快满时提醒一次（P2-3）。
   *
   * 等到写不进去才说就晚了——那时候用户已经丢了一轮对话。所以到 80% 就提醒
   * 导出封存；同一个提醒只出现一次，用户点掉之后不再重复烦他。
   */
  useEffect(() => {
    if (quotaRatio === null || quotaRatio < QUOTA_WARN_RATIO) return;
    setWarnings((previous) =>
      previous.some((item) => item.code === 'quota')
        ? previous
        : [
            ...previous,
            {
              code: 'quota',
              message: `浏览器给本站的存储已经用掉约 ${String(Math.round(quotaRatio * 100))}%，再写可能失败。建议现在导出一份封存（设置 → 封存）。`,
            },
          ],
    );
  }, [quotaRatio]);

  const dismissInstallHint = (): void => {
    window.localStorage.setItem(INSTALL_HINT_KEY, '1');
    setInstallHint(false);
  };

  return { error, setError, warnings, setWarnings, installHint, dismissInstallHint };
}
