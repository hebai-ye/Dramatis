import {
  createBlankCard,
  createCharacterMessage,
  createMemoryEntityStore,
  createPersona,
  createWorldFromCard,
  invalidateTurnAnalysis,
  PLAYER,
  Repository,
  StaleTurnAnalysisError,
} from '@dramatis/core';
import { describe, expect, it } from 'vitest';
import { applyBridgeAnalysis, prepareBridgeAnalysis } from './bridge-store';

async function fixture() {
  const repository = new Repository(createMemoryEntityStore());
  const world = createWorldFromCard(createBlankCard({ name: '阿青' }), createPersona({ name: '旅人' }));
  await repository.saveSnapshot({
    room: world.room,
    conversations: [world.conversation],
    scenes: [world.scene],
    instances: [world.instance],
  });
  const message = createCharacterMessage({
    roomId: world.room.id,
    conversationId: world.conversation.id,
    sceneId: world.scene.id,
    turnId: 'bridge-review-turn',
    speakerInstanceId: world.instance.id,
    speakerName: '阿青',
    audience: [world.instance.id],
    content: '「原始桥接回复。」',
  });
  await repository.appendMessages(world.room.id, [message]);
  const scope = {
    roomId: world.room.id,
    conversationId: world.conversation.id,
    sceneId: world.scene.id,
    turnId: message.turnId,
  };
  return { repository, world, message, scope, accountKey: 'fixture-account-a' };
}

const raw = JSON.stringify({
  summary: '这一轮发生了交谈',
  importance: 0.6,
  observations: [{ speaker: '阿青', perception: '旅人值得信任' }],
  updates: [{ observer: '阿青', deltaValence: 0.1, relationship: [{ field: 'trust', delta: 0.1 }] }],
});

describe('B16 pasted analysis source binding', () => {
  it('captures scope and a revision before preparing the prompt, persists only the fingerprint', async () => {
    const f = await fixture();
    const bridge = await prepareBridgeAnalysis(f.repository, f.scope, f.accountKey);
    expect(bridge).toMatchObject({ stage: 'analysis', turnId: f.scope.turnId });
    expect(bridge.prompt).toContain('原始桥接回复');
    expect(bridge.analysisBinding).toMatchObject({ scope: f.scope, accountKey: f.accountKey, generation: 'initial' });
    expect(bridge.analysisBinding.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(bridge.analysisBinding).not.toHaveProperty('snapshot');
  });

  it('accepts an unchanged binding after JSON/session restoration and applies effects only once', async () => {
    const f = await fixture();
    const prepared = await prepareBridgeAnalysis(f.repository, f.scope, f.accountKey);
    const bridge = JSON.parse(JSON.stringify(prepared));
    const input = { repository: f.repository, bridge, current: f.scope, accountKey: f.accountKey, raw };
    expect((await applyBridgeAnalysis(input)).updates).toBe(1);
    expect((await applyBridgeAnalysis(input)).updates).toBe(0);
    const instance = (await f.repository.listInstances(f.scope.roomId))[0];
    expect(instance?.relationships.find((edge) => edge.target === PLAYER)?.trust).toBeCloseTo(0.1);
  });

  it.each(['roomId', 'conversationId', 'sceneId'] as const)(
    'rejects a paste after switching %s without writes',
    async (field) => {
      const f = await fixture();
      const bridge = await prepareBridgeAnalysis(f.repository, f.scope, f.accountKey);
      await expect(
        applyBridgeAnalysis({
          repository: f.repository,
          bridge,
          current: { ...f.scope, [field]: 'different-scope' },
          accountKey: f.accountKey,
          raw,
        }),
      ).rejects.toThrow(StaleTurnAnalysisError);
      expect(await f.repository.listMemories(f.scope.roomId)).toEqual([]);
      expect((await f.repository.listInstances(f.scope.roomId))[0]?.affect.history).toEqual([]);
    },
  );

  it('rejects a copied binding in another account even with identical world identifiers', async () => {
    const f = await fixture();
    const bridge = await prepareBridgeAnalysis(f.repository, f.scope, f.accountKey);
    await expect(
      applyBridgeAnalysis({ repository: f.repository, bridge, current: f.scope, accountKey: 'account-b', raw }),
    ).rejects.toThrow('账户');
    expect(await f.repository.listMemories(f.scope.roomId)).toEqual([]);
  });

  it('rejects edited messages using the saved fingerprint instead of recapturing it as current', async () => {
    const f = await fixture();
    const bridge = await prepareBridgeAnalysis(f.repository, f.scope, f.accountKey);
    await f.repository.appendMessages(f.scope.roomId, [{ ...f.message, content: '「后来修改的回复。」' }]);
    await expect(
      applyBridgeAnalysis({ repository: f.repository, bridge, current: f.scope, accountKey: f.accountKey, raw }),
    ).rejects.toThrow(StaleTurnAnalysisError);
    expect(await f.repository.listMemories(f.scope.roomId)).toEqual([]);
  });

  it('rejects a generation invalidated by rollback even when the text is unchanged', async () => {
    const f = await fixture();
    const bridge = await prepareBridgeAnalysis(f.repository, f.scope, f.accountKey);
    await f.repository.atomic((repository) => invalidateTurnAnalysis(repository, f.scope.roomId, f.scope.turnId));
    await expect(
      applyBridgeAnalysis({ repository: f.repository, bridge, current: f.scope, accountKey: f.accountKey, raw }),
    ).rejects.toThrow(StaleTurnAnalysisError);
    expect(await f.repository.listMemories(f.scope.roomId)).toEqual([]);
  });

  it('fails closed for legacy or corrupt progress instead of binding it to the current world', async () => {
    const f = await fixture();
    const valid = await prepareBridgeAnalysis(f.repository, f.scope, f.accountKey);
    for (const bridge of [
      { stage: 'analysis', turnId: f.scope.turnId, prompt: '旧提示词' },
      { ...valid, analysisBinding: { ...valid.analysisBinding, revision: 'bad-revision' } },
      { ...valid, turnId: 'a-different-turn' },
    ]) {
      await expect(
        applyBridgeAnalysis({ repository: f.repository, bridge, current: f.scope, accountKey: f.accountKey, raw }),
      ).rejects.toThrow(StaleTurnAnalysisError);
    }
    expect(await f.repository.listMemories(f.scope.roomId)).toEqual([]);
  });

  it('checks the current UI owner again after the asynchronous capture', async () => {
    const f = await fixture();
    const bridge = await prepareBridgeAnalysis(f.repository, f.scope, f.accountKey);
    let checks = 0;
    await expect(
      applyBridgeAnalysis({
        repository: f.repository,
        bridge,
        current: f.scope,
        accountKey: f.accountKey,
        raw,
        isCurrent: () => ++checks === 1,
      }),
    ).rejects.toThrow(StaleTurnAnalysisError);
    expect(await f.repository.listMemories(f.scope.roomId)).toEqual([]);
  });
});
