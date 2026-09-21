/**
 * 「被回想」记账不能覆盖别人刚写下的改动（顺序 27a 演练里发现的真 bug）。
 *
 * 经过：合并给 20 条原文盖上「已被取代」的章，但演练里只剩 9 条——另外 11 条被
 * 回想记账那一步用**旧拷贝**整条写回去，章就没了。这个测试就是那条回归线。
 */

import { describe, expect, it } from 'vitest';
import { eventId, newId, nowIso, roomId } from '../model/ids.js';
import type { MemoryEvent } from '../model/message.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import { Repository } from './repository.js';

function memory(): MemoryEvent {
  return {
    id: eventId(newId()),
    roomId: roomId(newId()),
    conversationId: null,
    sceneId: null,
    timeline: { worldTime: '第一日', sequence: 1 },
    location: '',
    participants: [],
    summary: '一句日常经过',
    observerId: null,
    perception: '',
    importance: 0.3,
    pinned: false,
    importanceLocked: false,
    affects: [],
    sourceTurnIds: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    deletedAt: null,
    supersededBy: null,
    supersedes: [],
    consolidatedAt: null,
    lastRecalledAt: null,
    recallCount: 0,
  };
}

describe('回想记账不覆盖别人的改动（顺序 27a 的回归线）', () => {
  it('先盖章、后记账：章还在，记账也生效', async () => {
    const repo = new Repository(createMemoryEntityStore());
    const target = memory();
    await repo.saveMemories([target]);

    // 合并盖章（模拟另一个写者）
    const impressionId = eventId(newId());
    const stamped = await repo.getSyncRecord('memories', target.id);
    expect(stamped).not.toBeNull();
    await repo.saveMemories([{ ...target, supersededBy: impressionId, consolidatedAt: nowIso() }]);

    // 回想记账：**只传 id**（真实调用方手里那份是旧拷贝，这里刻意不传整条）
    const updated = await repo.markMemoriesRecalled([target.id], '2026-09-22T00:00:00.000Z');
    expect(updated).toHaveLength(1);

    const after = await repo.listMemories(target.roomId);
    const saved = after.find((item) => item.id === target.id);
    expect(saved?.recallCount).toBe(1);
    expect(saved?.lastRecalledAt).toBe('2026-09-22T00:00:00.000Z');
    // 关键：章没被抹掉
    expect(saved?.supersededBy).toBe(impressionId);
    expect(saved?.consolidatedAt).not.toBeNull();
  });

  it('已经删掉的记忆不再记账（别把墓碑写活）', async () => {
    const repo = new Repository(createMemoryEntityStore());
    const target = memory();
    await repo.saveMemories([target]);
    await repo.deleteMemory(target.id);

    const updated = await repo.markMemoriesRecalled([target.id], nowIso());
    expect(updated).toEqual([]);
  });
});
