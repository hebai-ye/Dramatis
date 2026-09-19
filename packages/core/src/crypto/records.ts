/**
 * 记录级加解密（P2-6 第二步，对应 SYNC.md §3.3）。
 *
 * 同步的单位是**一条实体一条记录**（SYNC §4.1），所以加密也按条来：
 *
 * ```ts
 * const sealed = await encryptRecord(keys.encKey, { spaceHandle, collection, id, updatedAt }, message);
 * // 服务端存 { spaceHandle, collection, id, serverRev, ciphertext, iv, updatedAt, size }
 * const back = await decryptRecord<Message>(keys.encKey, { spaceHandle, collection, id, updatedAt }, sealed);
 * ```
 *
 * **AAD 绑定坐标**：`spaceHandle|collection|id|updatedAt` 既是加密时的附加数据，也是
 * 解密时的附加数据。服务端如果把 A 的记录挪到 B 的位置（改 collection、改 id、
 * 甚至换一个空间），解密会直接失败——密文被钉死在它自己的坐标上，而不是
 * 靠服务端自觉。`updatedAt` 也在里面，而且仓储层保证它**每条记录严格递增**，
 * 所以「拿同一 id 的旧密文顶替新版本」同样解不开。
 */

import { fromBase64Url, fromUtf8, randomBytes, subtle, toBase64Url, utf8 } from './encoding.js';
import { CryptoError } from './errors.js';

export const RECORD_ALGORITHM = 'AES-256-GCM';

/** GCM 推荐的 IV 长度（96 bit）。同一个密钥下 IV **绝不能重复**。 */
export const RECORD_IV_BYTES = 12;

/** 记录的坐标：服务端看得见的全部信息，也是 AAD 的来源。 */
export interface RecordCoordinates {
  /** 空间句柄（`deriveSpaceHandle` 的输出），不是用户填的那个 id。 */
  spaceHandle: string;
  /** 集合名，例如 `messages` / `memories`。 */
  collection: string;
  /** 实体 id（uuid）。 */
  id: string;
  /**
   * 这条记录的写入时间（实体的 `updatedAt`）。
   *
   * 为什么是它、不是服务端的版本号：客户端加密时还不知道服务端会分配哪个号
   * （SYNC §4.4 记了这个空隙）。`updatedAt` 是客户端自己盖的章、又随记录明文
   * 存在服务端，两边都拿得到，而且严格递增——既能防挪位置，也能防旧版本顶新版本。
   */
  updatedAt: string;
}

/**
 * 拼出 AAD。
 *
 * 用 `|` 分隔并要求四个字段本身不含 `|`：`collection` 与 `id` 是我们自己
 * 生成的（uuid / 固定集合名），`spaceHandle` 是 base64url，都不会带 `|`。
 * 分隔符一致就够——AAD 不要求能反解析，只要求**不同的坐标拼出不同的串**。
 */
export function recordAad(coordinates: RecordCoordinates): Uint8Array<ArrayBuffer> {
  return utf8([coordinates.spaceHandle, coordinates.collection, coordinates.id, coordinates.updatedAt].join('|'));
}

/** 服务端落库的那条记录（它看到的全部内容）。 */
export interface EncryptedRecord {
  algorithm: typeof RECORD_ALGORITHM;
  /** base64url。每条记录独立随机，绝不复用。 */
  iv: string;
  /** base64url 的密文（含 GCM 认证标签）。 */
  ciphertext: string;
}

export interface EncryptRecordOptions {
  /** 测试用：固定 IV 好断言；生产环境别传（默认每次随机）。 */
  iv?: Uint8Array<ArrayBuffer>;
}

/** 加密一条记录。载荷是任意 JSON 可序列化的实体。 */
export async function encryptRecord(
  encKey: CryptoKey,
  coordinates: RecordCoordinates,
  payload: unknown,
  options: EncryptRecordOptions = {},
): Promise<EncryptedRecord> {
  const iv = options.iv ?? randomBytes(RECORD_IV_BYTES);
  if (iv.byteLength !== RECORD_IV_BYTES) {
    throw new CryptoError(`IV 必须是 ${String(RECORD_IV_BYTES)} 字节，收到 ${String(iv.byteLength)}。`);
  }

  let plaintext: string;
  try {
    plaintext = JSON.stringify(payload);
  } catch (error) {
    throw new CryptoError(`这条记录没法序列化成 JSON：${(error as Error).message}`);
  }
  if (plaintext === undefined) {
    throw new CryptoError('这条记录没法序列化成 JSON（可能是 undefined 或函数）。');
  }

  const sealed = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: recordAad(coordinates), tagLength: 128 },
    encKey,
    utf8(plaintext),
  );

  return {
    algorithm: RECORD_ALGORITHM,
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(sealed)),
  };
}

/**
 * 解密一条记录。
 *
 * 失败一律给同一句人话：**解密失败只有两种原因**——钥匙不对（密码错/换了
 * 空间）或者密文被动过（坐标被挪、内容被改）。两者在密码学上分不开
 * （这正是 GCM 认证的意义），所以不编一个「具体是哪种」的假结论。
 */
export async function decryptRecord<T>(
  encKey: CryptoKey,
  coordinates: RecordCoordinates,
  record: EncryptedRecord,
): Promise<T> {
  if (record.algorithm !== RECORD_ALGORITHM) {
    throw new CryptoError(`不认识的加密算法：${String(record.algorithm)}。`);
  }

  const iv = fromBase64Url(record.iv);
  if (iv.byteLength !== RECORD_IV_BYTES) {
    throw new CryptoError(`IV 长度不对（${String(iv.byteLength)} 字节），这条记录可能被改过。`);
  }

  let opened: ArrayBuffer;
  try {
    opened = await subtle().decrypt(
      { name: 'AES-GCM', iv, additionalData: recordAad(coordinates), tagLength: 128 },
      encKey,
      fromBase64Url(record.ciphertext),
    );
  } catch {
    throw new CryptoError('解密失败：同步密码不对，或者这条记录在服务端被动过（坐标/内容被改）。');
  }

  try {
    return JSON.parse(fromUtf8(new Uint8Array(opened))) as T;
  } catch {
    throw new CryptoError('解密出来的内容不是合法的 JSON，这条记录可能损坏了。');
  }
}

/**
 * 一条记录的密文大小。
 *
 * 服务端要存 `size` 做配额与诊断（SYNC §3.3），所以这里给一个与实现一致的
 * 口径：**密文与 IV 的字节数之和**，不把 base64 的膨胀算进去。
 */
export function recordSize(record: EncryptedRecord): number {
  return fromBase64Url(record.iv).byteLength + fromBase64Url(record.ciphertext).byteLength;
}
