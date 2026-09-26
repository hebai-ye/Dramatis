import { describe, expect, it } from 'vitest';
import { conversationId, instanceId, newId, roomId } from '../model/ids.js';
import type { EntityQuery, EntityStore } from '../platform/entity-store.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import { SYNC_COLLECTIONS } from '../sync/types.js';
import { counterFromCalibration } from '../token/calibrate.js';
import { NARROW_CHARS_PER_TOKEN } from '../token/estimate.js';
import { COLLECTIONS, Repository } from './repository.js';
import {
  createUsageLedger,
  sanitizeTokens,
  summarizeUsage,
  USAGE_COLLECTION,
  type UsageFilter,
  type UsageLedger,
  type UsageRecord,
  usageCalibration,
} from './usage.js';

const PRICE = { inputPerMillion: 2, outputPerMillion: 8, currency: '¥' };

function ledger(): ReturnType<typeof createUsageLedger> {
  return createUsageLedger(createMemoryEntityStore());
}

describe('用量账单', () => {
  it('记一笔并读回来：token 与分组字段都保留', async () => {
    const usage = ledger();
    await usage.record({
      roomId: roomId('room-1'),
      conversationId: conversationId('conv-1'),
      turnId: 'turn-1',
      category: 'generation',
      model: 'deepseek-chat',
      promptTokens: 3500,
      completionTokens: 95,
      speakerInstanceId: instanceId('inst-1'),
      speakerName: '秦娘',
    });

    const records = await usage.list({ roomId: roomId('room-1') });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      category: 'generation',
      model: 'deepseek-chat',
      promptTokens: 3500,
      completionTokens: 95,
      speakerName: '秦娘',
      turnId: 'turn-1',
      price: null,
    });
  });

  it('清洗脏数据：负数、NaN、小数都按非负整数记', async () => {
    expect(sanitizeTokens(undefined)).toBe(0);
    expect(sanitizeTokens(Number.NaN)).toBe(0);
    expect(sanitizeTokens(Number.POSITIVE_INFINITY)).toBe(0);
    expect(sanitizeTokens(-5)).toBe(0);
    expect(sanitizeTokens(12.6)).toBe(13);
  });

  it('一次调用既没返回提示 token 也没返回输出 token，仍然记一笔（调用发生过）', async () => {
    const usage = ledger();
    const record = await usage.record({ category: 'analysis', model: 'deepseek-chat' });
    expect(record.promptTokens).toBe(0);
    expect(record.completionTokens).toBe(0);

    const summary = await usage.summary();
    expect(summary.total.calls).toBe(1);
    expect(summary.total.tokens).toBe(0);
  });

  it('汇总：总计、按类别、按角色、按模型各是一份账', async () => {
    const usage = ledger();
    const room = roomId('room-1');
    const qin = instanceId('inst-qin');
    const chen = instanceId('inst-chen');

    await usage.record({
      roomId: room,
      category: 'generation',
      model: 'deepseek-chat',
      promptTokens: 1000,
      completionTokens: 100,
      speakerInstanceId: qin,
      speakerName: '秦娘',
    });
    await usage.record({
      roomId: room,
      category: 'generation',
      model: 'deepseek-chat',
      promptTokens: 2000,
      completionTokens: 200,
      speakerInstanceId: chen,
      speakerName: '陈九',
    });
    await usage.record({
      roomId: room,
      category: 'intent',
      model: 'deepseek-chat',
      promptTokens: 1400,
      completionTokens: 40,
    });
    await usage.record({
      roomId: room,
      category: 'analysis',
      model: 'deepseek-chat',
      promptTokens: 1400,
      completionTokens: 300,
    });

    const summary = await usage.summary({ roomId: room });
    expect(summary.total.calls).toBe(4);
    expect(summary.total.promptTokens).toBe(5800);
    expect(summary.total.completionTokens).toBe(640);
    expect(summary.total.tokens).toBe(6440);

    const byCategory = new Map(summary.byCategory.map((group) => [group.key, group.totals.tokens]));
    expect(byCategory.get('generation')).toBe(3300);
    expect(byCategory.get('intent')).toBe(1440);
    expect(byCategory.get('analysis')).toBe(1700);

    // 按角色只算生成类：后台调用不属于任何角色
    expect(summary.bySpeaker.map((group) => group.label)).toEqual(['陈九', '秦娘']);
    expect(summary.bySpeaker[0]?.totals.calls).toBe(1);

    expect(summary.byModel).toHaveLength(1);
    expect(summary.byModel[0]?.key).toBe('deepseek-chat');
  });

  it('没配单价就只报 token，不编钱；配了才换算', async () => {
    const usage = ledger();
    await usage.record({ category: 'generation', model: 'm', promptTokens: 1_000_000, completionTokens: 0 });

    const noPrice = await usage.summary();
    expect(noPrice.total.cost).toBeNull();
    expect(noPrice.total.pricedCalls).toBe(0);
    expect(noPrice.total.tokens).toBe(1_000_000);

    await usage.record({
      category: 'intent',
      model: 'm',
      promptTokens: 250_000,
      completionTokens: 500_000,
      price: PRICE,
    });

    const partial = await usage.summary();
    // 只有配了单价的那一条参与换算：2 元/百万 × 0.25 + 8 元/百万 × 0.5 = 4.5
    expect(partial.total.cost).toBeCloseTo(4.5, 6);
    expect(partial.total.pricedCalls).toBe(1);
    expect(partial.total.calls).toBe(2);
    expect(partial.total.currency).toBe('¥');
  });

  it('按房间、对话、回合、类别筛选', async () => {
    const usage = ledger();
    await usage.record({
      roomId: roomId('room-a'),
      conversationId: conversationId('conv-1'),
      turnId: 't1',
      category: 'generation',
      model: 'm',
      promptTokens: 10,
    });
    await usage.record({
      roomId: roomId('room-a'),
      conversationId: conversationId('conv-2'),
      turnId: 't2',
      category: 'intent',
      model: 'm',
      promptTokens: 20,
    });
    await usage.record({
      roomId: roomId('room-b'),
      conversationId: conversationId('conv-3'),
      turnId: 't3',
      category: 'generation',
      model: 'm',
      promptTokens: 40,
    });

    expect((await usage.summary({ roomId: roomId('room-a') })).total.promptTokens).toBe(30);
    expect((await usage.summary({ conversationId: conversationId('conv-2') })).total.promptTokens).toBe(20);
    expect((await usage.summary({ turnId: 't3' })).total.promptTokens).toBe(40);
    expect((await usage.summary({ category: 'generation' })).total.promptTokens).toBe(50);
  });

  it('limit 取最近几条，且仍按时间正序', async () => {
    const usage = ledger();
    for (const [index, tokens] of [10, 20, 30].entries()) {
      await usage.record({
        category: 'generation',
        model: 'm',
        promptTokens: tokens,
        at: `2026-09-19T00:0${String(index)}:00.000Z`,
      });
    }

    const recent = await usage.list({}, 2);
    expect(recent.map((record) => record.promptTokens)).toEqual([20, 30]);
  });

  it('删掉整个世界时账单一起清掉，别的世界不受影响', async () => {
    const store = createMemoryEntityStore();
    const usage = createUsageLedger(store);
    const repository = new Repository(store);

    const room = roomId('room-1');
    await repository.saveRoom({
      id: room,
      title: '旧城',
      playerName: '我',
      playerPersona: '',
      personaId: null,
      cardIds: [],
      instanceIds: [],
      worldBookIds: [],
      activeConversationId: null,
      createdAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:00:00.000Z',
      deletedAt: null,
    });
    await usage.record({ roomId: room, category: 'generation', model: 'm', promptTokens: 100 });
    await usage.record({ roomId: roomId('room-2'), category: 'generation', model: 'm', promptTokens: 200 });

    await repository.deleteRoom(room);

    const remaining = await usage.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.roomId).toBe('room-2');
  });

  it('汇总函数是纯函数：同一批流水算两次结果一样，也不改输入', () => {
    const records: UsageRecord[] = [
      {
        id: newId(),
        roomId: null,
        conversationId: null,
        turnId: null,
        category: 'admin',
        model: 'm',
        promptTokens: 5,
        completionTokens: 7,
        speakerInstanceId: null,
        speakerName: '',
        price: null,
        createdAt: '2026-09-19T00:00:00.000Z',
        updatedAt: '2026-09-19T00:00:00.000Z',
      },
    ];

    const first = summarizeUsage(records);
    const second = summarizeUsage(records);
    expect(first.total.tokens).toBe(12);
    expect(second.total.tokens).toBe(12);
    expect(records[0]?.promptTokens).toBe(5);
    expect(first.firstAt).toBe('2026-09-19T00:00:00.000Z');
    expect(first.lastAt).toBe('2026-09-19T00:00:00.000Z');
  });
});

