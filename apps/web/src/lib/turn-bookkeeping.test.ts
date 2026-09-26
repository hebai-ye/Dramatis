import { describe, expect, it, vi } from 'vitest';
import type { DramatisDb } from './db';
import { recordModelCall } from './turn-bookkeeping';

/**
 * 顺序 71：估算值必须与真实值一起进账单。
 *
 * 这一层是唯一能拿到 `assemblePrompt` 结果的地方（`generation.prompt.tokenEstimate`），
 * 所以「记账时把估算带上」这件事只能在调用方做对——`turn-bookkeeping` 只负责别把它丢掉。
 */
function fakeDb(): { db: DramatisDb; record: ReturnType<typeof vi.fn> } {
  const record = vi.fn(async () => undefined);
  const db = { ledger: { record } } as unknown as DramatisDb;
  return { db, record };
}

describe('一轮记账 · 顺序 71（估算随真实值一起入账）', () => {
  it('装配时的估算与真实 promptTokens 一起写进账单', async () => {
    const { db, record } = fakeDb();
    await recordModelCall(db, {
      category: 'generation',
      model: 'deepseek-chat',
      usage: { promptTokens: 130, completionTokens: 5 },
      promptEstimate: 100,
    });

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ promptTokens: 130, completionTokens: 5, promptEstimate: 100 }),
    );
  });

  it('没经过装配的那几条路（网页版桥接、后台分析）写 null，不编一个估算', async () => {
    const { db, record } = fakeDb();
    await recordModelCall(db, { category: 'analysis', model: 'm', usage: { promptTokens: 10 } });

    expect(record).toHaveBeenCalledWith(expect.objectContaining({ promptTokens: 10, promptEstimate: null }));
  });

  it('db 还没打开时什么都不做（调用方不必各自判空）', async () => {
    await expect(recordModelCall(null, { category: 'generation', model: 'm' })).resolves.toBeUndefined();
  });
});
