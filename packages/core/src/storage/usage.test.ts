import { describe, expect, it } from 'vitest';
import { conversationId, instanceId, newId, roomId } from '../model/ids.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import { Repository } from './repository.js';
import { createUsageLedger, sanitizeTokens, summarizeUsage, type UsageRecord } from './usage.js';

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
