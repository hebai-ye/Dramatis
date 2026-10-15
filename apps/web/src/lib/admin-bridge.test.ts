import {
  createBlankCard,
  createConversation,
  createMemoryEntityStore,
  createSceneFor,
  Repository,
  type Room,
  roomId,
} from '@dramatis/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAdminChat } from './admin';
import type { DramatisDb } from './db';
import type { ProvidersApi } from './providers';
import type { SessionApi } from './session';

const host = vi.hoisted(() => {
  let cells: unknown[] = [];
  let cursor = 0;
  return {
    state(initial: unknown) {
      const i = cursor++;
      if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial;
      return [
        cells[i],
        (next: unknown) => {
          cells[i] = typeof next === 'function' ? next(cells[i]) : next;
        },
      ];
    },
    ref(initial: unknown) {
      const i = cursor++;
      cells[i] ??= { current: initial };
      return cells[i];
    },
    begin() {
      cursor = 0;
    },
    reset() {
      cells = [];
      cursor = 0;
    },
  };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: host.state,
  useRef: host.ref,
  useCallback: (value: unknown) => value,
  useMemo: (run: () => unknown) => run(),
  useEffect: () => {},
}));

function render(options: Parameters<typeof useAdminChat>[0]) {
  host.begin();
  // biome-ignore lint/correctness/useHookAtTopLevel: controlled hook host executes the actual hook with dependency-light lifecycle.
  return useAdminChat(options);
}
beforeEach(() => {
  host.reset();
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});

async function fixture() {
  const repository = new Repository(createMemoryEntityStore());
  const world: Room = {
    id: roomId('admin-world-a'),
    title: 'A',
    personaId: null,
    playerName: 'Player',
    playerPersona: '',
    cardIds: [],
    instanceIds: [],
    worldBookIds: [],
    activeConversationId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    deletedAt: null,
  };
  const side = createConversation({ roomId: world.id, kind: 'side', title: 'Admin' });
  const main = createConversation({ roomId: world.id, title: 'Main' });
  const scene = createSceneFor(world.id, main.id, [], { location: 'original' });
  await repository.saveRoom(world);
  await repository.saveConversation(side);
  await repository.saveConversation({ ...main, activeSceneId: scene.id });
  await repository.saveScene(scene);
  const session = {
    world,
    conversation: side,
    messages: [],
    instances: [],
    personas: [],
    library: { cards: [], worldBooks: [] },
    appendMessages: vi.fn(async (messages, onPersisted) => {
      await repository.appendMessages(world.id, messages);
      onPersisted?.();
    }),
    setWorldScene: vi.fn(async (patch) => {
      const next = { ...scene, ...patch };
      await repository.saveScene(next);
      return next;
    }),
    reloadWorld: vi.fn(async () => {}),
  } as unknown as SessionApi;
  const options = {
    db: { repository } as DramatisDb,
    session,
    providers: { active: { model: 'fake' }, apiKey: '' } as unknown as ProvidersApi,
    onChanged: vi.fn(),
    accountKey: 'account-a',
  };
  return { repository, world, side, scene, options };
}

