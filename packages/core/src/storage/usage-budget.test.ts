import { describe, expect, it } from 'vitest';
import { conversationId, instanceId, roomId } from '../model/ids.js';
import type { EntityStore } from '../platform/entity-store.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import { evaluateBudget, extraCallsOf } from './budget.js';
import { Repository } from './repository.js';
import {
  createUsageLedger,
  summarizeUsage,
  summarizeUsageForBudget,
  USAGE_COLLECTION,
  type UsageFilter,
  type UsageLedger,
  type UsageRecord,
} from './usage.js';

const A = roomId('fixture-world-a'),
  B = roomId('fixture-world-b');
const C = conversationId('fixture-conversation');
const T0 = '2026-01-01T00:00:00.000Z',
  T1 = '2026-01-02T00:00:00.000Z';
function records(): UsageRecord[] {
  return Array.from({ length: 12 }, (_, i) => ({
    id: `fixture-${i}`,
    roomId: i < 9 ? A : B,
    conversationId: i % 2 ? C : conversationId('other'),
    turnId: `turn-${i % 3}`,
    category: i % 3 === 0 ? 'generation' : i % 3 === 1 ? 'analysis' : 'intent',
    model: `model-${i % 4}`,
    promptTokens: i === 1 ? 0 : 101 + i,
    completionTokens: i * 3,
    promptEstimate: i % 3 ? 200 : null,
    speakerInstanceId: instanceId(`speaker-${i % 2}`),
    speakerName: `fixture-name-${i}`,
    price: i % 4 === 0 ? null : { inputPerMillion: 3, outputPerMillion: 7, currency: i % 2 ? 'CNY' : 'USD' },
    createdAt: i < 6 ? T0 : T1,
    updatedAt: i < 6 ? T0 : T1,
  }));
}
async function check(ledger: UsageLedger, filter: UsageFilter = {}) {
  if (!ledger.budgetSummary) throw new Error('fixture requires budgetSummary');
  const full = await ledger.summary(filter),
    compact = await ledger.budgetSummary(filter);
  expect(compact.total).toEqual(full.total);
  expect(compact.extraCalls).toBe(extraCallsOf(full));
  for (const limits of [null, { maxExtraCalls: 3 }, { maxCost: 0.0001 }, { maxExtraCalls: 3, maxCost: 0.1 }]) {
    expect(evaluateBudget(compact, limits)).toEqual(evaluateBudget(full, limits));
  }
  return compact;
}

