import {
  type AdminArtifact,
  COLLECTIONS,
  createBlankCard,
  createMemoryEntityStore,
  createPlayerMessage,
  createTurnId,
  type Message,
  Repository,
  roomId,
} from '@dramatis/core';
import { expect, it, vi } from 'vitest';
import { inspectAdminArtifactAction, performAdminArtifactAction } from './admin-artifact-actions';

async function fixture() {
  const store = createMemoryEntityStore(),
    repository = new Repository(store),
    card = createBlankCard({ name: '秦娘' }),
    room = roomId('synthetic');
  const artifact: AdminArtifact = {
    id: 'draft',
    kind: 'character-card',
    title: card.name,
    summary: '新建',
    status: 'pending',
    payload: card,
    targetId: null,
    baseUpdatedAt: null,
    createdAt: card.createdAt,
  };
  const base = createPlayerMessage({
    roomId: room,
    conversationId: null,
    sceneId: null,
    turnId: createTurnId(),
    speakerName: '测试',
    content: '草稿',
    audience: [],
  });
  const message: Message = { ...base, role: 'admin', artifacts: [artifact] };
  await repository.appendMessages(room, [message]);
  return { store, repository, card, message };
}
it('实体已写而消息状态失败，核对及再次点击都不能重放采纳', async () => {
  const f = await fixture(),
    put = f.store.put.bind(f.store);
  let saves = 0;
  vi.spyOn(f.store, 'put').mockImplementation(async (collection, value) => {
    if (collection === COLLECTIONS.cards) saves++;
    if (collection === COLLECTIONS.messages && (value as Message).artifacts?.[0]?.status === 'adopted')
      throw new Error('消息保存失败');
    return put(collection, value);
  });
  expect((await performAdminArtifactAction(f.repository, f.message.id, 'draft', 'adopt')).status).toBe('uncertain');
  expect(await f.repository.getCard(f.card.id)).not.toBeNull();
  await inspectAdminArtifactAction(f.repository, f.message.id, 'draft', 'adopt');
  await performAdminArtifactAction(f.repository, f.message.id, 'draft', 'adopt');
  expect(saves).toBe(1);
});
it('有版本冲突的草稿仍可成功丢弃', async () => {
  const f = await fixture();
  await f.store.put(COLLECTIONS.messages, {
    ...f.message,
    artifacts: f.message.artifacts?.map((a) => ({ ...a, conflict: '版本冲突' })),
  });
  const result = await performAdminArtifactAction(f.repository, f.message.id, 'draft', 'discard');
  expect(result.status).toBe('confirmed');
  if ('artifact' in result) expect(result.artifact.status).toBe('discarded');
});
it('冲突正常返回仍是待采纳，撤回沿现有删除语义', async () => {
  const f = await fixture();
  const first = await performAdminArtifactAction(f.repository, f.message.id, 'draft', 'adopt');
  expect(first.status).toBe('confirmed');
  await f.repository.saveCard({ ...f.card, description: '后来修改' });
  const revoked = await performAdminArtifactAction(f.repository, f.message.id, 'draft', 'revoke');
  expect(revoked.status).toBe('confirmed');
  expect(await f.repository.getCard(f.card.id)).toBeNull();
  const pending = await f.repository.readAdminMessage(f.message.id);
  expect(pending?.artifacts?.[0]?.status).toBe('pending');
});
it('未应用的场景可丢弃但不可假采纳', async () => {
  const f = await fixture(),
    artifact = f.message.artifacts?.[0];
  if (!artifact) throw new Error('missing draft');
  await f.repository.updateMessage(f.message.id, {
    artifacts: [{ ...artifact, kind: 'scene', payload: { location: '露台' } }],
  });
  expect((await performAdminArtifactAction(f.repository, f.message.id, 'draft', 'adopt')).status).toBe('blocked');
  expect((await performAdminArtifactAction(f.repository, f.message.id, 'draft', 'discard')).status).toBe('confirmed');
});
