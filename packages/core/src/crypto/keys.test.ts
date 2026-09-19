import { afterEach, describe, expect, it, vi } from 'vitest';
import { subtle } from './encoding.js';
import { CryptoError } from './errors.js';
import {
  createSpaceCredentials,
  deriveCredential,
  deriveSecretKeys,
  deriveSpaceHandle,
  hashCredential,
  newRecoveryCode,
  normalizeRecoveryCode,
  normalizeUserId,
  openSpace,
  unwrapSpaceKey,
  verifyCredential,
  wrapSpaceKey,
} from './keys.js';
import { decryptRecord, encryptRecord } from './records.js';

/** 测试里把迭代数调小：这些用例验的是「关系」，不是 KDF 的强度。 */
const FAST = { handleIterations: 100, keyIterations: 200 };

const COORDINATES = { spaceHandle: 'handle-abc', collection: 'messages', id: 'msg-1', rev: 1 };

describe('normalizeUserId', () => {
  it('去首尾空白、大小写折叠、内部空白压成一个空格', () => {
    expect(normalizeUserId('  Alice  ')).toBe('alice');
    expect(normalizeUserId('旅人   甲乙')).toBe('旅人 甲乙');
    expect(normalizeUserId('13800138000')).toBe('13800138000');
  });

  it('不替用户吃掉横线——那会让「凭记忆敲回来」变得不可预期', () => {
    // 界面上要提示「id 里别加空格和横线」，而不是猜用户的意思
    expect(normalizeUserId('138-0013-8000')).not.toBe(normalizeUserId('13800138000'));
  });
});

