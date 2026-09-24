/**
 * 空间的钥匙与凭证（P2-6 第二步，对应 SYNC.md §3.1 修订 + §3.3）。
 *
 * 四条线，一条都别混：
 *
 * ```
 * 用户填的 id ──PBKDF2(固定盐, 100k)──→ spaceHandle          （服务端只认这个）
 * 同步密码 / 恢复码 ──PBKDF2(盐=handle|用途, 600k)──┬─→ authKey ─ HMAC → 凭证（Bearer）
 *                                                 └─→ keyEncryptionKey（只用来包/解主密钥）
 * 随机主密钥 encKey ── 用密码包一份、用恢复码包一份，两份都存服务端
 * ```
 *
 * **主密钥为什么是随机的，而不是从密码直接派生**（原方案写的是后者，这里改了，
 * 偏差记在 SYNC §3.3）：
 *
 * 记录密文是用 `encKey` 加的，而密码和恢复码是两个不同的字符串。如果 `encKey`
 * 直接由它们派生，这两把钥匙就解不开彼此加密的数据——「恢复码等价于密码」
 * 那句话就成了假的：用它登录进来只会看到一堆解不开的密文。所以 `encKey` 是
 * 建空间时随机生成的，用密码包一份、用恢复码包一份，两份都放服务端；谁登录
 * 成功谁就解开同一个主密钥。
 *
 * 代价是服务端多存一份「包起来的主密钥」——它仍然看不到明文，也解不开：
 * 包钥匙的 KEK 由用户密码派生，服务端手里没有密码。收益是「忘了密码还能用
 * 恢复码接着聊」这句话真的成立。
 *
 * 为什么 id 要先折成 handle：用户可能拿手机号当 id，而服务端不可避免地会
 * 看见它拿去查表。折一道之后，服务端手里是一个不透明的 handle，拖库的人
 * 想还原成手机号得跑一遍字典——挡不住定向爆破，但把「一眼看出谁是谁」变成
 * 「得费点事」。这一点在 SYNC §3.1 里如实写着，界面也要提示用户。
 */

import { fromBase64Url, randomBytes, subtle, timingSafeEqual, toBase64Url, utf8 } from './encoding.js';
import { CryptoError } from './errors.js';

/**
 * 把用户 id 折成空间句柄的迭代数。
 *
 * 比密钥派生低一档：它是每次登录都要算的（要拿它去服务端查表），
 * 100k 在手机上约 100~200ms，够挡住「拖库之后一眼看穿」，又不至于让打开
 * 设置面板卡一下。
 */
export const SPACE_HANDLE_ITERATIONS = 100_000;

/** 同步密码 / 恢复码的派生迭代数（SYNC §3.1：弱密码会被离线爆破，所以拉高）。 */
export const SYNC_KEY_ITERATIONS = 600_000;

/** 一句固定盐。它不是秘密，只是为了让 handle 与「裸 SHA-256」区分开。 */
const SPACE_HANDLE_SALT = 'dramatis:space-handle:v1';

/** 包主密钥用的 IV 长度（GCM 标准）。 */
const WRAP_IV_BYTES = 12;

/** 包出来的东西是 AES-256-GCM 的密文（含认证标签）。 */
export const WRAPPED_KEY_ALGORITHM = 'AES-256-GCM';

const KEY_BITS = 256;

/**
 * 这个 secret 是干什么用的。
 *
 * 用途进盐里：密码与恢复码派生出两把不同的 KEK，所以「拿恢复码那包去当密码
 * 那包解」这种张冠李戴会直接失败。
 */
export type SecretPurpose = 'password' | 'recovery';

/**
 * 用户 id 的规范化：去首尾空白、大小写折叠、内部连续空白压成一个空格。
 *
 * 只做这三件事是刻意的：用户得能凭记忆重新敲出同一个 id。手机号里常见的
 * 横线不在处理范围内，所以 `138-0013-8000` 与 `13800138000` 会折成两个
 * 空间——界面上要提示「id 里别加空格和横线」。
 */
export function normalizeUserId(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function pbkdf2(secret: string, salt: string, iterations: number, bits: number): Promise<Uint8Array> {
  if (secret === '') throw new CryptoError('密钥不能为空。');
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new CryptoError(`迭代数必须是正整数，收到 ${String(iterations)}。`);
  }

  const material = await subtle().importKey('raw', utf8(secret), 'PBKDF2', false, ['deriveBits']);
  const derived = await subtle().deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: utf8(salt), iterations },
    material,
    bits,
  );
  return new Uint8Array(derived);
}

