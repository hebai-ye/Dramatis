export interface Settings {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  /** 模型上下文窗口。 */
  maxTokens: number;
  /** 为回复预留的空间。 */
  reserveForReply: number;
  playerName: string;
}

const STORAGE_KEY = 'dramatis.settings.v1';

export const defaultSettings: Settings = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.9,
  maxTokens: 16384,
  reserveForReply: 1024,
  playerName: '玩家',
};

/**
 * M0 的设置持久化。
 *
 * 注意：API Key 存在 localStorage，这是为了让 M0 先跑起来。
 * 设计文档 §8.3 要求最终落到设备安全存储（Keychain / Keystore / DPAPI），
 * 那是 M4 的任务。
 */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { ...defaultSettings };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...defaultSettings, ...parsed };
  } catch {
    return { ...defaultSettings };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 隐私模式下 localStorage 可能不可用，静默降级为仅内存保存
  }
}
