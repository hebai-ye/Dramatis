import { type RefObject, useLayoutEffect, useState } from 'react';

/** 230px list + 20px gap + 420px usable editor. Measures workspace content, not viewport. */
const LIBRARY_COLUMNS_MIN_WIDTH = 670;
export function useContainerCompact(ref: RefObject<HTMLElement | null>): boolean {
  const [compact, setCompact] = useState(true);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const update = (width: number) => {
      // Hidden visited editors have no width; retain their last usable layout until shown.
      if (width > 0) setCompact(width < LIBRARY_COLUMNS_MIN_WIDTH);
    };
    const measure = () => {
      const style = window.getComputedStyle(element);
      update(
        element.getBoundingClientRect().width -
          (Number.parseFloat(style.paddingLeft) || 0) -
          (Number.parseFloat(style.paddingRight) || 0),
      );
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) update(entry.contentRect.width);
      });
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [ref]);
  return compact;
}
