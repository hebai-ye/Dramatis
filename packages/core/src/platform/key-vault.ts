/**
 * 口令加密的密钥库（顺序 10，ROADMAP P2-8）。
 *
 * 背景：到这一版为止，用户填的 API Key 只有两档去处——
 * 「只在这次会话的内存里」和「明文躺在 localStorage」。默认那档现在是后者
 * （P0 改的：点保存就该留住），于是「能改这个网页的人就能读到你填的 Key」
 * 成了整条链上最弱的一环。
 *
 * 这一版给出第三档：**用一句自己定的口令把 Key 加密后落盘**。
 *
 * ```
 * 口令 ──PBKDF2-SHA256(600k, 随机盐)──▶ KEK ──AES-256-GCM──▶ { iv, ciphertext }
 * ```
 *
 * 三条设计约束，都是有代价才定下来的：
 *
 * 1. **不做「忘记口令」的恢复路**。恢复走的是另一条（同步密码 / 恢复码），
 *    本地这份只是「本机方便」。想不起来就重填一次 Key——代价明确，
 *    好过在这里偷偷留一把备用钥匙（那等于没加密）。
 * 2. **文件里放一段已知明文**（`check`）。否则「口令错了」和「库是空的」
 *    在界面上是同一种表现，用户会以为自己的 Key 丢了。它加密的是常量，
 *    解不出就是口令不对——不泄露任何东西（GCM 认证失败也算不出明文）。
 * 3. **AAD 绑 ref**。把 A 的密文挪到 B 的位置解不开，
 *    服务端/本地脚本改不动条目之间的对应关系。
 */

import { fromBase64Url, fromUtf8, randomBytes, subtle, toBase64Url, utf8 } from '../crypto/encoding.js';
import { CryptoError } from '../crypto/errors.js';
import type { KeyStore } from './key-store.js';

/** 文件形状的版本号：将来换算法时靠它分流。 */
export const VAULT_VERSION = 1;

/**
 * 口令派生的迭代数。
 *
 * 与同步密码同档（`SYNC_KEY_ITERATIONS`）：都是「人想得出来的一句话」，
 * 都值得同样的成本。慢一点的代价只在解锁那一次，不在每次请求上。
 */
export const VAULT_KDF_ITERATIONS = 600_000;

/**
 * 从文件里读到的迭代数上限（审计 C14）。
 *
 * 迭代数存在文件里（将来调高默认值时，老文件照样按自己的数解）。但文件能被别的程序改：
 * 改成十亿次，解锁那一下就把页面卡死。默认值的 10 倍已经远超任何正常取值。
 */
export const VAULT_MAX_KDF_ITERATIONS = VAULT_KDF_ITERATIONS * 10;

export const VAULT_ALGORITHM = 'AES-256-GCM';

const VAULT_KIND = 'dramatis-key-vault';
const IV_BYTES = 12;
/** 用来验证口令的常量明文：它本身不是秘密。 */
const CHECK_PLAINTEXT = 'dramatis.key-vault.check';

/** 落在磁盘上的那份（存储层只认字符串，浏览器用 localStorage）。 */
export interface VaultFile {
  kind: typeof VAULT_KIND;
  version: number;
  kdf: { algorithm: 'PBKDF2-SHA256'; iterations: number; salt: string };
  check: { iv: string; ciphertext: string };
  secrets: Record<string, { iv: string; ciphertext: string }>;
}

/** 存放那份文件的地方（浏览器给 localStorage，测试给一个字符串变量）。 */
export interface VaultStorage {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove?(): Promise<void>;
}

export interface VaultOptions {
  /** 测试用：把迭代数调小。 */
  iterations?: number;
}

function aad(suffix: string): Uint8Array<ArrayBuffer> {
  return utf8(`dramatis:key-vault:${suffix}`);
}

async function deriveKek(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  if (passphrase.trim() === '') throw new CryptoError('口令不能为空。');
  const material = await subtle().importKey('raw', utf8(passphrase), 'PBKDF2', false, ['deriveBits']);
  const derived = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, 256);
  return subtle().importKey('raw', derived, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function seal(key: CryptoKey, suffix: string, plaintext: string): Promise<{ iv: string; ciphertext: string }> {
  const iv = randomBytes(IV_BYTES);
  const sealed = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(suffix), tagLength: 128 },
    key,
    utf8(plaintext),
  );
  return { iv: toBase64Url(iv), ciphertext: toBase64Url(new Uint8Array(sealed)) };
}

async function openSecret(key: CryptoKey, suffix: string, box: { iv: string; ciphertext: string }): Promise<string> {
  const opened = await subtle().decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(box.iv), additionalData: aad(suffix), tagLength: 128 },
    key,
    fromBase64Url(box.ciphertext),
  );
  return fromUtf8(new Uint8Array(opened));
}

function isBox(value: unknown): value is { iv: string; ciphertext: string } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.iv === 'string' && typeof record.ciphertext === 'string';
}