/* ------------------------------------------------------------------ *
 * 顺序 68：`since` 下推到 `updatedAt` 索引 + 汇总不再排序
 * ------------------------------------------------------------------ */

/** 去掉 `listSince` 的后端：用来对账「下推读」与「整表读」的结果必须逐条一致。 */
function withoutListSince(store: EntityStore): EntityStore {
  const { listSince: _dropped, ...rest } = store;
  return rest;
}

/** 把每次 `list` / `listSince` 的调用记下来，用来断言下推真的发生了、且没在存储层排序。 */
function countingStore(store: EntityStore): {
  store: EntityStore;
  queries: Array<EntityQuery | undefined>;
  sinceCalls: Array<{ updatedAt: string; inclusive: boolean }>;
} {
  const queries: Array<EntityQuery | undefined> = [];
  const sinceCalls: Array<{ updatedAt: string; inclusive: boolean }> = [];
  return {
    queries,
    sinceCalls,
    store: {
      ...store,
      async list<T>(collection: string, query?: EntityQuery): Promise<T[]> {
        queries.push(query);
        return store.list<T>(collection, query);
      },
      async listSince<T>(collection: string, updatedAt: string, options?: { inclusive?: boolean }): Promise<T[]> {
        sinceCalls.push({ updatedAt, inclusive: options?.inclusive ?? false });
        if (store.listSince === undefined) throw new Error('测试用的底层实现必须提供 listSince');
        return store.listSince<T>(collection, updatedAt, options);
      },
    },
  };
}

