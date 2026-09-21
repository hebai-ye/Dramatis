/**
 * 撤回一次采纳（顺序 26）。
 *
 * 「采纳之后就只能认了」在真实使用里会变成一种很危险的错觉：管理员起草的卡有好有坏，
 * 采纳之后才发现不合世界是常事。这条测试盯的是**撤回到底撤掉了什么**：
 * 素材库里那份被删掉、草稿退回待采纳、点两次结果一样。
 */

import { describe, expect, it } from 'vitest';
import { createBlankCard } from '../model/card.js';
import { messageId, newId, nowIso, roomId, sceneId } from '../model/ids.js';
import type { AdminArtifact, Message } from '../model/message.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import { Repository } from './repository.js';

async function repoWithDraft() {
  const repo = new Repository(createMemoryEntityStore());
  const card = createBlankCard({ name: '酒馆老板', firstMessage: '「进来坐，门我给你留着。」' });
  const artifact: AdminArtifact = {
    id: 'art-1',
    kind: 'character-card',
    title: card.name,
    summary: '一个话不多的酒馆老板',
    status: 'pending',
    payload: card,
    targetId: null,
    createdAt: nowIso(),
  };
  const roomIdValue = roomId(newId());
  const message: Message = {
    id: messageId(newId()),
    roomId: roomIdValue,
    conversationId: null,
    sceneId: sceneId(newId()),
    turnId: 'turn-1',
    localSeq: 0,
    deviceId: '',
    role: 'admin',
    speakerInstanceId: null,
    speakerName: '世界管理员',
    audience: [],
    content: '起草了一张卡。',
    artifacts: [artifact],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    deletedAt: null,
  };
  await repo.appendMessages(roomIdValue, [message]);
  return { repo, roomId: roomIdValue, message, card };
}

describe('撤回一次采纳（顺序 26）', () => {
  it('采纳 → 卡进素材库；撤回 → 卡被删掉、草稿退回待采纳', async () => {
    const { repo, message, card, roomId: room } = await repoWithDraft();

    const adopted = await repo.adoptAdminArtifact(message.id, 'art-1');
    expect(adopted?.artifact?.status).toBe('adopted');
    expect((await repo.listCards()).some((item) => item.id === adopted?.artifact?.targetId)).toBe(true);

    const reverted = await repo.revokeAdminArtifact(message.id, 'art-1');
    expect(reverted?.artifact?.status).toBe('pending');
    expect(reverted?.artifact?.targetId).toBeNull();
    // 素材库里那份没了（是软删除：列表里看不到，但记录还在，同步得出去）
    expect((await repo.listCards()).some((item) => item.id === card.id)).toBe(false);

    // 草稿本身还在消息上：撤回不是「扔掉它」
    const after = (await repo.listMessages(room)).find((item) => item.id === message.id);
    expect(after?.artifacts?.[0]?.status).toBe('pending');
  });

  it('点两次结果一样（幂等），而且不碰还没采纳的草稿', async () => {
    const { repo, message } = await repoWithDraft();
    await repo.adoptAdminArtifact(message.id, 'art-1');
    await repo.revokeAdminArtifact(message.id, 'art-1');
    const twice = await repo.revokeAdminArtifact(message.id, 'art-1');
    expect(twice?.artifact?.status).toBe('pending');

    // 还是待采纳的状态下再点：什么都不该发生
    const untouched = await repo.revokeAdminArtifact(message.id, 'art-1');
    expect(untouched?.artifact?.status).toBe('pending');
  });

  it('撤回来之后还能再采纳一次（不是一次性开关）', async () => {
    const { repo, message } = await repoWithDraft();
    await repo.adoptAdminArtifact(message.id, 'art-1');
    await repo.revokeAdminArtifact(message.id, 'art-1');
    const again = await repo.adoptAdminArtifact(message.id, 'art-1');
    expect(again?.artifact?.status).toBe('adopted');
    expect((await repo.listCards()).length).toBeGreaterThan(0);
  });
});
