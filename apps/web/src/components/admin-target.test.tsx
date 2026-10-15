import {
  createBlankCard,
  createConversation,
  createMemoryEntityStore,
  createPersona,
  createWorldFromCard,
  Repository,
  sceneId,
} from '@dramatis/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAdminChat } from '../lib/admin';

const harness = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, apiTarget: null as unknown }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.values))
      harness.values[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    return [
      harness.values[index],
      (next: unknown) => {
        harness.values[index] = next;
      },
    ];
  },
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: () => {},
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
}));
vi.mock('../lib/bridge-store', () => ({ loadBridge: () => null, saveBridge: () => {} }));
vi.mock('../lib/stream-store', () => ({
  resetStreamState: () => {},
  setStreamState: () => {},
  handoffStreamState: () => {},
}));
vi.mock('@dramatis/core', async (original) => ({
  ...(await original<typeof import('@dramatis/core')>()),
  createOpenAICompatibleProvider: () => ({}),
  runAdminTurn: async function* (
    _provider: unknown,
    _messages: unknown,
    options: { execute: (draft: unknown) => Promise<string> },
  ) {
    await options.execute({ kind: 'scene', patch: { location: '酒馆' }, summary: '地点酒馆' });
    yield { type: 'done', text: '已设置', usage: null };
  },
}));

async function setup(apiKey = '') {
  const world = createWorldFromCard(createBlankCard(), createPersona({ name: '玩家' }));
  const side = createConversation({ roomId: world.room.id, kind: 'side', title: '管理' });
  const m1 = createConversation({ roomId: world.room.id, kind: 'main', title: '目标一' });
  const m2 = createConversation({ roomId: world.room.id, kind: 'main', title: '目标二' });
  const writes: unknown[][] = [];
  const messages: { content: string; artifacts?: { summary: string }[] }[] = [];
  const repository = new Repository(createMemoryEntityStore());
  await repository.saveSnapshot({ room: world.room, conversations: [side, m1, m2] });
  const session = {
    world: world.room,
    conversation: side,
    conversations: [m1, m2],
    messages: [],
    instances: [],
    library: { cards: [], worldBooks: [] },
    personas: [],
    appendMessages: async (next: typeof messages, onPersisted?: () => void) => {
      await repository.appendMessages(world.room.id, next as never);
      messages.push(...next);
      onPersisted?.();
    },
    reloadWorld: async () => {},
    setWorldScene: async (...args: unknown[]) => {
      writes.push(args);
      return { id: 'scene' };
    },
  };
  const options = {
    db: {
      repository,
      ledger: { record: async () => {} },
    } as never,
    session: session as never,
    providers: { active: { model: 'test', baseUrl: 'test', temperature: 1 }, apiKey } as never,
    onChanged: () => {},
    accountKey: 'fixture-account',
  };
  const render = () => {
    harness.cursor = 0;
    return useAdminChat(options);
  };
  return { render, session, m1, m2, writes, messages, world, repository };
}
beforeEach(() => {
  harness.values = [];
  harness.cursor = 0;
});
describe('admin captured targets', () => {
  it.each(['', 'sk-test'])('binds the explicit target for bridge/API (key=%s)', async (key) => {
    const { render, m1, m2, world, writes, repository } = await setup(key);
    await render().send('改场景', m1.id);
    if (!key) {
      const api = render();
      expect(api.bridge).toMatchObject({ roomId: world.room.id, targetConversationId: m1.id });
      expect(api.bridge?.prompt).toContain('目标一');
      await api.commitBridge('{"tool":"set_scene","arguments":{"location":"酒馆"}}');
      const main = await repository.getConversation(m1.id);
      expect(main?.activeSceneId).not.toBeNull();
      expect((await repository.getScene(main?.activeSceneId as never))?.location).toBe('酒馆');
      expect((await repository.getConversation(m2.id))?.activeSceneId).toBeNull();
    } else {
      expect(writes).toEqual([[{ location: '酒馆' }, m1.id, world.room.id]]);
    }
    const messages = await repository.listMessages(world.room.id);
    expect(messages.at(-1)?.artifacts?.[0]?.summary).toContain('目标一');
  });
  it('does not invent a target among multiple main conversations', async () => {
    const { render, writes, repository, world } = await setup();
    await render().send('改场景');
    await render().commitBridge('{"tool":"set_scene","arguments":{"location":"酒馆"}}');
    expect(writes).toHaveLength(0);
    const messages = await repository.listMessages(world.room.id);
    expect(messages.at(-1)?.content).toContain('选择');
  });
  it('rejects bridge completion in another world', async () => {
    const { render, session, m1, writes, repository, world } = await setup();
    await render().send('改场景', m1.id);
    session.world = { ...session.world, id: 'other' as never };
    await render().commitBridge('{"tool":"set_scene","arguments":{"location":"酒馆"}}');
    expect(writes).toHaveLength(0);
    expect((await repository.getConversation(m1.id))?.activeSceneId).toBeNull();
    expect(await repository.listScenes(world.room.id)).toEqual([]);
    expect(render().error).toContain('原世界');
  });
  it('does not redirect a prepared scene after its captured target is deleted', async () => {
    const { render, m1, m2, repository, world } = await setup();
    await render().send('改场景', m1.id);
    await repository.deleteConversation(m1.id);
    await render().commitBridge('{"tool":"set_scene","arguments":{"location":"旧目标"}}');
    expect(render().bridge).not.toBeNull();
    expect(render().error).toContain('目标');
    expect((await repository.getConversation(m2.id))?.activeSceneId).toBeNull();
    expect(await repository.listScenes(world.room.id)).toEqual([]);
    expect(await repository.listMessages(world.room.id)).toHaveLength(1);
  });
  it('keeps the captured target when another main becomes active', async () => {
    const { render, m1, m2, repository, world } = await setup();
    await render().send('改场景', m1.id);
    await repository.saveRoom({ ...world.room, activeConversationId: m2.id });
    await render().commitBridge('{"tool":"set_scene","arguments":{"location":"原目标"}}');
    const target = await repository.getConversation(m1.id);
    expect(target?.activeSceneId).not.toBeNull();
    expect((await repository.getScene(target?.activeSceneId as never))?.location).toBe('原目标');
    expect((await repository.getConversation(m2.id))?.activeSceneId).toBeNull();
    expect(render().bridge).toBeNull();
  });
  it.each(['getConversation', 'getScene'] as const)('ignores late %s errors after switching worlds', async (read) => {
    const { render, session, m1, writes, messages, repository } = await setup();
    let rejectRead: (reason: Error) => void = () => {};
    const pendingRead = new Promise<never>((_resolve, reject) => {
      rejectRead = reject;
    });
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    if (read === 'getScene') {
      m1.activeSceneId = sceneId('captured-scene');
      await repository.saveConversation(m1);
    }
    vi.spyOn(repository, read).mockImplementationOnce(() => {
      markStarted();
      return pendingRead;
    });
    const sending = render().send('改场景', m1.id);
    await started;
    session.world = { ...session.world, id: 'new-world' as never };
    render();
    rejectRead(new Error('原世界读取失败'));
    await sending;
    const current = render();
    expect(current.error).toBeNull();
    expect(current.busy).toBe(false);
    expect(current.bridge).toBeNull();
    expect(writes).toHaveLength(0);
    expect(messages).toHaveLength(0);
  });
});
