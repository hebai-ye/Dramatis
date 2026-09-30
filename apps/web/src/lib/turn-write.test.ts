import {
  COLLECTIONS,
  createMemoryEntityStore,
  type EntityStore,
  type Message,
  messageId,
  type RoomId,
  roomId,
  withStoreTransaction,
} from '@dramatis/core';
import { describe, expect, it } from 'vitest';
import { revertTurnWrites, rewriteTurnWrites } from './turn-write';

/*
 * 顺序 77：重抽 / 改归属那一批写入必须「要么全落、要么一条都不落」。
 *
 * 为什么只测内存后端：IndexedDB 的事务路径在 Node 里跑不到（`apps/web` 没有
 * fake-indexeddb，真机验证归 Codex）。能在这里证明的是**语义**——同一批写入的
 * 边界、失败回滚、以及「消息已经不在了就别再动这一轮的账」。`db.ts` 那侧靠
 * `store.transaction` 的一次 readwrite 事务实现同样的语义，只能靠 typecheck +
 * 真机验证保证。
 */

const ROOM: RoomId = roomId('room-1');
const TARGET = messageId('m-1');

function seedMessage(id: ReturnType<typeof messageId>, turnId: string, content: string): Message {
  return {
    id,
    roomId: ROOM,
    conversationId: 'conversation-1',
    sceneId: null,
    turnId,
    localSeq: 0,
    deviceId: 'device-1',
    role: 'character',
    speakerInstanceId: null,
    speakerName: '秦娘',
    audience: [],
    content,
    createdAt: '2026-09-30T10:00:00.000Z',
    updatedAt: '2026-09-30T10:00:00.000Z',
    deletedAt: null,
  } as unknown as Message;
}

/** 造一条记忆：`deleteMemoriesByTurn` 按 `sourceTurnIds` 判断归属。 */
function seedMemory(id: string, sourceTurnIds: readonly string[]) {
  return {
    id,
    roomId: ROOM,
    sourceTurnIds: [...sourceTurnIds],
    summary: '一条印象',
    createdAt: '2026-09-30T10:00:00.000Z',
    updatedAt: '2026-09-30T10:00:00.000Z',
    deletedAt: null,
  };
}

function seedTask(turnId: string) {
  return {
    id: `task-${turnId}`,
    kind: 'turn.analyze',
    turnId,
    roomId: ROOM,
    status: 'pending',
    attempts: 0,
    createdAt: '2026-09-30T10:00:00.000Z',
    updatedAt: '2026-09-30T10:00:00.000Z',
  };
}

async function seedTurn(store: EntityStore): Promise<void> {
  await store.put(COLLECTIONS.messages, seedMessage(TARGET, 'T1', '旧台词'));
  await store.put(COLLECTIONS.backgroundTasks, seedTask('T1'));
  await store.put(COLLECTIONS.memories, seedMemory('mem-1', ['T1']));
  await store.put(COLLECTIONS.memories, seedMemory('mem-2', ['T0']));
}

describe('顺序 77：存储事务原语', () => {
  it('内存后端上一批写入要么全部落地、要么整批回滚', async () => {
    const store = createMemoryEntityStore();
    await store.put('demo', { id: 'a', value: 1 });

    await withStoreTransaction(store, async (scope) => {
      await scope.put('demo', { id: 'b', value: 2 });
      await scope.remove('demo', 'a');
    });

    expect(await store.get('demo', 'a')).toBeNull();
    expect(await store.get('demo', 'b')).toMatchObject({ value: 2 });

    await expect(
      withStoreTransaction(store, async (scope) => {
        await scope.put('demo', { id: 'c', value: 3 });
        await scope.remove('demo', 'b');
        throw new Error('写盘失败');
      }),
    ).rejects.toThrow('写盘失败');

    // 新写的没留下、删掉的还在
    expect(await store.get('demo', 'c')).toBeNull();
    expect(await store.get('demo', 'b')).toMatchObject({ value: 2 });
  });

  it('后端没有 transaction 时退回「直接跑」：跑得通，但没有原子性', async () => {
    const store = createMemoryEntityStore();
    const plain: EntityStore = { ...store, transaction: undefined };

    await expect(
      withStoreTransaction(plain, async (scope) => {
        await scope.put('demo', { id: 'a', value: 1 });
        throw new Error('写盘失败');
      }),
    ).rejects.toThrow('写盘失败');

    // 保证变弱（与 updateEntity 同一套话术）：这一步已经落下去了
    expect(await store.get('demo', 'a')).toMatchObject({ value: 1 });
  });
});

