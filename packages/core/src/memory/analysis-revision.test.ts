import { describe, expect, it } from 'vitest';
import { createBlankCard } from '../model/card.js';
import { messageId, PLAYER } from '../model/ids.js';
import type { Message } from '../model/message.js';
import { createPersona } from '../model/persona.js';
import { createBackgroundRunner } from '../platform/background-runner.js';
import type { EntityStore } from '../platform/entity-store.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import { leaseBackgroundTask, settleBackgroundTask } from '../platform/task-lease.js';
import { createWorldFromCard } from '../session/setup.js';
import { COLLECTIONS, Repository } from '../storage/repository.js';
import { revertAffectForTurn } from './affect.js';
import {
  analysisReceiptKey,
  captureTurnAnalysis,
  invalidateTurnAnalysis,
  readAnalysisGeneration,
  StaleTurnAnalysisError,
} from './analysis-revision.js';
import { applyTurnAnalysis } from './apply-analysis.js';

const TURN = 'fixture-turn';
async function seed(store: EntityStore = createMemoryEntityStore()) {
  const repository = new Repository(store);
  const card = createBlankCard({ name: '阿青' }),
    persona = createPersona({ name: '旅人' });
  const world = createWorldFromCard(card, persona);
  await repository.savePersona(persona);
  await repository.saveCard(card);
  await repository.saveSnapshot({
    room: world.room,
    conversations: [world.conversation],
    scenes: [world.scene],
    instances: [world.instance],
  });
  const message: Message = {
    id: messageId('fixture-message'),
    roomId: world.room.id,
    conversationId: world.conversation.id,
    sceneId: world.scene.id,
    turnId: TURN,
    localSeq: 0,
    deviceId: '',
    role: 'player',
    speakerInstanceId: null,
    speakerName: persona.name,
    audience: [world.instance.id],
    content: '原始台词',
    createdAt: '2026-10-04T00:00:00.000Z',
    updatedAt: '2026-10-04T00:00:00.000Z',
    deletedAt: null,
  };
  await repository.appendMessages(world.room.id, [message]);
  const scope = { roomId: world.room.id, conversationId: world.conversation.id, sceneId: world.scene.id, turnId: TURN };
  const input = { repository, ...scope, worldTime: '', participants: [world.instance], raw: output() };
  return { store, repository, world, message, scope, input };
}
function output(delta = 0.1, affect = false) {
  return JSON.stringify({
    summary: '一段经过',
    importance: 0.6,
    observations: [{ speaker: '阿青', perception: '他的印象' }],
    updates: [
      {
        observer: '阿青',
        deltaValence: affect ? 0.1 : 0,
        deltaArousal: 0,
        reason: 'fixture',
        relationship: [{ field: 'trust', delta }],
      },
    ],
  });
}
async function trust(f: Awaited<ReturnType<typeof seed>>) {
  return (
    (await f.repository.listInstances(f.scope.roomId))[0]?.relationships.find((edge) => edge.target === PLAYER)
      ?.trust ?? 0
  );
}
async function source(f: Awaited<ReturnType<typeof seed>>) {
  const context = await captureTurnAnalysis(f.repository, f.scope);
  if (!context) throw new Error('fixture source missing');
  return context.source;
}