describe('deriveSpaceHandle', () => {
  it('同一个 id 永远折出同一个句柄，不同 id 折出不同的', async () => {
    const a = await deriveSpaceHandle('Alice', { iterations: 100 });
    const b = await deriveSpaceHandle('  alice ', { iterations: 100 });
    const c = await deriveSpaceHandle('bob', { iterations: 100 });

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    // base64url，不带填充符——直接放进 URL 与请求头
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('空 id 直接报错，不给「匿名空间」的机会', async () => {
    await expect(deriveSpaceHandle('   ', { iterations: 100 })).rejects.toBeInstanceOf(CryptoError);
  });
});

describe('deriveSecretKeys', () => {
  it('同样的 secret + 用途 + 句柄派生出同一把 authKey（凭证一致）', async () => {
    const handle = await deriveSpaceHandle('alice', { iterations: 100 });
    const first = await deriveSecretKeys({ secret: '密码', spaceHandle: handle, purpose: 'password', iterations: 200 });
    const second = await deriveSecretKeys({
      secret: '密码',
      spaceHandle: handle,
      purpose: 'password',
      iterations: 200,
    });

    expect(await deriveCredential(first.authKey, handle)).toBe(await deriveCredential(second.authKey, handle));
  });

  it('KEK 只干包钥匙这一件事：不给它加解密数据的权限', async () => {
    const handle = await deriveSpaceHandle('alice', { iterations: 100 });
    const keys = await deriveSecretKeys({ secret: '密码', spaceHandle: handle, purpose: 'password', iterations: 200 });

    // 这是刻意的：能包钥匙的钥匙不该顺手也能解记录。用错了会立刻报错，
    // 而不是悄悄工作、把「哪把钥匙在保护什么」搅浑。
    await expect(
      subtle().encrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, keys.keyEncryptionKey, new Uint8Array([1])),
    ).rejects.toBeTruthy();
  });

  it('用途分开：密码派生出来的那把打不开恢复码那边包的钥匙', async () => {
    const handle = await deriveSpaceHandle('alice', { iterations: 100 });
    const master = await createSpaceCredentials({ userId: 'alice', password: '一句话', ...FAST });
    const wrappedAsRecovery = await wrapSpaceKey(master.encKey, {
      secret: '一句话',
      spaceHandle: handle,
      purpose: 'recovery',
      iterations: 200,
    });

    await expect(
      unwrapSpaceKey(wrappedAsRecovery, {
        secret: '一句话',
        spaceHandle: handle,
        purpose: 'password',
        iterations: 200,
      }),
    ).rejects.toBeInstanceOf(CryptoError);
  });

  it('空句柄直接报错', async () => {
    await expect(
      deriveSecretKeys({ secret: 'x', spaceHandle: '', purpose: 'password', iterations: 10 }),
    ).rejects.toBeInstanceOf(CryptoError);
  });
});

describe('凭证', () => {
  it('同一把 authKey 算出的凭证稳定，且是 base64url', async () => {
    const handle = await deriveSpaceHandle('alice', { iterations: 100 });
    const keys = await deriveSecretKeys({ secret: '密码', spaceHandle: handle, purpose: 'password', iterations: 200 });

    const first = await deriveCredential(keys.authKey, handle);
    const second = await deriveCredential(keys.authKey, handle);

    expect(first).toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    // HMAC-SHA256 的输出是 32 字节 → base64url 43 个字符
    expect(first).toHaveLength(43);
  });

  it('服务端只存哈希：对得上就放行，对不上就拒绝', async () => {
    const handle = await deriveSpaceHandle('alice', { iterations: 100 });
    const keys = await deriveSecretKeys({ secret: '密码', spaceHandle: handle, purpose: 'password', iterations: 200 });
    const credential = await deriveCredential(keys.authKey, handle);
    const stored = await hashCredential(credential);

    expect(stored).not.toBe(credential);
    expect(await verifyCredential(credential, stored)).toBe(true);
    expect(await verifyCredential(`${credential}x`, stored)).toBe(false);
    expect(await verifyCredential('', stored)).toBe(false);
  });
});

describe('密钥封装', () => {
  it('包起来的主密钥解出来还是同一把（能开同一堆密文）', async () => {
    const handle = await deriveSpaceHandle('alice', { iterations: 100 });
    const created = await createSpaceCredentials({ userId: 'alice', password: '密码', ...FAST });
    const wrapped = await wrapSpaceKey(created.encKey, {
      secret: '密码',
      spaceHandle: handle,
      purpose: 'password',
      iterations: 200,
    });
    const opened = await unwrapSpaceKey(wrapped, {
      secret: '密码',
      spaceHandle: handle,
      purpose: 'password',
      iterations: 200,
    });

    const sealed = await encryptRecord(created.encKey, COORDINATES, { content: '秘密' });
    await expect(decryptRecord(opened, COORDINATES, sealed)).resolves.toEqual({ content: '秘密' });
  });

  it('密码错、用途错、空间错，一律解不开', async () => {
    const handle = await deriveSpaceHandle('alice', { iterations: 100 });
    const master = await createSpaceCredentials({ userId: 'alice', password: '密码', ...FAST });
    const wrapped = master.passwordWrap;

    const wrongPassword = { secret: '密码2', spaceHandle: handle, purpose: 'password' as const, iterations: 200 };
    const wrongPurpose = { secret: '密码', spaceHandle: handle, purpose: 'recovery' as const, iterations: 200 };
    const wrongSpace = { secret: '密码', spaceHandle: `${handle}x`, purpose: 'password' as const, iterations: 200 };

    for (const input of [wrongPassword, wrongPurpose, wrongSpace]) {
      await expect(unwrapSpaceKey(wrapped, input)).rejects.toBeInstanceOf(CryptoError);
    }
    await expect(
      unwrapSpaceKey(wrapped, { secret: '密码', spaceHandle: handle, purpose: 'password', iterations: 200 }),
    ).resolves.toBeTruthy();
  });

  it('封装算法不对时说人话', async () => {
    const handle = await deriveSpaceHandle('alice', { iterations: 100 });
    await expect(
      unwrapSpaceKey(
        { algorithm: 'AES-128-CBC' as never, iv: 'aaaa', ciphertext: 'bbbb' },
        { secret: '密码', spaceHandle: handle, purpose: 'password', iterations: 200 },
      ),
    ).rejects.toThrowError(/不认识的钥匙封装算法/);
  });
});

describe('恢复码', () => {
  it('32 字节随机 → 52 个 base32 字符，四位一组', () => {
    const code = newRecoveryCode();
    const bare = code.replace(/-/g, '');

    expect(bare).toHaveLength(52);
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4})*$/);
    // 不含容易看混的字母
    expect(bare).not.toMatch(/[ILOU]/);
  });

  it('两次生成不会撞（随机源有 256 bit）', () => {
    expect(newRecoveryCode()).not.toBe(newRecoveryCode());
  });

  it('容错归一：小写、掉横线、把 0 写成 O 都能救回来', () => {
    const code = newRecoveryCode();
    const bare = code.replace(/-/g, '');
    const mistyped = code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l');

    expect(normalizeRecoveryCode(mistyped)).toBe(bare);
    expect(normalizeRecoveryCode(code)).toBe(bare);
  });
});