export interface SpaceHandleOptions {
  /** 测试用：把迭代数调小，生产环境别传。 */
  iterations?: number;
}

/**
 * 用户 id → 空间句柄（base64url）。
 *
 * 同一个 id 在同一套参数下永远得到同一个 handle，服务端就是靠它找空间的。
 */
export async function deriveSpaceHandle(userId: string, options: SpaceHandleOptions = {}): Promise<string> {
  const normalized = normalizeUserId(userId);
  if (normalized === '') throw new CryptoError('用户 id 不能为空。');
  const derived = await pbkdf2(normalized, SPACE_HANDLE_SALT, options.iterations ?? SPACE_HANDLE_ITERATIONS, KEY_BITS);
  return toBase64Url(derived);
}

/** 从一句密码（或恢复码）派生出来的两样东西。 */
export interface SecretKeys {
  /** 用来算凭证（HMAC）。服务端只存凭证的哈希，不存它本身。 */
  authKey: CryptoKey;
  /** 只用来包 / 解主密钥，不直接拿来加密记录。 */
  keyEncryptionKey: CryptoKey;
}

export interface DeriveSecretKeysInput {
  /** 同步密码，或者恢复码。 */
  secret: string;
  /** `deriveSpaceHandle` 的输出。 */
  spaceHandle: string;
  purpose: SecretPurpose;
  /** 测试用：把迭代数调小。 */
  iterations?: number;
}

/**
 * 一次 PBKDF2 拿 64 字节，前半当 `authKey`、后半当 `keyEncryptionKey`。
 *
 * 为什么不用两次派生：同样的成本（600k 迭代）再跑一遍纯属浪费，而
 * 「一次派生两把钥匙」是标准做法（HKDF 干的就是这件事；这里直接切
 * PBKDF2 的输出，因为 WebCrypto 原生就有）。
 */