describe('顺序118：预算专用汇总与全扫描参考一致', () => {
  it('多币种、无单价、零token和校准合计保持原始数值，不换算、不伪造免费', () => {
    const rows = records(),
      full = summarizeUsage(rows),
      compact = summarizeUsageForBudget(rows);
    expect(compact.total).toEqual(full.total);
    expect(compact.extraCalls).toBe(extraCallsOf(full));
    expect(compact.total.pricedCalls).toBeLessThan(compact.total.calls);
    expect(compact.total.costs.map((cost) => cost.currency).sort()).toEqual(['CNY', 'USD']);
    expect(compact.total.calibration).toEqual(full.total.calibration);
  });
  it('预算路径无需读取模型、角色ID/名字等分组字段', () => {
    const row = records()[0];
    if (!row) throw new Error('fixture');
    for (const field of ['model', 'speakerName', 'speakerInstanceId'])
      Object.defineProperty(row, field, {
        get() {
          throw new Error('unused breakdown accessed');
        },
      });
    expect(summarizeUsageForBudget([row]).total.calls).toBe(1);
  });
  it('空账单保持null金额与零调用，不额外触发熔断', () => {
    const compact = summarizeUsageForBudget([]);
    expect(compact.total.cost).toBeNull();
    expect(compact.total.costs).toEqual([]);
    expect(compact.extraCalls).toBe(0);
    expect(evaluateBudget(compact, { maxCost: 1, maxExtraCalls: 1 }).burned).toBe(false);
  });
  const filters: UsageFilter[] = [
    {},
    { roomId: A },
    { roomId: B },
    { conversationId: C },
    { turnId: 'turn-1' },
    { category: 'analysis' },
    { since: T1 },
    { roomId: A, conversationId: C, since: T1 },
    { roomId: A, conversationId: C, turnId: 'turn-1', category: 'analysis' },
    { roomId: roomId('absent') },
  ];
  it.each(filters)('过滤%s与既有summary及预算判定完全一致', async (filter) => {
    const store = createMemoryEntityStore();
    await store.bulkPut(USAGE_COLLECTION, records());
    await check(createUsageLedger(store), filter);
  });
  it('精确时间边界与无listSince后端回退一致', async () => {
    const store = createMemoryEntityStore();
    await store.bulkPut(USAGE_COLLECTION, records());
    const plain: EntityStore = { ...store, listSince: undefined };
    expect(await check(createUsageLedger(plain), { roomId: A, since: T1 })).toEqual(
      await check(createUsageLedger(store), { roomId: A, since: T1 }),
    );
  });
  it('另一ledger补录旧时间、零token真实调用后立即可见，不使用时间水位缓存', async () => {
    const store = createMemoryEntityStore();
    await store.bulkPut(USAGE_COLLECTION, records());
    const first = createUsageLedger(store),
      second = createUsageLedger(store);
    const before = await check(first, { roomId: A });
    await second.record({
      roomId: A,
      category: 'analysis',
      model: 'fixture-late',
      promptTokens: 0,
      completionTokens: 0,
      at: '2020-01-01T00:00:00.000Z',
    });
    const after = await check(first, { roomId: A });
    expect(after.total.calls).toBe(before.total.calls + 1);
    expect(after.extraCalls).toBe(before.extraCalls + 1);
  });
  it('绕过ledger同ID更改单价与同数量删除/新增，也不会读到旧汇总', async () => {
    const rows = records(),
      store = createMemoryEntityStore();
    await store.bulkPut(USAGE_COLLECTION, rows);
    const ledger = createUsageLedger(store);
    const before = await check(ledger, { roomId: A });
    const row = rows[1];
    if (!row) throw new Error('fixture');
    await store.put(USAGE_COLLECTION, {
      ...row,
      promptTokens: 500000,
      price: { inputPerMillion: 12, outputPerMillion: 0, currency: 'CNY' },
    });
    const sameId = await check(ledger, { roomId: A });
    expect(sameId.total.calls).toBe(before.total.calls);
    expect(sameId.total.costs).not.toEqual(before.total.costs);
    await store.remove(USAGE_COLLECTION, row.id);
    await store.put(USAGE_COLLECTION, {
      ...row,
      id: 'replacement',
      promptTokens: 1000000,
      price: { inputPerMillion: 99, outputPerMillion: 0, currency: 'USD' },
    });
    const after = await check(ledger, { roomId: A });
    expect(after.total.calls).toBe(before.total.calls);
    expect(after.total.costs).not.toEqual(before.total.costs);
  });
  it('ledger删除和Repository.deleteRoom直写删除都即时生效，其他世界不变', async () => {
    const store = createMemoryEntityStore(),
      repository = new Repository(store);
    await store.bulkPut(USAGE_COLLECTION, records());
    const ledger = createUsageLedger(store);
    const other = await check(ledger, { roomId: B });
    await ledger.removeByRoom(A);
    expect((await check(ledger, { roomId: A })).total.calls).toBe(0);
    await store.bulkPut(USAGE_COLLECTION, records());
    await repository.deleteRoom(A);
    expect((await check(ledger, { roomId: A })).total.calls).toBe(0);
    expect(await check(ledger, { roomId: B })).toEqual(other);
  });
  it('单次预算查询仍只有一次原始读取，不声称已消除扫描；读取失败原样上抛', async () => {
    const base = createMemoryEntityStore();
    await base.bulkPut(USAGE_COLLECTION, records());
    let reads = 0,
      fail = false;
    const spy: EntityStore = {
      ...base,
      list: async (collection, query) => {
        reads++;
        if (fail) throw new Error('fixture read failed');
        return base.list(collection, query);
      },
    };
    const ledger = createUsageLedger(spy);
    if (!ledger.budgetSummary) throw new Error('fixture');
    await ledger.budgetSummary({ roomId: A });
    expect(reads).toBe(1);
    fail = true;
    await expect(ledger.budgetSummary({ roomId: A })).rejects.toThrow('fixture read failed');
    expect(reads).toBe(2);
  });
  it('既有迁移11完成后，旧时间戳记录在索引/回退预算查询中一致', async () => {
    const store = createMemoryEntityStore();
    const row = records()[1];
    if (!row) throw new Error('fixture');
    const { updatedAt: _oldTimestamp, ...legacy } = row;
    await store.put(USAGE_COLLECTION, { ...legacy, id: 'legacy-missing', createdAt: T1 });
    await store.put(USAGE_COLLECTION, { ...legacy, id: 'legacy-mismatch', createdAt: T1, updatedAt: T0 });
    const report = await new Repository(store).migrate();
    expect(report.applied.some((migration) => migration.version === 11)).toBe(true);
    const indexed = await check(createUsageLedger(store), { roomId: A, since: T1 });
    const scanned = await check(createUsageLedger({ ...store, listSince: undefined }), { roomId: A, since: T1 });
    expect(indexed).toEqual(scanned);
    expect(indexed.total.calls).toBe(2);
  });
  it('旧适配器可不实现专用口，完整summary仍可用于熔断', async () => {
    const real = createUsageLedger(createMemoryEntityStore());
    const { budgetSummary: _optional, ...legacy } = real;
    const compatible: UsageLedger = legacy;
    expect(compatible.budgetSummary).toBeUndefined();
    const result = await (compatible.budgetSummary?.({ roomId: A }) ?? compatible.summary({ roomId: A }));
    expect(evaluateBudget(result, { maxExtraCalls: 1 }).extraCalls).toBe(0);
  });
});
