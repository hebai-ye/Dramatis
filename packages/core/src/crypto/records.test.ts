import { describe, expect, it } from 'vitest';
import { CryptoError } from './errors.js';
import { createSpaceCredentials } from './keys.js';
import {
  decryptRecord,
  encryptRecord,
  RECORD_IV_BYTES,
  type RecordCoordinates,
  recordAad,
  recordSize,
} from './records.js';

async function key(): Promise<CryptoKey> {
  const space = await createSpaceCredentials({
    userId: 'alice',
    password: '密码',
    handleIterations: 100,
    keyIterations: 200,
  });
  return space.encKey;
}

const coordinates: RecordCoordinates = {
  spaceHandle: 'handle-abc',
  collection: 'messages',
  id: 'msg-1',
  rev: 7,
};

describe('encryptRecord / decryptRecord', () => {
  it('来回一趟，中文与嵌套结构都原样回来', async () => {
    const encKey = await key();
    const payload = {
      id: 'msg-1',
      content: '「三十箱货是谁的？」\n——他没回答。',
      audience: ['inst-1', 'inst-2'],
      nested: { ok: true, list: [1, 2, 3], empty: null },
    };

    const sealed = await encryptRecord(encKey, coordinates, payload);
    const back = await decryptRecord<typeof payload>(encKey, coordinates, sealed);

    expect(back).toEqual(payload);
    expect(sealed.algorithm).toBe('AES-256-GCM');
    expect(sealed.iv).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('密文里看不出明文（服务端拿到的是噪声）', async () => {
    const encKey = await key();
    const sealed = await encryptRecord(encKey, coordinates, { content: '这句是秘密' });

    expect(sealed.ciphertext).not.toContain('秘密');
    expect(JSON.stringify(sealed)).not.toContain('这句是秘密');
  });

  it('每条记录自己的 IV：同样的内容两次密文不同', async () => {
    const encKey = await key();
    const first = await encryptRecord(encKey, coordinates, { content: '一样的内容' });
    const second = await encryptRecord(encKey, coordinates, { content: '一样的内容' });

    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('IV 长度不对就拒绝（避免 GCM 的 IV 复用）', async () => {
    const encKey = await key();
    await expect(encryptRecord(encKey, coordinates, { a: 1 }, { iv: new Uint8Array(8) })).rejects.toBeInstanceOf(
      CryptoError,
    );
  });

  it('不是 JSON 的载荷明确报错', async () => {
    const encKey = await key();
    await expect(encryptRecord(encKey, coordinates, { big: 1n })).rejects.toBeInstanceOf(CryptoError);
  });
});

describe('AAD 把密文钉在坐标上', () => {
  const cases: Array<[string, RecordCoordinates]> = [
    ['换集合', { ...coordinates, collection: 'memories' }],
    ['换 id', { ...coordinates, id: 'msg-2' }],
    ['换 rev', { ...coordinates, rev: 8 }],
    ['换空间', { ...coordinates, spaceHandle: 'handle-other' }],
  ];

  for (const [label, moved] of cases) {
    it(`${label} → 解不开`, async () => {
      const encKey = await key();
      const sealed = await encryptRecord(encKey, coordinates, { content: '别动我' });

      await expect(decryptRecord(encKey, moved, sealed)).rejects.toBeInstanceOf(CryptoError);
      // 原地解码仍然没问题——不是数据坏了，是坐标对不上
      await expect(decryptRecord(encKey, coordinates, sealed)).resolves.toEqual({ content: '别动我' });
    });
  }

  it('AAD 就是「空间|集合|id|rev」，四条换一条就换一个串', () => {
    const aad = new TextDecoder().decode(recordAad(coordinates));
    expect(aad).toBe('handle-abc|messages|msg-1|7');
  });
});

describe('被动过的密文', () => {
  it('改一个字符就解不开（GCM 的认证标签）', async () => {
    const encKey = await key();
    const sealed = await encryptRecord(encKey, coordinates, { content: '原文' });
    const flipped = `${sealed.ciphertext.slice(0, -1)}${sealed.ciphertext.endsWith('A') ? 'B' : 'A'}`;

    await expect(decryptRecord(encKey, coordinates, { ...sealed, ciphertext: flipped })).rejects.toBeInstanceOf(
      CryptoError,
    );
  });

  it('换一把钥匙（密码错）给的是同一句人话', async () => {
    const encKey = await key();
    const other = await createSpaceCredentials({
      userId: 'bob',
      password: '密码',
      handleIterations: 100,
      keyIterations: 200,
    });

    const sealed = await encryptRecord(encKey, coordinates, { content: '原文' });
    await expect(decryptRecord(other.encKey, coordinates, sealed)).rejects.toThrowError(/解密失败/);
  });

  it('不认识的算法直接拒绝', async () => {
    const encKey = await key();
    const sealed = await encryptRecord(encKey, coordinates, { content: '原文' });
    await expect(
      decryptRecord(encKey, coordinates, { ...sealed, algorithm: 'AES-256-CBC' as never }),
    ).rejects.toThrowError(/不认识的加密算法/);
  });
});

describe('recordSize', () => {
  it('口径是「IV + 密文」的字节数，与服务端要存的 size 一致', async () => {
    const encKey = await key();
    const payload = { content: '一句话' };
    const sealed = await encryptRecord(encKey, coordinates, payload);
    const plaintextBytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;

    // IV 12 字节 + 明文 + GCM 认证标签 16 字节（不把 base64 的膨胀算进去）
    expect(recordSize(sealed)).toBe(RECORD_IV_BYTES + plaintextBytes + 16);
  });
});
