import { useCallback, useEffect, useState } from 'react';

/**
 * 外观偏好（主题 / 对话区背景 / 意图是否默认展开）。
 *
 * 为什么放 localStorage 而不是实体表：这是**这台设备、这块屏幕**的偏好，
 * 与「世界线」无关——手机想要浅色、桌面想要酒馆色是很正常的组合。
 * 它也天然不参与同步（同步白名单里没有它）。
 */

export type ThemeName = 'tavern' | 'light' | 'dark';

export interface Appearance {
  /** `tavern` 是原来的酒馆色调；`light` / `dark` 是白底蓝、黑底蓝。 */
  theme: ThemeName;
  /** 对话区背景图（data URL）。空串表示纯色。 */
  background: string;
  /** 背景强度（0~1）：图太亮会压住字，所以给个可调的旋钮。 */
  backgroundOpacity: number;
  /** 角色的心理意图是否默认展开（默认收起，用户要求）。 */
  showIntent: boolean;
}

const STORAGE_KEY = 'dramatis.appearance.v1';

/** 一张背景图的上限：localStorage 大约 5MB，还得留地方给别的。 */
export const BACKGROUND_MAX_BYTES = 2_500_000;

export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'tavern',
  background: '',
  backgroundOpacity: 0.85,
  showIntent: false,
};

export const THEME_LABELS: Record<ThemeName, { label: string; hint: string; swatch: [string, string] }> = {
  tavern: { label: '酒馆', hint: '当前的暖棕色调', swatch: ['#14110f', '#d9a441'] },
  light: { label: '浅色', hint: '白底 + 蓝（DeepSeek 官方那套）', swatch: ['#f7f8fa', '#4d6bfe'] },
  dark: { label: '深色', hint: '黑底 + 蓝', swatch: ['#0b0d10', '#4d6bfe'] },
};

function read(): Appearance {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_APPEARANCE;
    const parsed = JSON.parse(raw) as Partial<Appearance>;
    return {
      theme: parsed.theme === 'light' || parsed.theme === 'dark' ? parsed.theme : 'tavern',
      background: typeof parsed.background === 'string' ? parsed.background : '',
      backgroundOpacity:
        typeof parsed.backgroundOpacity === 'number' && parsed.backgroundOpacity >= 0 && parsed.backgroundOpacity <= 1
          ? parsed.backgroundOpacity
          : DEFAULT_APPEARANCE.backgroundOpacity,
      showIntent: parsed.showIntent === true,
    };
  } catch {
    // 隐私模式或坏数据：退回默认，别让外观问题把应用拦在门外
    return DEFAULT_APPEARANCE;
  }
}

export interface AppearanceApi {
  value: Appearance;
  patch: (values: Partial<Appearance>) => void;
  /** 读一张图当作背景；太大或不是图片时抛错（界面负责说人话）。 */
  setBackgroundFromFile: (file: File) => Promise<void>;
}

export function useAppearance(): AppearanceApi {
  const [value, setValue] = useState<Appearance>(() => read());

  // 主题放在 <html> 上：这样连 body 的背景色也跟着换，不会只换一半
  useEffect(() => {
    document.documentElement.dataset.theme = value.theme;
  }, [value.theme]);

  const persist = useCallback((next: Appearance) => {
    setValue(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // 存不下（配额满 / 隐私模式）：这次会话内照常生效，不打断用户
    }
  }, []);

  const patch = useCallback(
    (values: Partial<Appearance>) => {
      persist({ ...value, ...values });
    },
    [persist, value],
  );

  const setBackgroundFromFile = useCallback(
    async (file: File): Promise<void> => {
      if (!file.type.startsWith('image/')) throw new Error('这个文件不是图片。');
      if (file.size > BACKGROUND_MAX_BYTES) {
        throw new Error(
          `图片太大了（${Math.round(file.size / 1024)} KB）。${Math.round(BACKGROUND_MAX_BYTES / 1024)} KB 以内才能存在本机。`,
        );
      }
      const buffer = await file.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      }
      persist({ ...value, background: `data:${file.type};base64,${btoa(binary)}` });
    },
    [persist, value],
  );

  return { value, patch, setBackgroundFromFile };
}
