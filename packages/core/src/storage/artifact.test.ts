import { describe, expect, it } from 'vitest';
import { createBlankCard } from '../model/card.js';
import { messageId, newId, nowIso, roomId } from '../model/ids.js';
import type { AdminArtifact, Message } from '../model/message.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import { Repository } from './repository.js';

function draftCardArtifact(): AdminArtifact {
  return {
    id: newId(),
    kind: 'character-card',
    title: '酒馆老板',
    summary: '新建角色卡「酒馆老板」',
    status: 'pending',
    payload: createBlankCard({ name: '酒馆老板', description: '旧城东侧酒馆的老板' }),
    targetId: null,
    createdAt: nowIso(),
  };
}

async function adminMessage(artifacts: AdminArtifact[]): Promise<{ repository: Repository; message: Message }> {
  const repository = new Repository(createMemoryEntityStore());
  const message: Message = {
    id: messageId(newId()),
    roomId: roomId(newId()),
    conversationId: null,
    sceneId: null,
    turnId: newId(),
    localSeq: 1,
    deviceId: '',
    role: 'admin',
    speakerInstanceId: null,
    speakerName: '世界管理员',
    audience: [],
    content: '这是草稿。',
    // 空数组与「没有这个字段」对界面是一回事，但对仓储层不是：
    // 只有真的带过草稿的消息才谈得上采纳
    ...(artifacts.length > 0 ? { artifacts } : {}),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    deletedAt: null,
  };
  await repository.appendMessages(message.roomId, [message]);
  return { repository, message };
}

describe('管理员草稿的去留', () => {
  it('草稿不会自动进素材库，采纳之后才落库', async () => {
    const artifact = draftCardArtifact();
    const { repository, message } = await adminMessage([artifact]);
    const card = artifact.payload as { id: string };

    expect(await repository.listCards()).toHaveLength(0);

    const result = await repository.adoptAdminArtifact(message.id, artifact.id);
    expect(result?.artifact?.status).toBe('adopted');
    expect(result?.artifact?.targetId).toBe(card.id);
    expect(await repository.getCard(card.id as never)).not.toBeNull();
    expect(await repository.listCards()).toHaveLength(1);
  });

  it('重复采纳不会产生第二份素材', async () => {
    const artifact = draftCardArtifact();
    const { repository, message } = await adminMessage([artifact]);

    await repository.adoptAdminArtifact(message.id, artifact.id);
    const again = await repository.adoptAdminArtifact(message.id, artifact.id);

    expect(again?.artifact?.status).toBe('adopted');
    expect(await repository.listCards()).toHaveLength(1);
  });

  it('丢弃只改状态，素材库里不会出现它', async () => {
    const artifact = draftCardArtifact();
    const { repository, message } = await adminMessage([artifact]);

    const updated = await repository.discardAdminArtifact(message.id, artifact.id);

    expect(updated?.artifacts?.[0]?.status).toBe('discarded');
    expect(await repository.listCards()).toHaveLength(0);

    // 丢弃之后不能再被采纳
    const adopted = await repository.adoptAdminArtifact(message.id, artifact.id);
    expect(adopted?.artifact?.status).toBe('discarded');
    expect(await repository.listCards()).toHaveLength(0);
  });

  it('没有草稿的消息不会出错', async () => {
    const { repository, message } = await adminMessage([]);
    expect(await repository.adoptAdminArtifact(message.id, 'nope')).toBeNull();
  });
});