describe('顺序 77：重抽 / 改归属的一批写入', () => {
  it('改写消息 + 清这一轮的任务 + 撤这一轮的记忆，一次落地', async () => {
    const store = createMemoryEntityStore();
    await seedTurn(store);

    const result = await rewriteTurnWrites(store, {
      messageId: TARGET,
      patch: { content: '新台词' },
      roomId: ROOM,
      turnId: 'T1',
    });

    expect(result.message?.content).toBe('新台词');
    expect(result.clearedTasks).toBe(1);
    expect(result.reverted.removedMemories).toBe(1);
    expect((await store.get<Message>(COLLECTIONS.messages, TARGET))?.content).toBe('新台词');
    expect(await store.get(COLLECTIONS.backgroundTasks, 'task-T1')).toBeNull();
    // 这一轮的记忆被软删（墓碑留着给同步用），别的回合不动
    expect((await store.get<{ deletedAt: string | null }>(COLLECTIONS.memories, 'mem-1'))?.deletedAt).not.toBeNull();
    expect((await store.get<{ deletedAt: string | null }>(COLLECTIONS.memories, 'mem-2'))?.deletedAt).toBeNull();
  });

  it('中途失败时整批回滚：消息还是旧的、任务还在、记忆没被撤', async () => {
    const store = createMemoryEntityStore();
    await seedTurn(store);

    // 消息写完之后再让「清任务键」那一步炸掉——没有事务的话，旧实现会留下新台词
    const transact = store.transaction;
    if (transact === undefined) throw new Error('内存后端应当实现 transaction');
    const failing: EntityStore = {
      ...store,
      transaction: (run) =>
        transact((scope) =>
          run({
            ...scope,
            list: async () => {
              throw new Error('模拟存储故障');
            },
          }),
        ),
    };

    await expect(
      rewriteTurnWrites(failing, {
        messageId: TARGET,
        patch: { content: '新台词' },
        roomId: ROOM,
        turnId: 'T1',
      }),
    ).rejects.toThrow('模拟存储故障');

    expect((await store.get<Message>(COLLECTIONS.messages, TARGET))?.content).toBe('旧台词');
    expect(await store.get(COLLECTIONS.backgroundTasks, 'task-T1')).not.toBeNull();
    expect((await store.get<{ deletedAt: string | null }>(COLLECTIONS.memories, 'mem-1'))?.deletedAt).toBeNull();
  });

  it('消息已经不在库里时返回 null，并且不动任务与记忆', async () => {
    const store = createMemoryEntityStore();
    await store.put(COLLECTIONS.backgroundTasks, seedTask('T1'));
    await store.put(COLLECTIONS.memories, seedMemory('mem-1', ['T1']));

    const result = await rewriteTurnWrites(store, {
      messageId: messageId('missing'),
      patch: { content: '新台词' },
      roomId: ROOM,
      turnId: 'T1',
    });

    expect(result.message).toBeNull();
    expect(result.clearedTasks).toBe(0);
    expect(result.reverted.removedMemories).toBe(0);
    expect(await store.get(COLLECTIONS.backgroundTasks, 'task-T1')).not.toBeNull();
    expect((await store.get<{ deletedAt: string | null }>(COLLECTIONS.memories, 'mem-1'))?.deletedAt).toBeNull();
  });

  it('revertTurnWrites 单独撤一轮时走同一个事务', async () => {
    const store = createMemoryEntityStore();
    await store.put(COLLECTIONS.memories, seedMemory('mem-1', ['T1']));

    const result = await revertTurnWrites(store, ROOM, 'T1');

    expect(result.removedMemories).toBe(1);
    expect((await store.get<{ deletedAt: string | null }>(COLLECTIONS.memories, 'mem-1'))?.deletedAt).not.toBeNull();
  });
});
