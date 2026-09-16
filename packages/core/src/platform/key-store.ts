/**
 * 密钥存储（设计文档 §8.3，ROADMAP P2-8）。
 *
 * Web 拿不到 OS 级凭据管理器，所以这里定义的是「能力接口」，
 * 具体安全级别由实现声明。UI 必须把 `kind` 展示给用户——
 * 让用户知道自己的 Key 现在是什么保护级别，是这层的设计目的之一。
 */
export type KeyStoreKind =
  /** 仅存在于内存，关闭即丢失。最安全，也最麻烦。 */
  | 'memory'
  /** 明文存在浏览器本地。最方便，最弱。 */
  | 'plain'
  /** 口令派生密钥加密后落盘。 */
  | 'encrypted'
  /** OS 级凭据存储，只有桌面壳或安卓壳能提供。 */
  | 'os';

export interface KeyStore {
  readonly kind: KeyStoreKind;
  get(ref: string): Promise<string | null>;
  set(ref: string, secret: string): Promise<void>;
  remove(ref: string): Promise<void>;
  list(): Promise<string[]>;
  clear(): Promise<void>;
}

/** 仅会话内保存，用于「不保存 Key」这一档，也用于测试。 */
export function createMemoryKeyStore(): KeyStore {
  const secrets = new Map<string, string>();

  return {
    kind: 'memory',
    async get(ref) {
      return secrets.get(ref) ?? null;
    },
    async set(ref, secret) {
      secrets.set(ref, secret);
    },
    async remove(ref) {
      secrets.delete(ref);
    },
    async list() {
      return [...secrets.keys()];
    },
    async clear() {
      secrets.clear();
    },
  };
}
