import { describe, expect, it } from 'vitest';
import { type EntityStore, withStoreTransaction } from './entity-store.js';
import { createMemoryEntityStore } from './memory-store.js';

interface Row {
  id: string;
  name?: string;
}

/**
 * `update` / `transaction` 在接口上标成可选（别的后端可能没有），但内存实现一定有。
 * 取出来时顺手断言一次，免得测试静默退化成「什么都没验」。
 */
function mustHave<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`内存实现缺了 ${name}`);
  return value;
}

describe('内存 EntityStore', () => {
  it('put / get / list / remove 的基本语义', async () => {
    const store = createMemoryEntityStore();
    await store.put<Row>('rows', { id: 'a', name: '甲' });
    await store.put<Row>('rows', { id: 'b', name: '乙' });

    expect(await store.get<Row>('rows', 'a')).toEqual({ id: 'a', name: '甲' });
    expect(await store.get<Row>('rows', 'missing')).toBeNull();
    expect((await store.list<Row>('rows')).map((row) => row.id)).toEqual(['a', 'b']);

    await store.remove('rows', 'a');
    expect(await store.count('rows')).toBe(1);
  });

  it('get 返回的是拷贝，改它不会动到库里那份', async () => {
    const store = createMemoryEntityStore();
    await store.put<Row>('rows', { id: 'a', name: '甲' });

    const read = await store.get<Row>('rows', 'a');
    if (!read) throw new Error('没读到');
    read.name = '被改过了';

    expect((await store.get<Row>('rows', 'a'))?.name).toBe('甲');
  });

  it('update 是原子的读-改-写，返回写后的值', async () => {
    const store = createMemoryEntityStore();
    const update = mustHave(store.update, 'update');
    await store.put<Row>('rows', { id: 'a', name: '甲' });

    const written = await update<Row>('rows', 'a', (current) => ({
      id: 'a',
      name: `${current?.name ?? ''}+乙`,
    }));
    expect(written?.name).toBe('甲+乙');
    expect((await store.get<Row>('rows', 'a'))?.name).toBe('甲+乙');

    const untouched = await update<Row>('rows', 'a', () => undefined);
    expect(untouched?.name).toBe('甲+乙');
  });
});

describe('顺序 77：EntityStore.transaction', () => {
  it('回调里能读到自己刚写的（read-your-writes），提交后外面才看得到', async () => {
    const store = createMemoryEntityStore();
    const transact = mustHave(store.transaction, 'transaction');
    await store.put<Row>('rows', { id: 'a', name: '旧' });

    const inside = await transact(async (scope) => {
      await scope.put<Row>('rows', { id: 'a', name: '新' });
      await scope.put<Row>('other', { id: 'x' });
      return await scope.get<Row>('rows', 'a');
    });

    expect(inside?.name).toBe('新');
    expect((await store.get<Row>('rows', 'a'))?.name).toBe('新');
    expect(await store.count('other')).toBe(1);
  });

  it('回调抛错时，事务里跨集合的写入整批回滚', async () => {
    const store = createMemoryEntityStore();
    const transact = mustHave(store.transaction, 'transaction');
    await store.put<Row>('rows', { id: 'a', name: '旧' });
    await store.put<Row>('other', { id: 'keep', name: '留下来的' });

    await expect(
      transact(async (scope) => {
        await scope.put<Row>('rows', { id: 'a', name: '改过' });
        await scope.put<Row>('other', { id: 'new', name: '新增' });
        await scope.remove('other', 'keep');
        throw new Error('模拟中途失败');
      }),
    ).rejects.toThrow('模拟中途失败');

    expect((await store.get<Row>('rows', 'a'))?.name).toBe('旧');
    expect(await store.get<Row>('other', 'new')).toBeNull();
    expect((await store.get<Row>('other', 'keep'))?.name).toBe('留下来的');
  });

  it('withStoreTransaction 走真事务', async () => {
    const store = createMemoryEntityStore();
    await store.put<Row>('rows', { id: 'a', name: '旧' });

    await expect(
      withStoreTransaction(store, async (scope) => {
        await scope.put<Row>('rows', { id: 'a', name: '改过' });
        throw new Error('炸');
      }),
    ).rejects.toThrow('炸');

    expect((await store.get<Row>('rows', 'a'))?.name).toBe('旧');
  });

  it('withStoreTransaction 对没有 transaction 的后端退回同一个 store（保证变弱、语义不变）', async () => {
    const base = createMemoryEntityStore();
    const { transaction: _unsupported, ...withoutTransaction } = base;
    const store: EntityStore = withoutTransaction;
    expect(store.transaction).toBeUndefined();

    const seen = await withStoreTransaction(store, async (scope) => {
      expect(scope).toBe(store);
      await scope.put<Row>('rows', { id: 'a', name: '照写' });
      return 'done';
    });

    expect(seen).toBe('done');
    expect((await store.get<Row>('rows', 'a'))?.name).toBe('照写');
  });
});