describe('建空间 / 加入空间', () => {
  it('密码与恢复码解出来的是同一把主密钥（这才是「等价凭证」）', async () => {
    const created = await createSpaceCredentials({ userId: ' 旅人 ', password: '一句够长的密码', ...FAST });
    const sealed = await encryptRecord(created.encKey, COORDINATES, { content: '用密码时期写下的' });

    const byPassword = await openSpace({
      spaceHandle: created.spaceHandle,
      secret: '一句够长的密码',
      purpose: 'password',
      wrapped: created.passwordWrap,
      keyIterations: FAST.keyIterations,
    });
    const byRecovery = await openSpace({
      spaceHandle: created.spaceHandle,
      secret: created.recoveryCode,
      purpose: 'recovery',
      wrapped: created.recoveryWrap,
      keyIterations: FAST.keyIterations,
    });

    // 两边都解得开同一段密文——恢复了密码就等于恢复了数据
    await expect(decryptRecord(byPassword.encKey, COORDINATES, sealed)).resolves.toEqual({
      content: '用密码时期写下的',
    });
    await expect(decryptRecord(byRecovery.encKey, COORDINATES, sealed)).resolves.toEqual({
      content: '用密码时期写下的',
    });
  });

  it('同样的 id + 密码在两台设备上算出同样的句柄与凭证', async () => {
    const first = await createSpaceCredentials({ userId: ' 旅人 ', password: '密码', ...FAST });
    const second = await createSpaceCredentials({ userId: '旅人', password: '密码', ...FAST });

    expect(first.spaceHandle).toBe(second.spaceHandle);
    expect(first.credential).toBe(second.credential);
    expect(first.credentialHash).toBe(second.credentialHash);
  });

  it('两个凭证（密码的、恢复码的）服务端都认', async () => {
    const created = await createSpaceCredentials({ userId: '旅人', password: '密码', ...FAST });

    expect(await verifyCredential(created.credential, created.credentialHash)).toBe(true);
    expect(await verifyCredential(created.recoveryCredential, created.recoveryCredentialHash)).toBe(true);
    // 交叉验证不该通过
    expect(await verifyCredential(created.credential, created.recoveryCredentialHash)).toBe(false);
  });

  it('密码错时在解封装那一步就失败，不会出现「凭证算出来了但数据解不开」', async () => {
    const created = await createSpaceCredentials({ userId: '旅人', password: '密码', ...FAST });

    await expect(
      openSpace({
        spaceHandle: created.spaceHandle,
        secret: '另一个密码',
        purpose: 'password',
        wrapped: created.passwordWrap,
        keyIterations: FAST.keyIterations,
      }),
    ).rejects.toBeInstanceOf(CryptoError);
  });

  it('服务的封装被换成别的空间那份，也解不开', async () => {
    const alice = await createSpaceCredentials({ userId: 'alice', password: '密码', ...FAST });
    const bob = await createSpaceCredentials({ userId: 'bob', password: '密码', ...FAST });

    await expect(
      openSpace({
        spaceHandle: alice.spaceHandle,
        secret: '密码',
        purpose: 'password',
        wrapped: bob.passwordWrap,
        keyIterations: FAST.keyIterations,
      }),
    ).rejects.toBeInstanceOf(CryptoError);
  });
});

describe('WebCrypto 不在的时候', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('报一句能照做的错，而不是 undefined 崩掉', async () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => subtle()).toThrowError(CryptoError);
    expect(() => subtle()).toThrowError(/安全上下文/);
  });
});