const T1 = '2026-09-25T10:00:00.000Z';
const T2 = '2026-09-25T10:00:01.000Z';
const T3 = '2026-09-25T10:00:02.000Z';
const T4 = '2026-09-25T10:00:03.000Z';

describe('用量账单 · 顺序 68', () => {
  const room = roomId('room-68');

  async function ledgerWithLegacyRecords(): Promise<{ usage: UsageLedger; store: EntityStore }> {
    const store = createMemoryEntityStore();
    const usage = createUsageLedger(store);
    for (const [index, at] of [T1, T2, T3, T4].entries()) {
      await usage.record({ roomId: room, category: 'generation', model: 'm', promptTokens: (index + 1) * 10, at });
    }
    return { usage, store };
  }

  it('每笔流水的 updatedAt 恒等于 createdAt（下推赖以成立的不变量）', async () => {
    const usage = ledger();
    const record = await usage.record({ category: 'generation', model: 'm', promptTokens: 7, at: T1 });
    expect(record.createdAt).toBe(T1);
    expect(record.updatedAt).toBe(T1);
    expect((await usage.list())[0]?.updatedAt).toBe(T1);
  });

  it('since 是「含等于」：正好落在 since 上的那一条必须回来', async () => {
    const { usage } = await ledgerWithLegacyRecords();
    const records = await usage.list({ roomId: room, since: T2 });
    expect(records.map((record) => record.createdAt)).toEqual([T2, T3, T4]);
  });

  it('下推读与整表读逐条一致（含 / 不含 since、带 limit、并列同一毫秒）', async () => {
    const { usage, store } = await ledgerWithLegacyRecords();
    const scanned = createUsageLedger(withoutListSince(store));

    // 再来一批同一毫秒的：并列时两条路径的底层顺序不同（索引序 vs 主键序），
    // 全靠 `(createdAt, id)` 定序把结果钉死。
    for (let index = 0; index < 5; index += 1) {
      await usage.record({ roomId: room, category: 'intent', model: 'm', promptTokens: index, at: T4 });
    }

    for (const filter of [
      { roomId: room },
      { roomId: room, since: T2 },
      { since: T1 },
      { category: 'intent' },
    ] as UsageFilter[]) {
      const pushed = await usage.list(filter);
      const full = await scanned.list(filter);
      expect(pushed.map((record) => record.id)).toEqual(full.map((record) => record.id));
      expect(JSON.stringify(pushed)).toBe(JSON.stringify(full));

      const pushedLimited = await usage.list(filter, 3);
      const fullLimited = await scanned.list(filter, 3);
      expect(pushedLimited.map((record) => record.id)).toEqual(fullLimited.map((record) => record.id));

      expect(await usage.summary(filter)).toEqual(await scanned.summary(filter));
    }
  });

  it('汇总与记录的到达顺序无关（所以不必先排序）', async () => {
    // 两组分组各自 token 相等 → 排序并列，这时分组次序只能靠 key 兜住
    const records = [
      { category: 'generation' as const, model: 'm-b', promptTokens: 100, at: T1 },
      { category: 'generation' as const, model: 'm-a', promptTokens: 100, at: T2 },
      { category: 'intent' as const, model: 'm-b', promptTokens: 100, at: T3 },
      { category: 'intent' as const, model: 'm-a', promptTokens: 100, at: T4 },
    ];

    const forward = createUsageLedger(createMemoryEntityStore());
    const backward = createUsageLedger(createMemoryEntityStore());
    for (const entry of records) await forward.record({ roomId: room, ...entry });
    for (const entry of [...records].reverse()) await backward.record({ roomId: room, ...entry });

    expect(await backward.summary({ roomId: room })).toEqual(await forward.summary({ roomId: room }));
    expect((await forward.summary({ roomId: room })).byModel.map((group) => group.key)).toEqual(['m-a', 'm-b']);
  });

  it('summary 不向存储层要排序、也不走增量口；带 since 的读走增量口且含等于', async () => {
    const base = createMemoryEntityStore();
    const spy = countingStore(base);
    const usage = createUsageLedger(spy.store);
    await usage.record({ roomId: room, category: 'generation', model: 'm', promptTokens: 10, at: T1 });
    await usage.record({ roomId: room, category: 'generation', model: 'm', promptTokens: 20, at: T2 });
    spy.queries.length = 0;
    spy.sinceCalls.length = 0;

    const summary = await usage.summary({ roomId: room });
    expect(summary.total.tokens).toBe(30);
    expect(spy.queries).toHaveLength(1);
    // 排序改由账单自己做（要按 id 钉死并列），存储层不该再收到 orderBy
    expect(spy.queries.every((query) => query?.orderBy === undefined)).toBe(true);
    expect(spy.sinceCalls).toHaveLength(0);

    spy.queries.length = 0;
    await usage.list({ roomId: room, since: T2 });
    expect(spy.sinceCalls).toEqual([{ updatedAt: T2, inclusive: true }]);
    expect(spy.queries).toHaveLength(0);
  });

  it('老账单缺 updatedAt 时确实会被索引漏掉（所以迁移 11 不是可选的）', async () => {
    const store = createMemoryEntityStore();
    // 模拟顺序 68 之前的落盘形态：有 createdAt，没有 updatedAt
    await store.put(USAGE_COLLECTION, {
      id: 'legacy-1',
      roomId: room,
      conversationId: null,
      turnId: null,
      category: 'generation',
      model: 'm',
      promptTokens: 500,
      completionTokens: 0,
      speakerInstanceId: null,
      speakerName: '',
      price: null,
      createdAt: T1,
    });

    const usage = createUsageLedger(store);
    expect(await usage.list({ since: T1 })).toEqual([]);
    // 不带 since 的整表读仍然看得见它——这也是「少算钱」不会当场暴露的原因
    expect((await usage.list()).map((record) => record.id)).toEqual(['legacy-1']);
  });

  it('迁移 11：把老账单的 updatedAt 归一到 createdAt', async () => {
    const store = createMemoryEntityStore();
    const legacy = {
      roomId: room,
      conversationId: null,
      turnId: null,
      category: 'generation' as const,
      model: 'm',
      promptTokens: 500,
      completionTokens: 0,
      speakerInstanceId: null,
      speakerName: '',
      price: null,
    };
    await store.put(USAGE_COLLECTION, { ...legacy, id: 'legacy-plain', createdAt: T1 });
    // 与 createdAt 不一致的值：账单里这个字段是派生字段，迁移动到与 createdAt 相等，
    // 否则「下推读按 updatedAt、整表读按 createdAt」会在这条记录上分叉。
    await store.put(USAGE_COLLECTION, {
      ...legacy,
      id: 'legacy-odd',
      createdAt: T2,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const repository = new Repository(store);
    const report = await repository.migrate();
    expect(report.applied.map((migration) => migration.version)).toContain(11);

    const migrated = await store.list<UsageRecord>(USAGE_COLLECTION);
    for (const record of migrated) expect(record.updatedAt).toBe(record.createdAt);
    expect(migrated.map((record) => record.id)).toEqual(['legacy-plain', 'legacy-odd']);

    // 迁移之后，下推读才看得见这批老账，且两条读路径逐条一致
    const usage = createUsageLedger(store);
    const scanned = createUsageLedger(withoutListSince(store));
    const pushed = await usage.list({ since: T1 });
    expect(pushed.map((record) => record.id)).toEqual(['legacy-plain', 'legacy-odd']);
    expect(pushed.map((record) => record.id)).toEqual((await scanned.list({ since: T1 })).map((record) => record.id));
    expect((await usage.summary({ since: T1 })).total.promptTokens).toBe(1000);
  });

  it('账单不参与同步：所以给它盖 updatedAt 不会改变任何同步行为', () => {
    expect(SYNC_COLLECTIONS as readonly string[]).not.toContain(USAGE_COLLECTION);
    // 顺带钉住白名单里确实没有它——上面那条断言依赖的就是这一点
    expect(COLLECTIONS.usageRecords).toBe(USAGE_COLLECTION);
  });
});

/** 一条用来算账的合成流水：单价 1/百万 token，于是 `promptTokens` 就是金额本身。 */
function pricedRecord(currency: string, promptTokens: number, id: string): UsageRecord {
  return {
    id,
    roomId: null,
    conversationId: null,
    turnId: null,
    category: 'generation',
    model: 'm',
    promptTokens,
    completionTokens: 0,
    speakerInstanceId: null,
    speakerName: '甲',
    price: { inputPerMillion: 1_000_000, outputPerMillion: 0, currency },
    createdAt: T1,
    updatedAt: T1,
  };
}

describe('用量账单 · 审计 B9（多币种）', () => {
  /*
   * 审计原话：usage.ts 把不同币种的金额**直接相加**，¥10 与 $10 会变成 20，
   * 而且币种取的是第一条记录碰巧用的那个。修法：按币种分组累加，
   * 主显示取最主要的一种，其余留给界面写「另计」；不做汇率换算。
   */
  it('不同币种各自累加，绝不加成一个数', () => {
    const summary = summarizeUsage([pricedRecord('¥', 10, 'a'), pricedRecord('¥', 20, 'b'), pricedRecord('$', 5, 'c')]);

    // 主币种是条数最多的那一种；金额只是它自己的
    expect(summary.total.currency).toBe('¥');
    expect(summary.total.cost).toBeCloseTo(30, 6);
    // 计费条数是全部（含其他币种），这样「N/M 次有单价」不会漏报
    expect(summary.total.pricedCalls).toBe(3);
    expect(summary.total.costs).toEqual([
      { currency: '¥', cost: 30, pricedCalls: 2 },
      { currency: '$', cost: 5, pricedCalls: 1 },
    ]);
  });

  it('条数并列时按币种名定序：所以主币种不随记录到达顺序变', () => {
    const yen = pricedRecord('¥', 10, 'a');
    const dollar = pricedRecord('$', 5, 'b');

    const forward = summarizeUsage([yen, dollar]);
    const backward = summarizeUsage([dollar, yen]);

    // '$'（U+0024）排在 '¥'（U+00A5）前面，与输入顺序无关
    expect(forward.total.currency).toBe('$');
    expect(forward.total.cost).toBeCloseTo(5, 6);
    expect(backward.total.currency).toBe('$');
    expect(JSON.stringify(forward)).toBe(JSON.stringify(backward));
  });

  it('没配单价的那部分不产生币种条目，也不影响主币种', () => {
    const unpriced = { ...pricedRecord('¥', 100, 'a'), price: null };
    const summary = summarizeUsage([unpriced, pricedRecord('$', 7, 'b')]);

    expect(summary.total.currency).toBe('$');
    expect(summary.total.cost).toBeCloseTo(7, 6);
    expect(summary.total.calls).toBe(2);
    expect(summary.total.pricedCalls).toBe(1);
    expect(summary.total.costs).toEqual([{ currency: '$', cost: 7, pricedCalls: 1 }]);
  });

  it('分组账（按类别、按模型）也各自按币种分开', () => {
    const other = { ...pricedRecord('$', 3, 'c'), category: 'intent' as const, model: 'n' };
    const summary = summarizeUsage([pricedRecord('¥', 40, 'a'), other]);

    const generation = summary.byCategory.find((group) => group.key === 'generation');
    expect(generation?.totals.currency).toBe('¥');
    expect(generation?.totals.cost).toBeCloseTo(40, 6);

    const intent = summary.byCategory.find((group) => group.key === 'intent');
    expect(intent?.totals.currency).toBe('$');
    expect(intent?.totals.cost).toBeCloseTo(3, 6);

    // 两种币种都进了总计，各自记着各自的条数
    expect(summary.total.costs.map((item) => item.currency).sort()).toEqual(['$', '¥']);
  });
});

/**
 * 一条带估算配对的流水：`promptEstimate` 是装配时的估算，`promptTokens` 是服务端真实值。
 * 单价清掉——这里测的是校准，不是钱。
 */
function estimatedRecord(estimated: number | null, actual: number, id: string): UsageRecord {
  return { ...pricedRecord('¥', actual, id), price: null, promptEstimate: estimated };
}

describe('用量账单 · 顺序 71（估算与真实配对）', () => {
  /*
   * 审计 B12：启发式估算按「窄字符 4 个一 token」，真实 promptTokens 比它高。要调口径
   * 就得先知道高多少，而那个数只能来自真实调用——于是每次生成把装配时的估算和真实值
   * 一起记下来（**不存正文**），这里测的就是这份配对账。
   */
  it('只有两半都有的调用才配对：只估不真、只真不估都丢掉', async () => {
    const usage = ledger();
    await usage.record({ category: 'generation', model: 'm', promptTokens: 130, promptEstimate: 100 });
    // 本地模型不回 usage：估了也没有真实值可比
    await usage.record({ category: 'generation', model: 'm', promptTokens: 0, promptEstimate: 50 });
    // 网页版桥接 / 后台分析：这一路没有经过 assemblePrompt，没有估算
    await usage.record({ category: 'generation', model: 'm', promptTokens: 200 });

    const summary = await usage.summary();
    expect(summary.total.calibration).toEqual({ calls: 1, estimated: 100, actual: 130 });
    // 但钱与 token 照旧全部计入——配对只是多记一组数，不改原有账
    expect(summary.total.calls).toBe(3);
    expect(summary.total.promptTokens).toBe(330);
  });

  it('从汇总里读出低估比例与建议除数', async () => {
    const usage = ledger();
    await usage.record({ category: 'generation', model: 'm', promptTokens: 130, promptEstimate: 100 });

    const report = usageCalibration((await usage.summary()).total);
    expect(report.samples).toBe(1);
    expect(report.ratio).toBeCloseTo(1.3, 6);
    expect(report.suggestedNarrowDivisor).toBe(3.1);
    // 报告能直接变成一个计数器：估算 100 的一条，从此按 1.3 倍报
    expect(counterFromCalibration(report)?.count('a'.repeat(100))).toBe(33);
  });

  it('没有配对样本时不下结论：ratio 为 null、除数保持默认', async () => {
    const usage = ledger();
    await usage.record({ category: 'analysis', model: 'm', promptTokens: 500 });

    const report = usageCalibration((await usage.summary()).total);
    expect(report.samples).toBe(0);
    expect(report.ratio).toBeNull();
    expect(report.suggestedNarrowDivisor).toBe(NARROW_CHARS_PER_TOKEN);
    expect(counterFromCalibration(report)).toBeNull();
  });

  it('没填估算存成 null；脏值被清洗成 0 后也不参与配对', async () => {
    const usage = ledger();
    const plain = await usage.record({ category: 'analysis', model: 'm', promptTokens: 10 });
    expect(plain.promptEstimate).toBeNull();

    const dirty = await usage.record({ category: 'analysis', model: 'm', promptTokens: 10, promptEstimate: -5 });
    expect(dirty.promptEstimate).toBe(0);

    expect((await usage.summary()).total.calibration).toEqual({ calls: 0, estimated: 0, actual: 0 });
  });

  it('分组账各自带配对：能看出是哪一路估得偏', () => {
    const summary = summarizeUsage([estimatedRecord(100, 130, 'a'), { ...estimatedRecord(200, 240, 'b'), model: 'n' }]);

    expect(summary.byModel.find((group) => group.key === 'm')?.totals.calibration).toEqual({
      calls: 1,
      estimated: 100,
      actual: 130,
    });
    expect(summary.byModel.find((group) => group.key === 'n')?.totals.calibration).toEqual({
      calls: 1,
      estimated: 200,
      actual: 240,
    });
    expect(summary.total.calibration).toEqual({ calls: 2, estimated: 300, actual: 370 });
  });

  it('老账本没有这个字段：汇总照旧，不炸也不编一个比例出来', () => {
    const summary = summarizeUsage([pricedRecord('¥', 100, 'a')]);
    expect(summary.total.calibration).toEqual({ calls: 0, estimated: 0, actual: 0 });
    expect(usageCalibration(summary.total).ratio).toBeNull();
  });
});
