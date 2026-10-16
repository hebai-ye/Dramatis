import {
  createBlankCard,
  createBlankWorldBook,
  createConversation,
  createMemoryEntityStore,
  createPersona,
  createPlayerMessage,
  createWorldBookEntry,
  createWorldFromCard,
  messageId,
  Repository,
  type RoomSnapshot,
  type WorldBook,
} from '@dramatis/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSession } from '../lib/session';

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Fixture value missing');
  return value;
}

const hooks = vi.hoisted(() => ({ snapshot: { current: null as unknown }, refIndex: 0, states: [] as unknown[] }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => [
    typeof initial === 'function' ? (initial as () => unknown)() : initial,
    (next: unknown) => hooks.states.push(next),
  ],
  useRef: (initial: unknown) => (hooks.refIndex++ === 0 ? hooks.snapshot : { current: initial }),
  useEffect: () => {},
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
}));

async function setup() {
  const repository = new Repository(createMemoryEntityStore());
  const card = createBlankCard();
  const world = createWorldFromCard(card, createPersona({ name: '玩家' }));
  const m1 = createConversation({ roomId: world.room.id, title: '目标一', kind: 'main' });
  const m2 = createConversation({ roomId: world.room.id, title: '目标二', kind: 'main' });
  await repository.saveRoom(world.room);
  await repository.saveConversation(m1);
  await repository.saveConversation(m2);
  await repository.saveCard(card);
  await repository.saveInstance(world.instance);
  await repository.saveRoom({ ...world.room, activeConversationId: m2.id });
  hooks.snapshot.current = null;
  // biome-ignore lint/correctness/useHookAtTopLevel: this test runs the real hook through a React state harness.
  const api = useSession({ repository } as never);
  await api.openWorld(world.room.id);
  const snapshot = hooks.snapshot.current as RoomSnapshot;
  hooks.states = [];
  return { repository, world, m1, m2, snapshot, api };
}