export async function deriveSecretKeys(input: DeriveSecretKeysInput): Promise<SecretKeys> {
  if (input.spaceHandle === '') throw new CryptoError('空间句柄不能为空。');
  const iterations = input.iterations ?? SYNC_KEY_ITERATIONS;
  const material = await pbkdf2(
    input.secret,
    `dramatis:sync:${input.purpose}:${input.spaceHandle}`,
    iterations,
    KEY_BITS * 2,
  );

  const authKey = await subtle().importKey('raw', material.slice(0, 32), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const keyEncryptionKey = await subtle().importKey('raw', material.slice(32), 'AES-GCM', false, [
    'wrapKey',
    'unwrapKey',
  ]);

  return { authKey, keyEncryptionKey };
}

/**
 * 随机主密钥（`encKey`）：256 bit，可导出（否则包不起来），但不会被写进任何请求。
 *
 * 它必须存在的原因见文件头：只有它是随机的，密码与恢复码才能同时打开同一堆密文。
 */
export async function createSpaceKey(): Promise<CryptoKey> {
  return subtle().generateKey({ name: 'AES-GCM', length: KEY_BITS }, true, ['encrypt', 'decrypt']);
}

/** 包起来的主密钥（服务端存的就是这个：一个坐标 + 一段密文）。 */
export interface WrappedKey {
  algorithm: typeof WRAPPED_KEY_ALGORITHM;
  iv: string;
  ciphertext: string;
}

function wrapAad(spaceHandle: string, purpose: SecretPurpose): Uint8Array<ArrayBuffer> {
  return utf8(`dramatis:key-wrap:v1|${purpose}|${spaceHandle}`);
}

export interface WrapSpaceKeyInput {
  /** `deriveSpaceHandle` 的输出（也进封装的 AAD）。 */
  spaceHandle: string;
  purpose: SecretPurpose;
  /**
   * 已经派生好的两把钥匙（顺序 61）。给了它就直接用，**不再跑一遍 PBKDF2**。
   *
   * 为什么要有这个口子：调用方（建空间 / 换密码 / 登录）本来就要派生一次来算凭证，
   * 再把 `secret` 传进来会让 600k 次迭代白跑第二遍——手机上那是好几百毫秒。
   */
  keys?: SecretKeys;
  /** 没给 `keys` 时的兜底：现场派生（老调用方与单测用它）。 */
  secret?: string;
  /** 测试用：把迭代数调小（只在没给 `keys` 时有效）。 */
  iterations?: number;
  /** 测试用：固定 IV。 */
  iv?: Uint8Array<ArrayBuffer>;
}

/** 解封装用的输入：与 `WrapSpaceKeyInput` 同一套「给 keys 或给 secret」的规则。 */
export type UnwrapSpaceKeyInput = Omit<WrapSpaceKeyInput, 'iv'>;

/**
 * 拿到这次要用的两把钥匙：优先用调用方已经派生好的那份。
 *
 * 没给 `keys` 时现场派生，`secret` 也不能为空——两条路都不通就报一句人话，
 * 而不是拿空字符串去跑 PBKDF2（那会抛一个更难懂的错）。
 */
async function resolveSecretKeys(input: WrapSpaceKeyInput): Promise<SecretKeys> {
  if (input.keys !== undefined) return input.keys;
  if (input.secret === undefined || input.secret === '') {
    throw new CryptoError('包 / 解主密钥需要钥匙：给 keys（已派生的两把）或者 secret（明文）。');
  }
  return deriveSecretKeys({
    secret: input.secret,
    spaceHandle: input.spaceHandle,
    purpose: input.purpose,
    iterations: input.iterations,
  });
}

/** 用密码（或恢复码）把主密钥包起来。同一把主密钥包两次：一份给密码，一份给恢复码。 */
export async function wrapSpaceKey(masterKey: CryptoKey, input: WrapSpaceKeyInput): Promise<WrappedKey> {
  const { keyEncryptionKey } = await resolveSecretKeys(input);
  const iv = input.iv ?? randomBytes(WRAP_IV_BYTES);
  if (iv.byteLength !== WRAP_IV_BYTES) {
    throw new CryptoError(`包钥匙的 IV 必须是 ${String(WRAP_IV_BYTES)} 字节。`);
  }

  const wrapped = await subtle().wrapKey('raw', masterKey, keyEncryptionKey, {
    name: 'AES-GCM',
    iv,
    additionalData: wrapAad(input.spaceHandle, input.purpose),
    tagLength: 128,
  });

  return {
    algorithm: WRAPPED_KEY_ALGORITHM,
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(wrapped)),
  };
}

/**
 * 解包主密钥。
 *
 * 解出来的主密钥是不可导出的——它只活在当前会话的内存里，除了加解密记录
 * 以外拿不去别处。
 */
export async function unwrapSpaceKey(wrapped: WrappedKey, input: UnwrapSpaceKeyInput): Promise<CryptoKey> {
  if (wrapped.algorithm !== WRAPPED_KEY_ALGORITHM) {
    throw new CryptoError(`不认识的钥匙封装算法：${String(wrapped.algorithm)}。`);
  }
  const { keyEncryptionKey } = await resolveSecretKeys(input);
  const iv = fromBase64Url(wrapped.iv);

  try {
    return await subtle().unwrapKey(
      'raw',
      fromBase64Url(wrapped.ciphertext),
      keyEncryptionKey,
      { name: 'AES-GCM', iv, additionalData: wrapAad(input.spaceHandle, input.purpose), tagLength: 128 },
      { name: 'AES-GCM', length: KEY_BITS },
      false,
      ['encrypt', 'decrypt'],
    );
  } catch {
    throw new CryptoError('解不开主密钥：密码（或恢复码）不对，或者这份封装不是给这个空间的。');
  }
}

/**
 * 凭证：`HMAC(authKey, "dramatis:credential:v1|" + spaceHandle)` 的 base64url。
 *
 * 用 HMAC 而不是直接用 `authKey`：请求头上流动的必须是另一个值，
 * 否则凭证一旦泄露，等于 `authKey` 泄露（而它和包钥匙的 KEK 是同一批材料切的）。
 */
export async function deriveCredential(authKey: CryptoKey, spaceHandle: string): Promise<string> {
  const signature = await subtle().sign('HMAC', authKey, utf8(`dramatis:credential:v1|${spaceHandle}`));
  return toBase64Url(new Uint8Array(signature));
}

