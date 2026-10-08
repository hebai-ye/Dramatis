import { describe, expect, it } from 'vitest';
import { conversationId, instanceId, roomId } from '../model/ids.js';
import type { EntityQuery, EntityStore } from '../platform/entity-store.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import { Repository } from './repository.js';
import {
  createUsageLedger,
  summarizeUsage,
  summarizeUsageScope,
  USAGE_COLLECTION,
  type UsageRecord,
  type UsageScope,
} from './usage.js';

const A = roomId('scope-world-a'),
  B = roomId('scope-world-b'),
  C = conversationId('scope-conversation');
function rows(): UsageRecord[] {
  return Array.from({ length: 18 }, (_, index) => ({
    id: `fixture-${String(index).padStart(2, '0')}`,
    roomId: index < 12 ? A : B,
    conversationId: index % 2 ? C : conversationId('other-conversation'),
    turnId: `turn-${index % 3}`,
    category: index % 3 === 0 ? 'generation' : index % 3 === 1 ? 'analysis' : 'intent',
    model: `fixture-model-${index % 4}`,
    promptTokens: index === 1 ? 0 : index * 37,
    completionTokens: index * 3,
    promptEstimate: index % 4 ? index * 31 : null,
    speakerInstanceId: instanceId(`speaker-${index % 2}`),
    speakerName: `name-${index % 2}`,
    price: index % 4 ? { inputPerMillion: 3, outputPerMillion: 7, currency: index % 2 ? 'CNY' : 'USD' } : null,
    createdAt: index < 9 ? '2026-01-01T00:00:00.000Z' : '2026-01-02T00:00:00.000Z',
    updatedAt: index < 9 ? '2026-01-01T00:00:00.000Z' : '2026-01-02T00:00:00.000Z',
  }));
}
function expected(records: UsageRecord[], scope: UsageScope) {
  if (scope.roomId === null) return { world: null, conversation: null, latestTurn: null };
  const world = records.filter((record) => record.roomId === scope.roomId);
  const conversation =
    scope.conversationId === null ? null : world.filter((record) => record.conversationId === scope.conversationId);
  return {
    world: summarizeUsage(world),
    conversation: conversation === null ? null : summarizeUsage(conversation),
    latestTurn:
      conversation === null || scope.turnId == null
        ? null
        : summarizeUsage(conversation.filter((record) => record.turnId === scope.turnId)),
  };
}
const scopes: UsageScope[] = [
  { roomId: A, conversationId: C, turnId: 'turn-1' },
  { roomId: A, conversationId: C },
  { roomId: A, conversationId: C, turnId: null },
  { roomId: A, conversationId: null, turnId: 'turn-1' },
  { roomId: B, conversationId: C, turnId: 'turn-1' },
  { roomId: A, conversationId: conversationId('missing'), turnId: 'turn-1' },
  { roomId: roomId('missing'), conversationId: C },
  { roomId: null, conversationId: C, turnId: 'turn-1' },
];
describe('顺序119：一次原始读取生成三份账单视图', () => {
  it.each(scopes)('scope %s与既有汇总逐字段一致，最多一次读取', async (scope) => {
    const records = rows(),
      base = createMemoryEntityStore();
    await base.bulkPut(USAGE_COLLECTION, records);
    let reads = 0;
    const store: EntityStore = {
      ...base,
      list: async <T>(collection: string, query?: EntityQuery) => {
        reads++;
        expect(query?.where).toEqual({ roomId: scope.roomId });
        return base.list<T>(collection, query);
      },
    };
    const ledger = createUsageLedger(store);
    if (!ledger.scopeSummary) throw new Error('fixture');
    const result = await ledger.scopeSummary(scope);
    expect(result).toEqual(expected(records, scope));
    expect(reads).toBe(scope.roomId === null ? 0 : 1);
  });
  it('纯汇总隔离世界/对话/回合，不能因同名ID混入其他世界', () => {
    const source = rows(),
      scope = scopes[0];
    if (!scope) throw new Error('fixture');
    const before = structuredClone(source);
    expect(summarizeUsageScope(source, scope)).toEqual(expected(source, scope));
    expect(source).toEqual(before);
  });
  it('三份结果不共享可变累计值，调用方修改不会污染下一次读取', async () => {
    const source = rows(),
      store = createMemoryEntityStore();
    await store.bulkPut(USAGE_COLLECTION, source);
    const ledger = createUsageLedger(store),
      scope = scopes[0];
    if (!ledger.scopeSummary || !scope) throw new Error('fixture');
    const result = await ledger.scopeSummary(scope);
    if (!result.world || !result.conversation) throw new Error('fixture');
    const conversationCalls = result.conversation.total.calls;
    result.world.total.calls = -99;
    result.world.total.costs.length = 0;
    expect(result.conversation.total.calls).toBe(conversationCalls);
    expect(await ledger.scopeSummary(scope)).toEqual(expected(source, scope));
  });
  it('单次快照后外部追加不会只进入其中某个视图，下次刷新才整体可见', async () => {
    const source = rows(),
      base = createMemoryEntityStore();
    await base.bulkPut(USAGE_COLLECTION, source);
    const appended = { ...source[1], id: 'late-row', roomId: A, conversationId: C, turnId: 'turn-1' } as UsageRecord;
    let inserted = false;
    const store: EntityStore = {
      ...base,
      list: async <T>(collection: string, query?: EntityQuery) => {
        const snapshot = await base.list<T>(collection, query);
        if (!inserted) {
          inserted = true;
          await base.put(USAGE_COLLECTION, appended);
        }
        return snapshot;
      },
    };
    const ledger = createUsageLedger(store),
      scope = scopes[0];
    if (!ledger.scopeSummary || !scope) throw new Error('fixture');
    expect(await ledger.scopeSummary(scope)).toEqual(expected(source, scope));
    expect(await ledger.scopeSummary(scope)).toEqual(expected([...source, appended], scope));
  });
  it('传入scope在异步读取期间被改动，也保持调用起点的归属', async () => {
    const source = rows(),
      base = createMemoryEntityStore();
    await base.bulkPut(USAGE_COLLECTION, source);
    const scope = { roomId: A, conversationId: C, turnId: 'turn-1' };
    const store: EntityStore = {
      ...base,
      list: async <T>(collection: string, query?: EntityQuery) => {
        scope.roomId = B;
        scope.turnId = 'turn-0';
        return base.list<T>(collection, query);
      },
    };
    const ledger = createUsageLedger(store);
    if (!ledger.scopeSummary) throw new Error('fixture');
    expect(await ledger.scopeSummary(scope)).toEqual(
      expected(source, { roomId: A, conversationId: C, turnId: 'turn-1' }),
    );
  });
  it('删除世界后刷新不使用旧缓存，其他世界不受影响', async () => {
    const store = createMemoryEntityStore();
    await store.bulkPut(USAGE_COLLECTION, rows());
    const ledger = createUsageLedger(store);
    if (!ledger.scopeSummary) throw new Error('fixture');
    const b = await ledger.scopeSummary({ roomId: B, conversationId: C });
    await ledger.scopeSummary({ roomId: A, conversationId: C });
    await new Repository(store).deleteRoom(A);
    expect((await ledger.scopeSummary({ roomId: A, conversationId: C })).world?.total.calls).toBe(0);
    expect(await ledger.scopeSummary({ roomId: B, conversationId: C })).toEqual(b);
  });
  it('原始读取错误不会伪装为空账单或部分成功', async () => {
    const base = createMemoryEntityStore();
    const ledger = createUsageLedger({
      ...base,
      list: async () => {
        throw new Error('fixture read error');
      },
    });
    if (!ledger.scopeSummary) throw new Error('fixture');
    await expect(ledger.scopeSummary({ roomId: A, conversationId: C, turnId: 'turn-1' })).rejects.toThrow(
      'fixture read error',
    );
  });
});