describe('顺序116：A06关系业务幂等', () => {
  it('仅关系变化、情绪history为空时重复应用也只累加一次', async () => {
    const f = await seed();
    const before = await trust(f);
    await applyTurnAnalysis(f.input);
    await applyTurnAnalysis(f.input);
    expect(await trust(f)).toBeCloseTo(before + 0.1);
    expect((await f.repository.listInstances(f.scope.roomId))[0]?.affect.history).toEqual([]);
  });
  it('并发重复分析与新Repository实例共享持久完成凭证', async () => {
    const f = await seed();
    const captured = await source(f);
    const before = await trust(f);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        applyTurnAnalysis({ ...f.input, repository: new Repository(f.store), source: captured }),
      ),
    );
    expect(results.reduce((n, r) => n + r.updates, 0)).toBe(1);
    expect(await trust(f)).toBeCloseTo(before + 0.1);
    expect(await f.repository.listMemories(f.scope.roomId)).toHaveLength(2);
  });
  it('零效果也记录完成，不因下次模型输出不同而补叠加状态', async () => {
    const f = await seed();
    const before = await trust(f);
    await applyTurnAnalysis({ ...f.input, raw: JSON.stringify({ summary: '经过', observations: [], updates: [] }) });
    expect((await applyTurnAnalysis(f.input)).updates).toBe(0);
    expect(await trust(f)).toBe(before);
  });
  it('旧关系历史可见但情绪历史为空时，也保留已有关系', async () => {
    const f = await seed();
    await applyTurnAnalysis(f.input);
    const before = await trust(f);
    await f.repository.deleteMeta(analysisReceiptKey(f.scope.roomId, TURN));
    await f.repository.deleteMemoriesByTurn(f.scope.roomId, TURN);
    expect((await applyTurnAnalysis(f.input)).updates).toBe(0);
    expect(await trust(f)).toBe(before);
  });
  it('旧记忆无完成凭证且历史已清理时，不推断从未应用或自动重加', async () => {
    const f = await seed();
    await applyTurnAnalysis(f.input);
    const instances = await f.repository.listInstances(f.scope.roomId);
    const current = instances[0];
    if (!current) throw new Error('fixture');
    await f.repository.saveInstance({
      ...current,
      affect: { ...current.affect, history: [] },
      relationships: current.relationships.map((edge) => ({ ...edge, history: [] })),
    });
    await f.repository.deleteMeta(analysisReceiptKey(f.scope.roomId, TURN));
    const before = await trust(f);
    const result = await applyTurnAnalysis(f.input);
    expect(result.legacyPreserved).toBe(true);
    expect(result.updates).toBe(0);
    expect(await trust(f)).toBe(before);
  });
  it('旧拆分memory/affect任务与新合并任务共用效果凭证', async () => {
    const f = await seed();
    const captured = await source(f);
    const before = await trust(f);
    await applyTurnAnalysis({ ...f.input, source: captured, mode: 'memory' });
    expect((await applyTurnAnalysis({ ...f.input, source: captured, mode: 'affect' })).updates).toBe(1);
    expect((await applyTurnAnalysis({ ...f.input, source: captured })).updates).toBe(0);
    expect(await trust(f)).toBeCloseTo(before + 0.1);
  });
  it('显式撤销与世代变化同事务后，允许新一代重新应用，拒绝旧结果', async () => {
    const f = await seed();
    const old = await source(f);
    const before = await trust(f);
    await applyTurnAnalysis({ ...f.input, source: old });
    await f.repository.atomic(async (repo) => {
      await repo.deleteMemoriesByTurn(f.scope.roomId, TURN);
      for (const instance of await repo.listInstances(f.scope.roomId))
        await repo.saveInstance(revertAffectForTurn(instance, TURN));
      await invalidateTurnAnalysis(repo, f.scope.roomId, TURN);
    });
    expect(await trust(f)).toBeCloseTo(before);
    await expect(applyTurnAnalysis({ ...f.input, source: old })).rejects.toBeInstanceOf(StaleTurnAnalysisError);
    await applyTurnAnalysis({ ...f.input, source: await source(f) });
    expect(await trust(f)).toBeCloseTo(before + 0.1);
  });
});