beforeEach(() => {
  hooks.refIndex = 0;
  hooks.states = [];
});
describe('admin session boundaries', () => {
  it('requires an explicit scene target instead of falling back to a main', async () => {
    const { api, repository, m1, m2 } = await setup();
    expect(await api.setWorldScene({ location: '不应写入' }, undefined as never)).toBeNull();
    expect((await repository.getConversation(m1.id))?.activeSceneId).toBeNull();
    expect((await repository.getConversation(m2.id))?.activeSceneId).toBeNull();
  });
  it('writes the captured main even when another main is active', async () => {
    const { api, repository, world, m1, m2 } = await setup();
    const scene = await api.setWorldScene({ location: '酒馆', castPolicy: 'locked' }, m1.id, world.room.id);
    expect(scene?.conversationId).toBe(m1.id);
    expect(scene?.castPolicy).toBe('locked');
    expect((await repository.getConversation(m2.id))?.activeSceneId).toBeNull();
  });
  it('rechecks archived targets in storage', async () => {
    const { api, repository, world, m1 } = await setup();
    await repository.saveConversation({ ...m1, archivedAt: 'now' });
    expect(await api.setWorldScene({ location: '酒馆' }, m1.id, world.room.id)).toBeNull();
  });
  it('rejects old-world scene requests', async () => {
    const { api, m1 } = await setup();
    expect(await api.setWorldScene({ location: '酒馆' }, m1.id, 'other-room' as never)).toBeNull();
  });
  it('blocks direct revoke of an adopted modified book at the API boundary', async () => {
    const { api, repository, snapshot, world } = await setup();
    const book = createBlankWorldBook('保留');
    await repository.saveWorldBook(book);
    const message = {
      ...createPlayerMessage({
        roomId: world.room.id,
        conversationId: required(snapshot.room.activeConversationId),
        sceneId: null,
        turnId: 'turn',
        speakerName: '管理员',
        content: '',
        audience: [],
      }),
      id: messageId('artifact-message'),
      role: 'admin' as const,
      artifacts: [
        {
          id: 'a',
          kind: 'world-book' as const,
          title: book.name,
          summary: '修改',
          status: 'adopted' as const,
          targetId: book.id,
          payload: book,
          previousPayload: book,
          baseUpdatedAt: book.updatedAt,
          createdAt: book.createdAt,
        },
      ],
    };
    await repository.appendMessages(world.room.id, [message]);
    snapshot.messages = [message];
    const outcome = await api.revokeArtifact(message.id, 'a');
    expect(await repository.getWorldBook(book.id)).not.toBeNull();
    expect(outcome).toMatchObject({ status: 'blocked', reason: expect.stringContaining('反向') });
  });
  it('rejects an old modifying draft without before even through direct adopt', async () => {
    const { api, repository, snapshot, world } = await setup();
    const seed = createBlankWorldBook('原书');
    await repository.saveWorldBook(seed);
    const book = required(await repository.getWorldBook(seed.id));
    const message = {
      ...createPlayerMessage({
        roomId: world.room.id,
        conversationId: required(snapshot.room.activeConversationId),
        sceneId: null,
        turnId: 't',
        speakerName: '管理员',
        content: '',
        audience: [],
      }),
      role: 'admin' as const,
      artifacts: [
        {
          id: 'old',
          kind: 'world-book' as const,
          title: '覆盖',
          summary: '修改',
          status: 'pending' as const,
          targetId: null,
          payload: { ...book, name: '覆盖' },
          baseUpdatedAt: book.updatedAt,
          createdAt: book.createdAt,
        },
      ],
    };
    await repository.appendMessages(world.room.id, [message]);
    snapshot.messages = [message];
    await api.adoptArtifact(message.id, 'old');
    expect((await repository.getWorldBook(book.id))?.name).toBe('原书');
    expect((await repository.listMessages(world.room.id))[0]?.artifacts?.[0]?.conflict).toContain('重新起草');
  });
  it('creates a fresh reverse draft preserving unrelated edits and rejects its later stale adoption', async () => {
    const { api, repository, snapshot, world } = await setup();
    const seed = {
      ...createBlankWorldBook('原书'),
      entries: [
        createWorldBookEntry({ content: '一', constant: true }),
        createWorldBookEntry({ content: '二', constant: true }),
      ],
    };
    await repository.saveWorldBook(seed);
    const before = required(await repository.getWorldBook(seed.id));
    const after = {
      ...before,
      entries: [required(before.entries[0]), { ...required(before.entries[1]), content: '改二' }],
    };
    const message = {
      ...createPlayerMessage({
        roomId: world.room.id,
        conversationId: required(snapshot.room.activeConversationId),
        sceneId: null,
        turnId: 't',
        speakerName: '管理员',
        content: '',
        audience: [],
      }),
      role: 'admin' as const,
      artifacts: [
        {
          id: 'forward',
          kind: 'world-book' as const,
          title: '原书',
          summary: '修改',
          status: 'pending' as const,
          targetId: null,
          payload: after,
          previousPayload: before,
          baseUpdatedAt: before.updatedAt,
          createdAt: before.createdAt,
        },
      ],
    };
    await repository.appendMessages(world.room.id, [message]);
    snapshot.messages = [message];
    await api.adoptArtifact(message.id, 'forward');
    const adopted = required(await repository.getWorldBook(seed.id));
    await repository.saveWorldBook({
      ...adopted,
      entries: [{ ...required(adopted.entries[0]), content: '用户一' }, required(adopted.entries[1])],
    });
    await api.reverseArtifact(message.id, 'forward');
    const pendingMessage = required((await repository.listMessages(world.room.id)).at(-1));
    const pending = required(pendingMessage.artifacts?.[0]);
    expect((pending.payload as WorldBook).entries.map((e) => e.content)).toEqual(['用户一', '二']);
    expect(pending.status).toBe('pending');
    await repository.saveWorldBook({ ...required(await repository.getWorldBook(seed.id)), name: '后来改名' });
    await api.adoptArtifact(pendingMessage.id, pending.id);
    expect((await repository.getWorldBook(seed.id))?.name).toBe('后来改名');
    expect((await repository.listMessages(world.room.id)).at(-1)?.artifacts?.[0]?.conflict).toContain('版本');
  });
  it('does not restore the old world UI after delayed scene persistence', async () => {
    const { api, repository, world, m1, snapshot } = await setup();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const save = repository.saveScene.bind(repository);
    vi.spyOn(repository, 'saveScene').mockImplementation(async (scene) => {
      entered();
      await pending;
      await save(scene);
    });
    const write = api.setWorldScene({ location: '旧世界酒馆' }, m1.id, world.room.id);
    await started;
    hooks.snapshot.current = { ...snapshot, room: { ...snapshot.room, id: 'new-world' } };
    release();
    await write;
    expect((hooks.snapshot.current as RoomSnapshot).room.id).toBe('new-world');
    expect(hooks.states).toHaveLength(0);
  });
});
