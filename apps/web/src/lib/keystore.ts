import { createMemoryKeyStore, hasVault, type KeyStore, openVault, readVault, type VaultStorage } from '@dramatis/core';
import { createSerialQueue, withCrossTabLock } from './sync-queue';

/**
 * 密钥存储模式（ROADMAP P2-8）。
 *
 * 三档（第三档是顺序 10）：
 * - `session`：只存在内存里，关掉页面就要重填，最安全
 * - `device`：明文存在浏览器本地，最方便也最弱
 * - `encrypted`：用用户自己定的一句口令加密后落在本地（P2-8）
 *
 * UI 必须把当前档位明确展示给用户，不能让人以为自己填的 Key 受到了保护。
 */
export type KeyStorageMode = 'session' | 'device' | 'encrypted';

const STORAGE_KEY = 'dramatis.keys.v1';
/** 口令库（密文）放这儿：与明文那档**不同的键**，两者不会互相覆盖。 */
const VAULT_KEY = 'dramatis.vault.v1';
const browserVaultQueue = createSerialQueue();

function runBrowserVaultMutation<T>(task: () => Promise<T>): Promise<T> {
  return browserVaultQueue.run(() => withCrossTabLock('dramatis-key-vault', task));
}

/** 浏览器里的口令库文件。 */
const vaultStorage: VaultStorage = {
  runExclusive: runBrowserVaultMutation,
  async read() {
    try {
      return localStorage.getItem(VAULT_KEY);
    } catch {
      return null;
    }
  },
  async write(value) {
    localStorage.setItem(VAULT_KEY, value);
  },
  async remove() {
    localStorage.removeItem(VAULT_KEY);
  },
};

export function browserVaultStorage(): VaultStorage {
  return vaultStorage;
}

function readAll(strict = false): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (
      strict &&
      (typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed) ||
        Object.values(parsed).some((value) => typeof value !== 'string'))
    ) {
      throw new Error('本机密钥缓存格式无法识别，请检查浏览器存储后重试。');
    }
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch (error) {
    if (strict) throw error;
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

/**
 * 硬删除账户时清掉这些 ref 的本机缓存。
 *
 * 两个地方都要看：明文档在 `dramatis.keys.v1`，口令档在 `dramatis.vault.v1`。
 * 口令库不需要口令也能删条目。删除路径必须明确确认读取、写入成功；
 * 失败由账户待删队列保留并重试，不沿用普通保存的会话降级策略。
 */
export function removeBrowserKeyRefs(refs: readonly string[]): Promise<void> {
  const unique = [...new Set(refs)].filter((ref) => ref !== '');
  if (unique.length === 0) return Promise.resolve();
  return runBrowserVaultMutation(() => removeBrowserKeyRefsLocked(unique));
}

async function removeBrowserKeyRefsLocked(unique: readonly string[]): Promise<void> {
  let vaultSnapshot: string | null = null;
  const strictVaultStorage: VaultStorage = {
    async read() {
      const value = localStorage.getItem(VAULT_KEY);
      vaultSnapshot = value;
      if (value !== null && value.trim() !== '') {
        const record = JSON.parse(value) as { secrets?: unknown } | null;
        if (
          record === null ||
          typeof record.secrets !== 'object' ||
          record.secrets === null ||
          Array.isArray(record.secrets)
        ) {
          throw new Error('本机口令库条目无法读取，账户清理未完成。');
        }
      }
      return value;
    },
    write: vaultStorage.write,
  };
  // readVault 的接口异步、底层 localStorage 同步。等待后若文件变了就验证
  // 最新版本，不能把验证前的快照写回覆盖其他标签页新保存的引用。
  let file: Awaited<ReturnType<typeof readVault>> = null;
  let stable = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    file = await readVault(strictVaultStorage);
    if (localStorage.getItem(VAULT_KEY) === vaultSnapshot) {
      stable = true;
      break;
    }
  }
  if (!stable) throw new Error('本机口令库正在被其他页面修改，账户清理未完成，请稍后重试。');
  if (file !== null && (typeof navigator === 'undefined' || typeof navigator.locks?.request !== 'function')) {
    throw new Error('此浏览器不支持安全清理口令库。请关闭其他标签页，换用支持清理锁的浏览器后重试。');
  }
  // 从这里到两个提交之间没有 await；明文缓存也必须使用所有异步读取结束后的最新值。
  const raw = localStorage.getItem(STORAGE_KEY);
  const parsed: unknown = raw === null ? {} : JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('本机密钥缓存格式无法识别，账户清理未完成。');
  }
  const all = parsed as Record<string, string>;
  let plainChanged = false;
  for (const ref of unique) {
    if (Object.hasOwn(all, ref)) {
      delete all[ref];
      plainChanged = true;
    }
  }
  if (plainChanged) localStorage.setItem(STORAGE_KEY, JSON.stringify(all));

  if (file !== null) {
    let vaultChanged = false;
    for (const ref of unique) {
      if (Object.hasOwn(file.secrets, ref)) {
        delete file.secrets[ref];
        vaultChanged = true;
      }
    }
    if (vaultChanged) {
      if (localStorage.getItem(VAULT_KEY) !== vaultSnapshot) {
        throw new Error('本机口令库已被其他页面修改，账户清理未完成，请稍后重试。');
      }
      localStorage.setItem(VAULT_KEY, JSON.stringify(file));
    }
  }
}