/** 服务端存的那一份：凭证的 SHA-256（base64url）。拖库也反推不出凭证。 */
export async function hashCredential(credential: string): Promise<string> {
  const digest = await subtle().digest('SHA-256', utf8(credential));
  return toBase64Url(new Uint8Array(digest));
}

/** 服务端校验：`Authorization: Bearer <凭证>` 与库里那份哈希比。 */
export async function verifyCredential(credential: string, expectedHash: string): Promise<boolean> {
  const actual = await hashCredential(credential);
  return timingSafeEqual(actual, expectedHash);
}

/** 恢复码用的字母表：去掉 I / L / O / U，避免和 1 / 0 看混。 */
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Crockford base32 的易错字符映射（用户抄错时救回来）。 */
const RECOVERY_CONFUSABLES: Record<string, string> = { I: '1', L: '1', O: '0', U: 'V' };

/**
 * 生成恢复码：32 字节随机（256 bit）编成 base32，每 4 位一组用 `-` 分开。
 *
 * 它和同步密码等价：忘了密码就拿它当密码用（SYNC §3.1）。所以建空间时
 * 必须强制显示一次，并让用户抄下来——服务端没有第二份。
 */
export function newRecoveryCode(bytes = 32): string {
  const data = randomBytes(bytes);
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += RECOVERY_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += RECOVERY_ALPHABET[(value << (5 - bits)) & 31];

  return out.replace(/.{4}/g, '$&-').replace(/-$/, '');
}

/**
 * 恢复码归一：大写、去分隔符、把看混的字符换回来。
 *
 * 用户抄写时会掉横线、写小写、把 `0` 写成 `O`——这些都不该导致「密码错」。
 */
export function normalizeRecoveryCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .split('')
    .map((char) => RECOVERY_CONFUSABLES[char] ?? char)
    .join('');
}

/** 建空间时得到的一整套东西。 */
export interface SpaceCredentials {
  /** 服务端认的空间标识（由用户填的 id 折出来）。 */
  spaceHandle: string;
  /** 密码对应的凭证（每请求带一次）。 */
  credential: string;
  /** 服务端存这个，不存凭证本身。 */
  credentialHash: string;
  /** 恢复码对应的凭证；两者等价，服务端两个哈希都存。 */
  recoveryCredential: string;
  recoveryCredentialHash: string;
  /** 主密钥：记录加解密用它。不进任何请求。 */
  encKey: CryptoKey;
  /** 给服务端的两份封装：密码一份、恢复码一份。 */
  passwordWrap: WrappedKey;
  recoveryWrap: WrappedKey;
  /** 恢复码本体：建空间这一刻必须显示一次，之后服务端与本地都不留。 */
  recoveryCode: string;
}

export interface CreateSpaceInput {
  userId: string;
  password: string;
  /** 不传就现场生成一个 32 字节的恢复码（默认就该这样）。 */
  recoveryCode?: string;
  /** 测试用。 */
  handleIterations?: number;
  keyIterations?: number;
}

/** 换同步密码时算出来的那一套（主密钥不变，只换「锁住它的那把锁」）。 */
export interface RotatedPassword {
  credential: string;
  credentialHash: string;
  passwordWrap: WrappedKey;
}

export interface RotatePasswordInput {
  /** 建空间时折出来的句柄（换密码不换句柄——换了句柄等于换空间）。 */
  spaceHandle: string;
  /** 手上那把主密钥（`openSpace` 的输出）。**不会**因此重新生成。 */
  encKey: CryptoKey;
  newPassword: string;
  keyIterations?: number;
}

/**
 * 换同步密码（顺序 15）。
 *
 * 关键决定：**不重新生成主密钥**，只用新密码重新包一次。
 *
 * 换主密钥意味着所有记录都要重新加密一遍再上传——本地几千条记录要全量重写，
 * 中途断网就是「一半新一半旧」的烂摊子。而主密钥本身没有泄露：它一直只活在
 * 各设备的会话内存里，服务端拿到的只是封装。所以换密码真正要变的是两件事：
 * 服务端存的**凭证哈希**（旧密码从此过不了鉴权）和**封装**（旧密码再也解不开主密钥）。
 *
 * 恢复码那份封装**不动**：它是「忘了密码」的等价凭证，换密码不该顺手废掉它。
 */
