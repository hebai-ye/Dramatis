/**
 * 口令加密的密钥库（顺序 10）。
 *
 * 这一条测的不是「能不能存」，而是**几个不能退让的性质**：
 * 盘上没有明文、口令错了必须解不开、库不能被悄悄覆盖、文件坏了要说出来。
 */

import { describe, expect, it } from 'vitest';
import { CryptoError } from '../crypto/errors.js';
import { createVault, hasVault, openVault, readVault, vaultRefs } from './key-vault.js';

/** 把存储做成一个字符串，测试里直接看它——「盘上有没有明文」就是这么验的。 */
function memoryStorage() {
  let value: string | null = null;
  return {
    read: async () => value,
    write: async (next: string) => {
      value = next;
    },
    raw: () => value,
  };
}

/** 迭代数调小：这里验的是形状与行为，不是 KDF 的强度。 */
const FAST = { iterations: 200 };

describe('口令加密的密钥库（顺序 10）', () => {
  it('存进去的密钥盘上一个字都看不见，口令对了才拿得回来', async () => {
    const storage = memoryStorage();
    await createVault(storage, '我家的口令', FAST);
    const store = await openVault(storage, '我家的口令', FAST);

    await store.set('keyRef-1', 'sk-绝密-abcdef');
    expect(store.kind).toBe('encrypted');
    expect(await store.get('keyRef-1')).toBe('sk-绝密-abcdef');

    // 盘上：没有明文 Key，也没有那句口令
    expect(storage.raw()).not.toContain('sk-');
    expect(storage.raw()).not.toContain('绝密');
    expect(storage.raw()).not.toContain('我家的口令');
    // 但结构是可读的（将来换算法要靠它分流）
    expect(JSON.parse(storage.raw() ?? '{}')).toMatchObject({ kind: 'dramatis-key-vault', version: 1 });
  });

  it('口令错了 → 明确报「口令不对」，不是一个含糊的失败', async () => {
    const storage = memoryStorage();
    await createVault(storage, '正确的口令', FAST);
    await expect(openVault(storage, '记错的口令', FAST)).rejects.toThrowError(/口令不对/);
  });

  it('没有口令也能知道库在不在、存了哪几条（界面要用它决定显示「解锁」还是「设口令」）', async () => {
    const storage = memoryStorage();
    expect(await hasVault(storage)).toBe(false);

    await createVault(storage, '口令', FAST);
    const store = await openVault(storage, '口令', FAST);
    await store.set('ref-a', 'secret-a');
    await store.set('ref-b', 'secret-b');

    expect(await hasVault(storage)).toBe(true);
    expect(await vaultRefs(storage)).toEqual(['ref-a', 'ref-b']);
  });

  it('删除与清空：删一条只动一条，clear 之后库还在（口令不变）', async () => {
    const storage = memoryStorage();
    await createVault(storage, '口令', FAST);
    const store = await openVault(storage, '口令', FAST);
    await store.set('ref-a', 'secret-a');
    await store.set('ref-b', 'secret-b');

    await store.remove('ref-a');
    expect(await store.list()).toEqual(['ref-b']);

    await store.clear();
    expect(await store.list()).toEqual([]);
    // 清空之后还是同一个库：老口令照样能打开（不然用户会以为库坏了）
    await expect(openVault(storage, '口令', FAST)).resolves.toBeTruthy();
  });

  it('已经有一个库时不许再 create（绝不悄悄覆盖别人的钥匙）', async () => {
    const storage = memoryStorage();
    await createVault(storage, '口令', FAST);
    await expect(createVault(storage, '另一个口令', FAST)).rejects.toThrowError(/已经有一个口令库/);
  });

  it('文件坏了 → 抛错，而不是当成「空库」把用户的东西盖掉', async () => {
    const storage = memoryStorage();
    await storage.write('这不是 JSON');
    await expect(readVault(storage)).rejects.toBeInstanceOf(CryptoError);
    await expect(hasVault(storage)).rejects.toThrowError(/读不出来/);

    await storage.write(JSON.stringify({ kind: '别的什么东西' }));
    await expect(readVault(storage)).rejects.toThrowError(/格式不认识/);
  });

  it('两条记录之间的密文不能互换（AAD 绑 ref）', async () => {
    const storage = memoryStorage();
    await createVault(storage, '口令', FAST);
    const store = await openVault(storage, '口令', FAST);
    await store.set('ref-a', 'secret-a');
    await store.set('ref-b', 'secret-b');

    // 手工把 b 的密文挪到 a 的位置
    const file = await readVault(storage);
    if (file === null) throw new Error('库里应该有东西');
    const swapped = { ...file, secrets: { ...file.secrets, 'ref-a': file.secrets['ref-b'] } };
    await storage.write(JSON.stringify(swapped));

    const reopened = await openVault(storage, '口令', FAST);
    // 解不开的单条按「没有这条」处理：界面不该因为一条坏条目整个打不开
    expect(await reopened.get('ref-a')).toBeNull();
  });

  it('并发写不丢更新：同时 set 几条，全都留下（审计 C14）', async () => {
    // 故意让读写都「慢」一拍，逼出交错
    let value: string | null = null;
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));
    const storage = {
      read: async () => {
        await tick();
        return value;
      },
      write: async (next: string) => {
        await tick();
        value = next;
      },
    };
    await createVault(storage, '口令', FAST);
    const first = await openVault(storage, '口令', FAST);
    const second = await openVault(storage, '口令', FAST);

    await Promise.all([
      first.set('a', '1'),
      first.set('b', '2'),
      second.set('c', '3'),
      first.remove('nothing'),
      second.set('d', '4'),
    ]);
    expect((await vaultRefs(storage)).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(await second.get('a')).toBe('1');
  });

  it('共享存储的可选互斥覆盖完整读改写，另一存储实例删除不会被旧 set 复活', async () => {
    const backing = memoryStorage();
    let tail: Promise<unknown> = Promise.resolve();
    const runExclusive = <T>(task: () => Promise<T>): Promise<T> => {
      const result = tail.then(task, task);
      tail = result.catch(() => undefined);
      return result;
    };
    const firstStorage = { ...backing, runExclusive };
    const secondStorage = { ...backing, runExclusive };
    await createVault(firstStorage, '测试口令', FAST);
    const first = await openVault(firstStorage, '测试口令', FAST);
    const second = await openVault(secondStorage, '测试口令', FAST);
    await first.set('owned', '待清理');
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    firstStorage.read = async () => {
      const raw = await backing.read();
      entered();
      await gate;
      return raw;
    };
    const writing = first.set('new-ref', '保留新密钥');
    await started;
    const removing = second.remove('owned');
    await Promise.race([removing, new Promise((resolve) => setTimeout(resolve, 10))]);
    release();
    await Promise.all([writing, removing]);
    expect(await second.list()).toEqual(['new-ref']);
    expect(await second.get('new-ref')).toBe('保留新密钥');
    expect(await second.get('owned')).toBeNull();
  });

  it('可选存储互斥拒绝时 set/remove/clear 均明确失败并保持旧数据', async () => {
    const backing = memoryStorage();
    await createVault(backing, '测试口令', FAST);
    const unlocked = await openVault(backing, '测试口令', FAST);
    await unlocked.set('owned', '保留');
    const storage = {
      ...backing,
      runExclusive: async <T>(_task: () => Promise<T>): Promise<T> => {
        throw new Error('口令库锁不可用');
      },
    };
    const store = await openVault(storage, '测试口令', FAST);
    await expect(store.set('new-ref', '新密钥')).rejects.toThrow('口令库锁不可用');
    await expect(store.remove('owned')).rejects.toThrow('口令库锁不可用');
    await expect(store.clear()).rejects.toThrow('口令库锁不可用');
    expect(await unlocked.list()).toEqual(['owned']);
    expect(await unlocked.get('owned')).toBe('保留');
  });

  it('文件里的迭代数被改成离谱的值 → 拒绝解锁，而不是把页面卡死（审计 C14）', async () => {
    const storage = memoryStorage();
    await createVault(storage, '口令', FAST);
    const file = JSON.parse(storage.raw() ?? '{}') as { kdf: { iterations: number } };
    file.kdf.iterations = 1_000_000_000;
    await storage.write(JSON.stringify(file));
    await expect(openVault(storage, '口令', FAST)).rejects.toBeInstanceOf(CryptoError);

    file.kdf.iterations = 1.5;
    await storage.write(JSON.stringify(file));
    await expect(readVault(storage)).rejects.toBeInstanceOf(CryptoError);
  });
});
