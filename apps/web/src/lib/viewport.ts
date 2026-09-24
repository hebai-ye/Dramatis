import { useEffect, useState } from 'react';

/** 窄屏断点：到这一档就把左栏收成抽屉（ROADMAP P2-1）。 */
export const NARROW_SCREEN_QUERY = '(max-width: 640px)';

/**
 * 粗指针 + 无悬停：手机/平板上的软键盘与触摸输入。
 *
 * 不用宽度判断：手机横屏时宽度可能超过 640px，但输入习惯还是「回车换行，
 * 点发送按钮」。匹配不到时浏览器会自动忽略这段查询，桌面照旧。
 */
export const COARSE_POINTER_QUERY = '(hover: none) and (pointer: coarse)';

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

export function useCoarsePointer(query: string = COARSE_POINTER_QUERY): boolean {
  const [coarse, setCoarse] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);

  useEffect(() => {
    const list = window.matchMedia(query);
    const update = (): void => setCoarse(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);

  return coarse;
}