export async function rotatePassword(input: RotatePasswordInput): Promise<RotatedPassword> {
  const keys = await deriveSecretKeys({
    secret: input.newPassword,
    spaceHandle: input.spaceHandle,
    purpose: 'password',
    iterations: input.keyIterations,
  });
  const credential = await deriveCredential(keys.authKey, input.spaceHandle);
  const passwordWrap = await wrapSpaceKey(input.encKey, {
    spaceHandle: input.spaceHandle,
    purpose: 'password',
    // 复用上面刚派生的那一份：换密码从「两次 600k 迭代」降到一次（顺序 61）
    keys,
  });
  return { credential, credentialHash: await hashCredential(credential), passwordWrap };
}

/**
 * 建空间：用户 id + 密码 → 句柄、两份钥匙封装、两份凭证、主密钥、恢复码。
 *
 * 「建空间」与「加入已有空间」在客户端算的东西完全一样，区别只在服务端那边
 * 这个 handle 是新是旧（新的登记，旧的校验凭证）。
 */
export async function createSpaceCredentials(input: CreateSpaceInput): Promise<SpaceCredentials> {
  const spaceHandle = await deriveSpaceHandle(input.userId, { iterations: input.handleIterations });
  const recoveryCode = input.recoveryCode ?? newRecoveryCode();
  const normalizedRecovery = normalizeRecoveryCode(recoveryCode);
  const encKey = await createSpaceKey();
  const keyIterations = input.keyIterations;

  const passwordKeys = await deriveSecretKeys({
    secret: input.password,
    spaceHandle,
    purpose: 'password',
    iterations: keyIterations,
  });
  const recoveryKeys = await deriveSecretKeys({
    secret: normalizedRecovery,
    spaceHandle,
    purpose: 'recovery',
    iterations: keyIterations,
  });

  const passwordWrap = await wrapSpaceKey(encKey, {
    spaceHandle,
    purpose: 'password',
    // 复用上面派生好的两份：建空间从「四次 600k 迭代」降到两次（顺序 61）
    keys: passwordKeys,
  });
  const recoveryWrap = await wrapSpaceKey(encKey, {
    spaceHandle,
    purpose: 'recovery',
    keys: recoveryKeys,
  });

  const credential = await deriveCredential(passwordKeys.authKey, spaceHandle);
  const recoveryCredential = await deriveCredential(recoveryKeys.authKey, spaceHandle);

  return {
    spaceHandle,
    credential,
    credentialHash: await hashCredential(credential),
    recoveryCredential,
    recoveryCredentialHash: await hashCredential(recoveryCredential),
    encKey,
    passwordWrap,
    recoveryWrap,
    recoveryCode,
  };
}

export interface OpenSpaceInput {
  spaceHandle: string;
  /** 同步密码或恢复码。 */
  secret: string;
  purpose: SecretPurpose;
  /** 服务端存的那一份封装。 */
  wrapped: WrappedKey;
  /** 测试用。 */
  keyIterations?: number;
}

export interface OpenedSpace {
  /** 这次登录算出来的凭证（服务端拿它和存下来的哈希比）。 */
  credential: string;
  credentialHash: string;
  /** 解出来的主密钥，用它解密记录。 */
  encKey: CryptoKey;
}

/**
 * 加入 / 登录：用密码或恢复码解开主密钥，并算出这次请求要带的凭证。
 *
 * 密码错时先在解封装这一步失败（GCM 认证过不去），不会出现「凭证算出来了、
 * 数据却解不开」这种半吊子状态。
 */
export async function openSpace(input: OpenSpaceInput): Promise<OpenedSpace> {
  const secret = input.purpose === 'recovery' ? normalizeRecoveryCode(input.secret) : input.secret;
  const keys = await deriveSecretKeys({
    secret,
    spaceHandle: input.spaceHandle,
    purpose: input.purpose,
    iterations: input.keyIterations,
  });
  const encKey = await unwrapSpaceKey(input.wrapped, {
    spaceHandle: input.spaceHandle,
    purpose: input.purpose,
    // 复用上面那一次派生：登录从「两次 600k 迭代」降到一次（顺序 61）
    keys,
  });
  const credential = await deriveCredential(keys.authKey, input.spaceHandle);
  return { credential, credentialHash: await hashCredential(credential), encKey };
}
