import { useEffect, useState } from 'react';

/** 窄屏断点：到这一档就把左栏收成抽屉（ROADMAP P2-1）。 */
export const NARROW_SCREEN_QUERY = '(max-width: 640px)';

/**
 * 是不是窄屏。
 *
 * 用 `matchMedia` 而不是监听 `resize`：只在**跨过断点**时重渲染一次，
 * 拖窗口大小的时候不会每帧都算一遍 React 树。
 */
export function useNarrowScreen(query: string = NARROW_SCREEN_QUERY): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);

  useEffect(() => {
    const list = window.matchMedia(query);
    const update = (): void => setNarrow(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);

  return narrow;
}

/**
 * 全屏（用户反馈：手机上浏览器的顶栏与底栏占掉太多地方）。
 *
 * 两条路，效果不一样，界面要分开说：
 *
 * 1. **装成应用**（PWA，`display: standalone`）——没有地址栏、没有底部工具栏，真全屏，
 *    而且顺手更容易拿到持久化存储。首选，但要用户点一次「安装」。
 * 2. **全屏 API**（下面这个 hook）——当场把浏览器 UI 藏起来，适合还没装的场景。
 *    iOS Safari 不支持元素级全屏（只有视频能），所以 iPhone 上只能走第一条。
 */
export interface FullscreenApi {
  active: boolean;
  supported: boolean;
  enter: () => Promise<void>;
  exit: () => Promise<void>;
}

interface FullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void>;
}

interface FullscreenDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void>;
}

export function useFullscreen(): FullscreenApi {
  const [active, setActive] = useState(() => typeof document !== 'undefined' && document.fullscreenElement !== null);

  useEffect(() => {
    const update = (): void => {
      const doc = document as FullscreenDocument;
      setActive((doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null) !== null);
    };
    update();
    document.addEventListener('fullscreenchange', update);
    document.addEventListener('webkitfullscreenchange', update);
    return () => {
      document.removeEventListener('fullscreenchange', update);
      document.removeEventListener('webkitfullscreenchange', update);
    };
  }, []);

  const root = typeof document === 'undefined' ? null : (document.documentElement as FullscreenElement);
  const supported =
    root !== null &&
    (typeof root.requestFullscreen === 'function' || typeof root.webkitRequestFullscreen === 'function');

  const enter = async (): Promise<void> => {
    if (root === null) return;
    if (typeof root.requestFullscreen === 'function') await root.requestFullscreen();
    else if (typeof root.webkitRequestFullscreen === 'function') await root.webkitRequestFullscreen();
  };

  const exit = async (): Promise<void> => {
    const doc = document as FullscreenDocument;
    if (typeof doc.exitFullscreen === 'function') await doc.exitFullscreen();
    else if (typeof doc.webkitExitFullscreen === 'function') await doc.webkitExitFullscreen();
  };

  return { active, supported, enter, exit };
}