function createDeviceKeyStore(strictRead = false): KeyStore {
  return {
    kind: 'plain',
    async get(ref) {
      return readAll(strictRead)[ref] ?? null;
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

/** 解开的那个口令库（一次解锁、本次会话内复用；Providers 里持有它）。 */
export interface VaultSession {
  store: KeyStore;
  /** 解锁用的口令：切档位/写新条时要再写一遍文件，得留着。 */
  passphrase: string;
}

export function createBrowserKeyStore(
  mode: KeyStorageMode,
  vault: VaultSession | null = null,
  options: { strictRead?: boolean } = {},
): KeyStore {
  if (mode === 'session') return createMemoryKeyStore();
  if (mode === 'device') return createDeviceKeyStore(options.strictRead === true);
  if (vault !== null) return vault.store;

  /*
   * 选了口令加密、但这次会话还没解锁。
   *
   * 不抛错、也不假装能用：给一个「空的、写不进去」的 KeyStore——
   * 读出来是空（界面会显示成「还没填」，并且旁边摆着解锁入口），
   * 写入被拒并且说清原因。这样不会把用户的 Key 悄悄写进明文那档去。
   */
  return {
    kind: 'encrypted',
    async get() {
      return null;
    },
    async set() {
      throw new Error('口令库还没解锁：先在上面输入口令并解锁，再保存。');
    },
    async remove() {},
    async list() {
      return [];
    },
    async clear() {},
  };
}

/** 本机有没有口令库（不需要口令）。 */
export function hasBrowserVault(): Promise<boolean> {
  return hasVault(vaultStorage);
}

/** 用口令打开本机的口令库。口令不对时抛错（错误信息是给人看的）。 */
export async function openBrowserVault(passphrase: string): Promise<VaultSession> {
  const store = await openVault(vaultStorage, passphrase);
  return { store, passphrase };
}

export function describeKeyStore(kind: KeyStore['kind']): string {
  switch (kind) {
    case 'memory':
      return '仅本次会话，关闭页面后需要重新填写';
    case 'plain':
      return '明文保存在本机浏览器，关闭页面后仍可读取；账户同步传输的是密文。';
    case 'encrypted':
      return '口令加密后保存在本机：盘上是密文，每次打开应用要用口令解锁（忘记就只能重填 Key）';
    case 'os':
      return '保存在系统凭据管理器';
    default:
      return kind;
  }
}