describe('副桥接来源和发送等待', () => {
  it('切世界后拒绝旧起草且不写当前世界', async () => {
    const f = await fixture();
    let api = render(f.options);
    await api.send('prepare');
    api = render(f.options);
    f.options.session = { ...f.options.session, world: { ...f.world, id: roomId('admin-world-b') } };
    api = render(f.options);
    await api.commitBridge('{"tool":"set_scene","arguments":{"location":"wrong-world"}}');
    api = render(f.options);
    expect(f.options.session.setWorldScene).not.toHaveBeenCalled();
    expect(api.error).toMatch(/所属|来源|原世界/);
  });
  it('提示词准备后场景已修改，不能应用旧场景起草', async () => {
    const f = await fixture();
    let api = render(f.options);
    await api.send('prepare');
    api = render(f.options);
    await f.repository.saveScene({ ...f.scene, location: 'newer' });
    await api.commitBridge('{"tool":"set_scene","arguments":{"location":"old-draft"}}');
    api = render(f.options);
    expect(f.options.session.setWorldScene).not.toHaveBeenCalled();
    expect((await f.repository.getScene(f.scene.id))?.location).toBe('newer');
    expect(api.error).toMatch(/变化|修改|重新/);
  });
  it('等待起草时直接再次send不新增玩家消息或替换提示词', async () => {
    const f = await fixture();
    let api = render(f.options);
    await api.send('first');
    api = render(f.options);
    const prompt = api.bridge?.prompt;
    await api.send('second');
    api = render(f.options);
    expect(f.options.session.appendMessages).toHaveBeenCalledTimes(1);
    expect(api.bridge?.prompt).toBe(prompt);
  });
  it('合法来源的场景及管理员消息一起持久化', async () => {
    const f = await fixture();
    let api = render(f.options);
    await api.send('prepare');
    api = render(f.options);
    await api.commitBridge('{"tool":"set_scene","arguments":{"location":"accepted"}}');
    expect((await f.repository.getScene(f.scene.id))?.location, render(f.options).error ?? '').toBe('accepted');
    expect((await f.repository.listMessages(f.world.id)).some((message) => message.role === 'admin')).toBe(true);
  });
  it('换账户拒绝旧桥接，回到原来源可以继续', async () => {
    const f = await fixture();
    let api = render(f.options);
    await api.send('prepare');
    api = render(f.options);
    f.options.accountKey = 'account-b';
    api = render(f.options);
    await api.commitBridge('{"tool":"set_scene","arguments":{"location":"blocked"}}');
    expect((await f.repository.getScene(f.scene.id))?.location).toBe('original');
    f.options.accountKey = 'account-a';
    api = render(f.options);
    await api.commitBridge('{"tool":"set_scene","arguments":{"location":"resumed"}}');
    expect((await f.repository.getScene(f.scene.id))?.location).toBe('resumed');
  });
  it('来源读取失败时不应用，允许保留旧进度', async () => {
    const f = await fixture();
    let api = render(f.options);
    await api.send('prepare');
    api = render(f.options);
    vi.spyOn(f.repository, 'atomic').mockRejectedValueOnce(new Error('Synthetic source read failed'));
    await api.commitBridge('{"tool":"set_scene","arguments":{"location":"blocked"}}');
    expect((await f.repository.getScene(f.scene.id))?.location).toBe('original');
    expect(render(f.options).bridge).not.toBeNull();
    expect(render(f.options).error).toContain('Synthetic source read failed');
  });
  it('全局素材变化也拒绝此前准备的提示词', async () => {
    const f = await fixture();
    let api = render(f.options);
    await api.send('prepare');
    api = render(f.options);
    await f.repository.saveCard(createBlankCard({ name: 'Synthetic changed source' }));
    await api.commitBridge('{"tool":"set_scene","arguments":{"location":"blocked"}}');
    expect((await f.repository.getScene(f.scene.id))?.location).toBe('original');
    expect(render(f.options).error).toMatch(/变化/);
  });
  it('管理员消息落盘失败时场景一起回滚', async () => {
    const f = await fixture();
    let api = render(f.options);
    await api.send('prepare');
    api = render(f.options);
    const atomic = f.repository.atomic.bind(f.repository);
    vi.spyOn(f.repository, 'atomic').mockImplementation((run) =>
      atomic(async (tx, store) => {
        tx.appendMessages = async () => {
          throw new Error('Synthetic admin message write failed');
        };
        return run(tx, store);
      }),
    );
    await api.commitBridge('{"tool":"set_scene","arguments":{"location":"must-rollback"}}');
    expect((await f.repository.getScene(f.scene.id))?.location).toBe('original');
    expect((await f.repository.listMessages(f.world.id)).filter((message) => message.role === 'admin')).toHaveLength(0);
    expect(render(f.options).bridge).not.toBeNull();
    expect(render(f.options).error).toContain('Synthetic admin message write failed');
  });
  it('发送接受在玩家保存后返回，不因提示词读取失败清空错误来源', async () => {
    const f = await fixture();
    const accepted = vi.fn();
    vi.spyOn(f.repository, 'atomic').mockRejectedValueOnce(new Error('Synthetic prepare read failed'));
    const result = await render(f.options).send('saved-player', accepted);
    expect(result).toEqual({ status: 'accepted' });
    expect(accepted).toHaveBeenCalledWith(result);
    expect((await f.repository.listMessages(f.world.id)).map((message) => message.content)).toEqual(['saved-player']);
    expect(render(f.options).bridge).toBeNull();
    expect(render(f.options).error).toContain('Synthetic prepare read failed');
  });
});