/** 读那份文件。没有文件返回 null；**文件坏了要抛错**（不能当成空库把用户的东西盖掉）。 */
export async function readVault(storage: VaultStorage): Promise<VaultFile | null> {
  const raw = await storage.read();
  if (raw === null || raw.trim() === '') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CryptoError('口令库文件读不出来（不是合法 JSON）。它可能被别的程序改过。');
  }

  const record = parsed as Partial<VaultFile> | null;
  if (record === null || record.kind !== VAULT_KIND || !isBox(record.check) || typeof record.kdf !== 'object') {
    throw new CryptoError('口令库文件的格式不认识。');
  }
  const iterations = record.kdf.iterations ?? VAULT_KDF_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > VAULT_MAX_KDF_ITERATIONS) {
    throw new CryptoError('口令库文件里的迭代数不合理（可能被别的程序改过），拒绝解锁。');
  }
  return {
    kind: VAULT_KIND,
    version: typeof record.version === 'number' ? record.version : VAULT_VERSION,
    kdf: {
      algorithm: 'PBKDF2-SHA256',
      iterations,
      salt: record.kdf.salt ?? '',
    },
    check: record.check,
    secrets: typeof record.secrets === 'object' && record.secrets !== null ? record.secrets : {},
  };
}

/** 有没有口令库（不用口令就能知道——界面得先判断该显示「解锁」还是「设置口令」）。 */
export async function hasVault(storage: VaultStorage): Promise<boolean> {
  return (await readVault(storage)) !== null;
}

/** 库里存了哪几个条目（同样不需要口令）。 */
export async function vaultRefs(storage: VaultStorage): Promise<string[]> {
  const file = await readVault(storage);
  return file === null ? [] : Object.keys(file.secrets);
}

/** 新建一个空口令库（已存在时**直接抛错**：绝不悄悄覆盖别人的钥匙）。 */
export async function createVault(
  storage: VaultStorage,
  passphrase: string,
  options: VaultOptions = {},
): Promise<void> {
  if (await hasVault(storage)) throw new CryptoError('已经有一个口令库了；要换口令请先用旧口令打开。');

  const iterations = options.iterations ?? VAULT_KDF_ITERATIONS;
  const salt = randomBytes(16);
  const kek = await deriveKek(passphrase, salt, iterations);
  const file: VaultFile = {
    kind: VAULT_KIND,
    version: VAULT_VERSION,
    kdf: { algorithm: 'PBKDF2-SHA256', iterations, salt: toBase64Url(salt) },
    check: await seal(kek, 'check', CHECK_PLAINTEXT),
    secrets: {},
  };
  await storage.write(JSON.stringify(file));
}

/** 用口令打开一个库，拿到一个正常的 `KeyStore`（kind 是 `encrypted`）。 */
export async function openVault(
  storage: VaultStorage,
  passphrase: string,
  options: VaultOptions = {},
): Promise<KeyStore> {
  const file = await readVault(storage);
  if (file === null) throw new CryptoError('本机还没有口令库。');

  const kek = await deriveKek(
    passphrase,
    fromBase64Url(file.kdf.salt),
    file.kdf.iterations ?? options.iterations ?? VAULT_KDF_ITERATIONS,
  );
  try {
    const marker = await openSecret(kek, 'check', file.check);
    if (marker !== CHECK_PLAINTEXT) throw new CryptoError('口令不对。');
  } catch (error) {
    if (error instanceof CryptoError && error.message === '口令不对。') throw error;
    throw new CryptoError('口令不对，或者这个口令库坏了。');
  }

  /** 每次改动都整份重写：文件很小（几条 Key），换来的是「不会写坏一半」。 */
  const persist = async (next: VaultFile): Promise<void> => {
    await storage.write(JSON.stringify(next));
  };

  /**
   * 写入串行化（审计 C14）：每次改动都是「读整份 → 改一条 → 写整份」，两次并发的 set
   * 会各自读到旧文件、后写的把先写的那条抹掉。所有改动排进同一条队列（按 storage 共享，
   * 同一个库被打开两次也一样排队）；一次失败不堵住后面的。
   */
  const mutate = (change: (current: VaultFile) => Promise<boolean>): Promise<boolean> => {
    const previous = writeQueues.get(storage) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const current = await readVault(storage);
        if (current === null) return false;
        if (await change(current)) await persist(current);
        return true;
      });
    writeQueues.set(storage, next);
    return next;
  };

  return {
    kind: 'encrypted',
    async get(ref) {
      const current = await readVault(storage);
      const box = current?.secrets[ref];
      if (!isBox(box)) return null;
      try {
        return await openSecret(kek, `secret:${ref}`, box);
      } catch {
        // 单条解不开（文件被改过）不该让整个界面挂掉：当成「没有这条」
        return null;
      }
    },
    async set(ref, secret) {
      const sealed = await seal(kek, `secret:${ref}`, secret);
      const found = await mutate(async (current) => {
        current.secrets[ref] = sealed;
        return true;
      });
      if (!found) throw new CryptoError('本机还没有口令库。');
    },
    async remove(ref) {
      await mutate(async (current) => {
        if (!(ref in current.secrets)) return false;
        delete current.secrets[ref];
        return true;
      });
    },
    async list() {
      return vaultRefs(storage);
    },
    async clear() {
      await mutate(async (current) => {
        current.secrets = {};
        return true;
      });
    },
  };
}

/** 每个存储一条写入队列（见 `mutate`）。WeakMap：存储对象没了队列跟着回收。 */
const writeQueues = new WeakMap<VaultStorage, Promise<boolean>>();
