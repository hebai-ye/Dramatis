import { META_KEYS } from '@dramatis/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DramatisDb } from './db';

export interface UnlimitedPromptApi {
  /** 本机保存的正文；从没填过就是空串。 */
  text: string;
  /** 保存（空串即清空）。 */
  save: (next: string) => Promise<void>;
}

/**
 * 无限制模式的提示词正文（用户 2026-09-25）。
 *
 * **它是用户数据，不是构建产物**：存在本机库的 `meta` 里，所以永远不会被编译进
 * 公开可下载的网页包，也不会进 git（`prompt/unlimited.ts` 的注释里记了这件事的来龙去脉）。
 *
 * 代价是**不参与同步**（meta 全都不参与）：换一台设备要重新粘一次。想让它跟着账户走，
 * 得新开一个同步集合——那是协议改动，记在 TASKS 顺序 68b，按「同步是底线」单独做。
 */
export function useUnlimitedPrompt(db: DramatisDb | null): UnlimitedPromptApi {
  const [text, setText] = useState('');

  useEffect(() => {
    if (db === null) {
      setText('');
      return;
    }
    let cancelled = false;
    void (async () => {
      const stored = await db.repository.getMeta<string>(META_KEYS.unlimitedPrompt);
      if (!cancelled) setText(typeof stored === 'string' ? stored : '');
    })();
    return () => {
      cancelled = true;
    };
  }, [db]);

  const save = useCallback(
    async (next: string) => {
      if (db === null) return;
      await db.repository.setMeta(META_KEYS.unlimitedPrompt, next);
      setText(next);
    },
    [db],
  );

  // 返回对象要稳定（顺序 59）：它是 memo 组件的 prop，每次渲染新造一个就等于没 memo
  return useMemo(() => ({ text, save }), [text, save]);
}
