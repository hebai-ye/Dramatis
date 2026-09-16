import { createMemoryKeyStore, type KeyStore } from '@dramatis/core';

/**
 * 密钥存储模式（ROADMAP P2-8）。
 *
 * P0 阶段提供两档：
 * - `session`：只存在内存里，关掉页面就要重填，最安全
 * - `device`：明文存在浏览器本地，最方便也最弱
 *
 * 「口令加密后落盘」是 P2-8 的内容。在那之前，UI 必须把当前档位
 * 明确展示给用户，不能让人以为自己填的 Key 受到了保护。
 */
export type KeyStorageMode = 'session' | 'device';

const STORAGE_KEY = 'dramatis.keys.v1';

function readAll(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeAll(values: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch {
    // 隐私模式或配额耗尽时退化为仅本次会话有效
  }
}

function createDeviceKeyStore(): KeyStore {
  return {
    kind: 'plain',
    async get(ref) {
      return readAll()[ref] ?? null;
    },
    async set(ref, secret) {
      const all = readAll();
      all[ref] = secret;
      writeAll(all);
    },
    async remove(ref) {
      const all = readAll();
      delete all[ref];
      writeAll(all);
    },
    async list() {
      return Object.keys(readAll());
    },
    async clear() {
      writeAll({});
    },
  };
}

export function createBrowserKeyStore(mode: KeyStorageMode): KeyStore {
  return mode === 'session' ? createMemoryKeyStore() : createDeviceKeyStore();
}

export function describeKeyStore(kind: KeyStore['kind']): string {
  switch (kind) {
    case 'memory':
      return '仅本次会话，关闭页面后需要重新填写';
    case 'plain':
      return '明文保存在本机浏览器，不参与同步，换设备需重填';
    case 'encrypted':
      return '口令加密后保存在本机';
    case 'os':
      return '保存在系统凭据管理器';
    default:
      return kind;
  }
}