describe('顺序116：B16写事务内重验来源', () => {
  it.each(['content', 'speaker', 'audience', 'delete', 'append', 'scene', 'archive', 'generation'] as const)(
    '%s在模型等待期变化，旧结果写入0项',
    async (kind) => {
      const f = await seed(),
        captured = await source(f),
        before = await trust(f);
      if (kind === 'content') await f.repository.updateMessage(f.message.id, { content: '新台词' });
      if (kind === 'speaker') await f.repository.updateMessage(f.message.id, { speakerName: '改归属' });
      if (kind === 'audience') await f.repository.updateMessage(f.message.id, { audience: [] });
      if (kind === 'delete') await f.repository.deleteMessage(f.message.id);
      if (kind === 'append')
        await f.repository.appendMessages(f.scope.roomId, [
          { ...f.message, id: messageId('late-message'), content: '后来追加' },
        ]);
      if (kind === 'scene') await f.repository.saveScene({ ...f.world.scene, worldTime: '后来' });
      if (kind === 'archive') await f.repository.archiveConversation(f.scope.conversationId);
      if (kind === 'generation')
        await f.repository.atomic((repo) => invalidateTurnAnalysis(repo, f.scope.roomId, TURN));
      await expect(applyTurnAnalysis({ ...f.input, source: captured })).rejects.toBeInstanceOf(StaleTurnAnalysisError);
      expect(await f.repository.listMemories(f.scope.roomId)).toEqual([]);
      expect(await trust(f)).toBeCloseTo(before);
      expect(await f.repository.getMeta(analysisReceiptKey(f.scope.roomId, TURN))).toBeNull();
    },
  );
  it('即使故意复用updatedAt，正文不同仍被精确快照校验拒绝', async () => {
    const f = await seed(),
      captured = await source(f);
    const rows = await f.repository.listMessages(f.scope.roomId);
    const current = rows[0];
    if (!current) throw new Error('fixture');
    await f.store.put(COLLECTIONS.messages, { ...current, content: '同时间不同内容' });
    await expect(applyTurnAnalysis({ ...f.input, source: captured })).rejects.toBeInstanceOf(StaleTurnAnalysisError);
  });
  it('提交前再读角色现状，不能把请求前快照盖回手动关系调整', async () => {
    const f = await seed(),
      captured = await source(f);
    const instance = (await f.repository.listInstances(f.scope.roomId))[0];
    if (!instance) throw new Error('fixture');
    await f.repository.saveInstance({
      ...instance,
      relationships: instance.relationships.map((edge) => ({ ...edge, trust: 0.5 })),
    });
    await applyTurnAnalysis({ ...f.input, source: captured });
    expect(await trust(f)).toBeCloseTo(0.6);
  });
  it('缺少事务后端拒绝写入，不退回分散save', async () => {
    const f = await seed();
    const noTx: EntityStore = { ...f.store, transaction: undefined };
    await expect(applyTurnAnalysis({ ...f.input, repository: new Repository(noTx) })).rejects.toThrow('需要存储事务');
    expect(await f.repository.listMemories(f.scope.roomId)).toEqual([]);
  });
  it.each(['instances', 'receipt'] as const)(
    '%s阶段写失败，记忆/状态/序号/凭证一起回滚，重试只应用一次',
    async (stage) => {
      const f = await seed(),
        captured = await source(f),
        before = await trust(f);
      const transact = f.store.transaction;
      if (!transact) throw new Error('fixture');
      const failing: EntityStore = {
        ...f.store,
        transaction: (run) =>
          transact((scope) =>
            run({
              ...scope,
              put: async (collection, value) => {
                if (
                  (stage === 'instances' && collection === COLLECTIONS.instances) ||
                  (stage === 'receipt' && value.id.startsWith('analysis.receipt.'))
                )
                  throw new Error('fixture-write-failure');
                return scope.put(collection, value);
              },
            }),
          ),
      };
      await expect(
        applyTurnAnalysis({ ...f.input, source: captured, repository: new Repository(failing) }),
      ).rejects.toThrow('fixture-write-failure');
      expect(await f.repository.listMemories(f.scope.roomId)).toEqual([]);
      expect(await trust(f)).toBe(before);
      expect(await f.repository.getMeta(`memorySeq:${f.scope.roomId}`)).toBeNull();
      expect(await f.repository.getMeta(analysisReceiptKey(f.scope.roomId, TURN))).toBeNull();
      await applyTurnAnalysis({ ...f.input, source: captured });
      expect(await trust(f)).toBeCloseTo(before + 0.1);
    },
  );
  it('任务被清除/重排后，旧结果与旧完成/失败都不能污染新执行', async () => {
    const f = await seed(),
      queue = createBackgroundRunner(f.store);
    const first = await queue.enqueue({
      kind: 'turn.analyze',
      roomId: f.scope.roomId,
      turnId: TURN,
      payload: f.scope,
      idempotencyKey: TURN,
    });
    const taken = (await queue.take())[0];
    if (!taken) throw new Error('fixture');
    const leased = await leaseBackgroundTask(f.store, taken);
    if (!leased) throw new Error('fixture');
    const lease = { id: first.id, token: leased.runToken };
    const context = await captureTurnAnalysis(f.repository, f.scope, lease);
    if (!context) throw new Error('fixture');
    await queue.recoverInterrupted();
    const nextTaken = (await queue.take())[0];
    if (!nextTaken) throw new Error('fixture');
    const next = await leaseBackgroundTask(f.store, nextTaken);
    if (!next) throw new Error('fixture');
    await expect(applyTurnAnalysis({ ...f.input, source: context.source })).rejects.toBeInstanceOf(
      StaleTurnAnalysisError,
    );
    expect(await settleBackgroundTask(f.store, lease)).toBe(false);
    expect(await settleBackgroundTask(f.store, lease, 'old failure')).toBe(false);
    expect((await queue.list())[0]).toMatchObject({ status: 'running', runToken: next.runToken });
    await queue.clearTurn(TURN);
    expect(await captureTurnAnalysis(f.repository, f.scope, { id: next.id, token: next.runToken })).toBeNull();
  });
  it('世代作废写失败随同事务回滚，不能留下只失效凭证的半截状态', async () => {
    const f = await seed();
    const before = await readAnalysisGeneration(f.repository, f.scope.roomId, TURN);
    await expect(
      f.repository.atomic(async (repo) => {
        await invalidateTurnAnalysis(repo, f.scope.roomId, TURN);
        throw new Error('fixture');
      }),
    ).rejects.toThrow('fixture');
    expect(await readAnalysisGeneration(f.repository, f.scope.roomId, TURN)).toBe(before);
  });
});
