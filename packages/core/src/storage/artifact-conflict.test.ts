import { describe, expect, it } from 'vitest';
import {
  type Card,
  createBlankCard,
  createBlankWorldBook,
  createWorldBookEntry,
  type WorldBook,
} from '../model/card.js';
import { messageId, newId, nowIso, roomId } from '../model/ids.js';
import type { AdminArtifact, Message } from '../model/message.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import { Repository } from './repository.js';

/*
 * 审计 B6 的第三问：**过期草稿会覆盖用户后来的修改**。
 *
 * 起草与采纳之间隔着几分钟到几十分钟，用户完全可能自己动手改了那张卡。
 * 以前的采纳是无条件覆盖（整份 payload 盖上去），用户不会看到任何提示。
 * 现在的约定：草稿记着「它基于哪一版」，采纳时发现目标变了就**不写库**，
 * 把理由留在草稿上（`conflict`），让界面去说。
 */
async function adminMessage(repository: Repository, artifacts: AdminArtifact[]): Promise<Message> {
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
    artifacts,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    deletedAt: null,
  };
  await repository.appendMessages(message.roomId, [message]);
  return message;
}

function cardArtifact(payload: Card, baseUpdatedAt: string | null): AdminArtifact {
  return {
    id: newId(),
    kind: 'character-card',
    title: payload.name,
    summary: '修改角色卡',
    status: 'pending',
    payload,
    baseUpdatedAt,
    targetId: null,
    createdAt: nowIso(),
  };
}

function bookArtifact(payload: WorldBook, baseUpdatedAt: string | null): AdminArtifact {
  return {
    id: newId(),
    kind: 'world-book',
    title: payload.name,
    summary: '修改世界书',
    status: 'pending',
    payload,
    baseUpdatedAt,
    targetId: null,
    createdAt: nowIso(),
  };
}

describe('过期草稿（审计 B6）', () => {
  it('起草之后卡又被改过：采纳被拒，用户后来的修改原样留着', async () => {
    const repository = new Repository(createMemoryEntityStore());
    const base = createBlankCard({ name: '酒馆老板', description: '旧城东侧酒馆的老板' });
    await repository.saveCard(base);
    const stored = await repository.getCard(base.id);
    const baseUpdatedAt = stored?.updatedAt ?? null;
    expect(baseUpdatedAt).not.toBeNull();

    // 管理员按这一版起草：加一句开场白、改性格
    const artifact = cardArtifact(
      { ...(stored as Card), personality: '爽朗', firstMessage: '欢迎光临。' },
      baseUpdatedAt,
    );
    const message = await adminMessage(repository, [artifact]);

    // 用户在采纳之前自己改了一次（改了自称）
    await repository.saveCard({ ...(stored as Card), nickname: '老板' });

    const result = await repository.adoptAdminArtifact(message.id, artifact.id);

    expect(result?.artifact?.status).toBe('pending');
    expect(result?.artifact?.conflict).toContain('又被改过');
    expect(result?.artifact?.targetId).toBeNull();

    // 库里还是用户改后的样子：草稿里的开场白与性格没有盖上去
    const current = await repository.getCard(base.id);
    expect(current?.nickname).toBe('老板');
    expect(current?.firstMessage).toBe('');
    expect(current?.personality).toBe('');
  });

  it('冲突记在消息上：刷新后界面还能看到那句话', async () => {
    const repository = new Repository(createMemoryEntityStore());
    const base = createBlankCard({ name: '酒馆老板', description: 'x' });
    await repository.saveCard(base);
    const stored = (await repository.getCard(base.id)) as Card;

    const artifact = cardArtifact({ ...stored, firstMessage: '欢迎光临。' }, stored.updatedAt);
    const message = await adminMessage(repository, [artifact]);
    await repository.saveCard({ ...stored, nickname: '老板' });

    await repository.adoptAdminArtifact(message.id, artifact.id);

    const [reloaded] = await repository.listMessages(message.roomId, {});
    expect(reloaded?.artifacts?.[0]?.conflict).toContain('又被改过');
    expect(reloaded?.artifacts?.[0]?.status).toBe('pending');
  });

  it('没被改过就照常采纳，且不留下冲突标记', async () => {
    const repository = new Repository(createMemoryEntityStore());
    const base = createBlankCard({ name: '酒馆老板', description: 'x' });
    await repository.saveCard(base);
    const stored = (await repository.getCard(base.id)) as Card;

    const artifact = cardArtifact({ ...stored, firstMessage: '欢迎光临。' }, stored.updatedAt);
    const message = await adminMessage(repository, [artifact]);

    const result = await repository.adoptAdminArtifact(message.id, artifact.id);

    expect(result?.artifact?.status).toBe('adopted');
    expect(result?.artifact?.conflict).toBeUndefined();
    expect((await repository.getCard(base.id))?.firstMessage).toBe('欢迎光临。');
  });

  it('新建类草稿没有底版本，永远算「不冲突」', async () => {
    const repository = new Repository(createMemoryEntityStore());
    const fresh = createBlankCard({ name: '新角色', description: 'x' });
    const artifact = cardArtifact(fresh, null);
    const message = await adminMessage(repository, [artifact]);

    const result = await repository.adoptAdminArtifact(message.id, artifact.id);

    expect(result?.artifact?.status).toBe('adopted');
    expect(await repository.listCards()).toHaveLength(1);
  });

  it('草稿要改的东西已经被删掉了：也拒绝，并说清是「删掉了」而不是「改过了」', async () => {
    const repository = new Repository(createMemoryEntityStore());
    const base = createBlankCard({ name: '酒馆老板', description: 'x' });
    await repository.saveCard(base);
    const stored = (await repository.getCard(base.id)) as Card;

    const artifact = cardArtifact({ ...stored, firstMessage: '欢迎光临。' }, stored.updatedAt);
    const message = await adminMessage(repository, [artifact]);
    await repository.deleteCard(base.id);

    const result = await repository.adoptAdminArtifact(message.id, artifact.id);

    expect(result?.artifact?.status).toBe('pending');
    expect(result?.artifact?.conflict).toContain('已经被删掉');
    expect(await repository.getCard(base.id)).toBeNull();
  });

  it('世界书走同一条路：起草后又被改过就不许采纳', async () => {
    const repository = new Repository(createMemoryEntityStore());
    const book = createBlankWorldBook('旧城设定');
    book.entries = [createWorldBookEntry({ title: '旧城', keys: ['旧城'], content: '城墙是青的。' })];
    await repository.saveWorldBook(book);
    const stored = (await repository.getWorldBook(book.id)) as WorldBook;

    const first = stored.entries[0];
    if (first === undefined) throw new Error('测试数据不对：书里没有条目');
    const draft: WorldBook = {
      ...stored,
      entries: [{ ...first, content: '城墙是青的，雨里有苔。' }],
    };
    const artifact = bookArtifact(draft, stored.updatedAt);
    const message = await adminMessage(repository, [artifact]);

    await repository.saveWorldBook({ ...stored, name: '旧城（改过名）' });

    const result = await repository.adoptAdminArtifact(message.id, artifact.id);

    expect(result?.artifact?.status).toBe('pending');
    expect(result?.artifact?.conflict).toContain('又被改过');
    const current = await repository.getWorldBook(book.id);
    expect(current?.name).toBe('旧城（改过名）');
    expect(current?.entries[0]?.content).toBe('城墙是青的。');
  });
});
