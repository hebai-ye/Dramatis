import {
  createBlankCard,
  createConversation,
  createMemoryEntityStore,
  createPersona,
  createPlayerMessage,
  createWorldFromCard,
  META_KEYS,
  type Message,
  Repository,
  type Room,
  type RoomId,
} from '@dramatis/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type SessionApi, useSession } from '../lib/session';

// The repository is real. This small React state harness only supplies render cycles to
// the real useSession hook; tests observe its public, rendered SessionApi values.
const react = vi.hoisted(() => {
  let values: unknown[] = [];
  let cursor = 0;
  let observe: ((value: unknown) => void) | undefined;
  return {
    reset() {
      values = [];
      cursor = 0;
      observe = undefined;
    },
    begin() {
      cursor = 0;
    },
    observe(callback: (value: unknown) => void) {
      observe = callback;
    },
    state(initial: unknown) {
      const index = cursor++;
      if (!(index in values)) values[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [
        values[index],
        (next: unknown) => {
          values[index] = typeof next === 'function' ? (next as (previous: unknown) => unknown)(values[index]) : next;
          const observed = values[index] as { value?: unknown } | null;
          observe?.(observed && typeof observed === 'object' && 'value' in observed ? observed.value : observed);
        },
      ];
    },
    ref(initial: unknown) {
      const [value] = this.state(() => ({ current: initial }));
      return value;
    },
  };
});

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: react.state,
  useRef: (initial: unknown) => react.ref(initial),
  useEffect: () => {},
  useLayoutEffect: () => {},
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
}));

function barrier() {
  let entered!: () => void;
  let release!: () => void;
  return {
    entered: new Promise<void>((resolve) => {
      entered = resolve;
    }),
    released: new Promise<void>((resolve) => {
      release = resolve;
    }),
    enter: () => entered(),
    release: () => release(),
  };
}

async function setup() {
  const repository = new Repository(createMemoryEntityStore());
  const persona = createPersona({ name: '玩家' });
  const a = createWorldFromCard(createBlankCard({ name: 'A 世界' }), persona);
  const b = createWorldFromCard(createBlankCard({ name: 'B 世界' }), persona);
  for (const world of [a, b]) {
    await repository.saveRoom(world.room);
    await repository.saveConversation(world.conversation);
    await repository.saveScene(world.scene);
  }
  const db = { repository } as never;
  function render(): SessionApi {
    react.begin();
    // biome-ignore lint/correctness/useHookAtTopLevel: this is the render entry of the controlled React hook harness.
    return useSession(db);
  }
  render();
  return { repository, a, b, render };
}

// Delay publication after the real transaction commits; never hold its lock while another write runs.
function observeCommittedRooms(repository: Repository, onSaved: (room: Room) => Promise<void>) {
  const atomic = repository.atomic.bind(repository);
  const saveRoom = repository.saveRoom.bind(repository);
  const direct = vi.spyOn(repository, 'saveRoom').mockImplementation(async (room) => {
    await saveRoom(room);
    await onSaved(room);
  });
  const transaction = vi.spyOn(repository, 'atomic').mockImplementation(async (action) => {
    const writes: Room[] = [];
    const result = await atomic(async (scope, store) => {
      const save = scope.saveRoom.bind(scope);
      scope.saveRoom = async (room) => {
        await save(room);
        writes.push(room);
      };
      return action(scope, store);
    });
    for (const room of writes) await onSaved(room);
    return result;
  });
  return {
    mockRestore: () => {
      direct.mockRestore();
      transaction.mockRestore();
    },
  };
}

function holdLoadedRoom(repository: Repository, id: RoomId) {
  const gate = barrier();
  const load = repository.loadRoom.bind(repository);
  let held = false;
  const spy = vi.spyOn(repository, 'loadRoom').mockImplementation(async (requested, options) => {
    const loaded = await load(requested, options);
    if (requested === id && !held) {
      held = true;
      gate.enter(); // the old snapshot is complete; only its return to the hook is delayed
      await gate.released;
    }
    return loaded;
  });
  return { ...gate, restore: () => spy.mockRestore() };
}

function messageFor(world: ReturnType<typeof createWorldFromCard>, content: string): Message {
  return createPlayerMessage({
    roomId: world.room.id,
    conversationId: world.conversation.id,
    sceneId: world.scene.id,
    turnId: `turn-${content}`,
    speakerName: '玩家',
    content,
  });
}

async function setupCommittedChoice(archived = false) {
  const fixture = await setup();
  const { repository, a, render } = fixture;
  const other = createConversation({ roomId: a.room.id, title: 'C2', kind: 'main' });
  await repository.saveConversation(other);
  if (archived) await repository.archiveConversation(other.id);
  await render().openWorld(a.room.id);
  const capturedRoom = render().world;
  if (!capturedRoom) throw new Error('captured room fixture missing');
  await render().openConversation(other.id);
  // Explicitly seed a legacy/external stale active choice; subsequent reads/writes use the real repository.
  await repository.saveRoom(capturedRoom);
  expect(render().conversation?.id).toBe(other.id);
  expect((await repository.getRoom(a.room.id))?.activeConversationId).toBe(a.conversation.id);
  return { ...fixture, other };
}

beforeEach(() => {
  react.reset();
  vi.restoreAllMocks();
});

describe('useSession async snapshot selection', () => {
  it('keeps B visible and lastRoom=B when an older A open returns last', async () => {
    const { repository, a, b, render } = await setup();
    const gate = holdLoadedRoom(repository, a.room.id);
    const oldA = render().openWorld(a.room.id);
    try {
      await gate.entered;
      await render().openWorld(b.room.id);
      expect(render().world?.id).toBe(b.room.id);
    } finally {
      gate.release();
      await oldA;
      gate.restore();
    }
    expect.soft(render().world?.id).toBe(b.room.id);
    expect.soft(await repository.getMeta<RoomId>(META_KEYS.lastRoomId)).toBe(b.room.id);
  });

  it('keeps an appended message when a prior reload returns its stale snapshot', async () => {
    const { repository, a, render } = await setup();
    await repository.appendMessages(a.room.id, [messageFor(a, 'm1')]);
    await render().openWorld(a.room.id);
    const gate = holdLoadedRoom(repository, a.room.id);
    const reload = render().reloadWorld();
    try {
      await gate.entered;
      await render().appendMessages([messageFor(a, 'm2')]);
      expect(render().messages.map((item) => item.content)).toEqual(['m1', 'm2']);
    } finally {
      gate.release();
      await reload;
      gate.restore();
    }
    expect.soft(render().messages.map((item) => item.content)).toEqual(['m1', 'm2']);
    expect.soft((await repository.listMessages(a.room.id)).map((item) => item.content)).toEqual(['m1', 'm2']);
  });

  it('does not let an A message update restore A after B is selected', async () => {
    const { repository, a, b, render } = await setup();
    const [message] = await repository.appendMessages(a.room.id, [messageFor(a, 'before')]);
    if (!message) throw new Error('message fixture missing');
    await render().openWorld(a.room.id);
    const gate = barrier();
    const update = repository.updateMessage.bind(repository);
    const spy = vi.spyOn(repository, 'updateMessage').mockImplementation(async (id, patch) => {
      const result = await update(id, patch);
      gate.enter();
      await gate.released;
      return result;
    });
    const pending = render().updateMessage(message.id, { content: 'after' });
    try {
      await gate.entered;
      await render().openWorld(b.room.id);
    } finally {
      gate.release();
      await pending;
      spy.mockRestore();
    }
    expect.soft(render().world?.id).toBe(b.room.id);
    expect.soft(render().messages).toEqual([]);
    expect.soft((await repository.listMessages(a.room.id))[0]?.content).toBe('after');
    expect.soft(await repository.getMeta<RoomId>(META_KEYS.lastRoomId)).toBe(b.room.id);
  });

  it('does not let an A scene update restore A after B is selected', async () => {
    const { repository, a, b, render } = await setup();
    await render().openWorld(a.room.id);
    const gate = barrier();
    const save = repository.saveScene.bind(repository);
    const spy = vi.spyOn(repository, 'saveScene').mockImplementation(async (scene) => {
      await save(scene);
      gate.enter();
      await gate.released;
    });
    const pending = render().updateScene({ location: 'A 酒馆' });
    try {
      await gate.entered;
      await render().openWorld(b.room.id);
    } finally {
      gate.release();
      await pending;
      spy.mockRestore();
    }
    expect.soft(render().world?.id).toBe(b.room.id);
    expect.soft(render().scene?.id).toBe(b.scene.id);
    expect.soft(render().scene?.location).toBe(b.scene.location);
    expect.soft((await repository.getScene(a.scene.id))?.location).toBe('A 酒馆');
    expect.soft(await repository.getMeta<RoomId>(META_KEYS.lastRoomId)).toBe(b.room.id);
  });

  it('distinguishes an old A open from a later A open across A → B → A', async () => {
    const { repository, a, b, render } = await setup();
    const gate = holdLoadedRoom(repository, a.room.id);
    const oldA = render().openWorld(a.room.id);
    try {
      await gate.entered;
      await render().openWorld(b.room.id);
      await repository.saveRoom({ ...a.room, title: 'A 新快照' });
      await render().openWorld(a.room.id);
      expect(render().world?.title).toBe('A 新快照');
    } finally {
      gate.release();
      await oldA;
      gate.restore();
    }
    expect.soft(render().world?.id).toBe(a.room.id);
    expect.soft(render().world?.title).toBe('A 新快照');
    expect.soft(await repository.getMeta<RoomId>(META_KEYS.lastRoomId)).toBe(a.room.id);
  });

  it('lets B overwrite an A metadata write that already started', async () => {
    const { repository, a, b, render } = await setup();
    const writingA = barrier();
    const loadedB = barrier();
    const setMeta = repository.setMeta.bind(repository);
    const loadRoom = repository.loadRoom.bind(repository);
    const writes: unknown[] = [];
    const metaSpy = vi.spyOn(repository, 'setMeta').mockImplementation(async (key, value) => {
      if (key === META_KEYS.lastRoomId && value === a.room.id) {
        writingA.enter();
        await writingA.released;
      }
      await setMeta(key, value);
      if (key === META_KEYS.lastRoomId) writes.push(value);
    });
    const loadSpy = vi.spyOn(repository, 'loadRoom').mockImplementation(async (id, options) => {
      const loaded = await loadRoom(id, options);
      if (id === b.room.id) loadedB.enter();
      return loaded;
    });
    const pendingA = render().openWorld(a.room.id);
    let pendingB: Promise<void> | undefined;
    try {
      await writingA.entered;
      pendingB = render().openWorld(b.room.id);
      await loadedB.entered;
    } finally {
      writingA.release();
      await Promise.all([pendingA, pendingB]);
      metaSpy.mockRestore();
      loadSpy.mockRestore();
    }
    expect.soft(render().world?.id).toBe(b.room.id);
    expect.soft(writes).toEqual([a.room.id, b.room.id]);
    expect.soft(await repository.getMeta<RoomId>(META_KEYS.lastRoomId)).toBe(b.room.id);
  });

  it('skips obsolete queued metadata writes across A → B → A', async () => {
    const { repository, a, b, render } = await setup();
    const writingA = barrier();
    const selectedB = barrier();
    const selectedNewA = barrier();
    const setMeta = repository.setMeta.bind(repository);
    const writes: unknown[] = [];
    let held = false;
    const spy = vi.spyOn(repository, 'setMeta').mockImplementation(async (key, value) => {
      if (key === META_KEYS.lastRoomId && value === a.room.id && !held) {
        held = true;
        writingA.enter();
        await writingA.released;
      }
      await setMeta(key, value);
      if (key === META_KEYS.lastRoomId) writes.push(value);
    });
    const pendingOldA = render().openWorld(a.room.id);
    let pendingB: Promise<void> | undefined;
    let pendingNewA: Promise<void> | undefined;
    try {
      await writingA.entered;
      react.observe((value) => {
        if ((value as { room?: { id?: unknown } } | null)?.room?.id === b.room.id) selectedB.enter();
      });
      pendingB = render().openWorld(b.room.id);
      await selectedB.entered;
      react.observe((value) => {
        if ((value as { room?: { id?: unknown } } | null)?.room?.id === a.room.id) selectedNewA.enter();
      });
      pendingNewA = render().openWorld(a.room.id);
      await selectedNewA.entered;
    } finally {
      writingA.release();
      await Promise.all([pendingOldA, pendingB, pendingNewA]);
      spy.mockRestore();
    }
    expect.soft(render().world?.id).toBe(a.room.id);
    expect.soft(writes).toEqual([a.room.id, a.room.id]);
    expect.soft(await repository.getMeta<RoomId>(META_KEYS.lastRoomId)).toBe(a.room.id);
  });

  it('merges a delayed message edit into the latest snapshot without losing an append', async () => {
    const { repository, a, render } = await setup();
    const [message] = await repository.appendMessages(a.room.id, [messageFor(a, 'before')]);
    if (!message) throw new Error('message fixture missing');
    await render().openWorld(a.room.id);
    const gate = barrier();
    const update = repository.updateMessage.bind(repository);
    const spy = vi.spyOn(repository, 'updateMessage').mockImplementation(async (id, patch) => {
      const result = await update(id, patch);
      gate.enter();
      await gate.released;
      return result;
    });
    const pending = render().updateMessage(message.id, { content: 'after' });
    try {
      await gate.entered;
      await render().appendMessages([messageFor(a, 'm2')]);
    } finally {
      gate.release();
      await pending;
      spy.mockRestore();
    }
    expect.soft(render().messages.map((item) => item.content)).toEqual(['after', 'm2']);
    expect.soft((await repository.listMessages(a.room.id)).map((item) => item.content)).toEqual(['after', 'm2']);
  });

  it('rejects an old A scene completion after A → B → A', async () => {
    const { repository, a, b, render } = await setup();
    await render().openWorld(a.room.id);
    const gate = barrier();
    const save = repository.saveScene.bind(repository);
    let held = false;
    const spy = vi.spyOn(repository, 'saveScene').mockImplementation(async (scene) => {
      await save(scene);
      if (!held) {
        held = true;
        gate.enter();
        await gate.released;
      }
    });
    const pending = render().updateScene({ location: '旧 A' });
    try {
      await gate.entered;
      await render().openWorld(b.room.id);
      await repository.saveScene({ ...a.scene, location: '新 A' });
      await render().openWorld(a.room.id);
    } finally {
      gate.release();
      await pending;
      spy.mockRestore();
    }
    expect.soft(render().scene?.location).toBe('新 A');
    expect.soft((await repository.getScene(a.scene.id))?.location).toBe('新 A');
  });

  it('treats reselecting the visible conversation as the newest choice during a pending switch', async () => {
    const { repository, a, render } = await setup();
    const other = createConversation({ roomId: a.room.id, title: 'C2', kind: 'main' });
    await repository.saveConversation(other);
    await render().openWorld(a.room.id);
    const gate = barrier();
    let held = false;
    const spy = observeCommittedRooms(repository, async (room) => {
      if (room.activeConversationId === other.id && !held) {
        held = true;
        gate.enter();
        await gate.released;
      }
    });
    const pending = render().openConversation(other.id);
    try {
      await gate.entered;
      expect(render().conversation?.id).toBe(a.conversation.id);
      await render().openConversation(a.conversation.id);
    } finally {
      gate.release();
      await pending;
      spy.mockRestore();
    }
    expect.soft(render().conversation?.id).toBe(a.conversation.id);
    expect.soft((await repository.getRoom(a.room.id))?.activeConversationId).toBe(a.conversation.id);
    expect.soft(await repository.getMeta<RoomId>(META_KEYS.lastRoomId)).toBe(a.room.id);
  });

  it('treats reselecting the visible world as the newest choice during a pending world open', async () => {
    const { repository, a, b, render } = await setup();
    await render().openWorld(a.room.id);
    const gate = holdLoadedRoom(repository, b.room.id);
    const pending = render().openWorld(b.room.id);
    try {
      await gate.entered;
      await render().openWorld(a.room.id);
    } finally {
      gate.release();
      await pending;
      gate.restore();
    }
    expect.soft(render().world?.id).toBe(a.room.id);
    expect.soft(await repository.getMeta<RoomId>(META_KEYS.lastRoomId)).toBe(a.room.id);
  });

  it('does not revive a discarded artifact when an earlier content edit returns its cloned message', async () => {
    const { repository, a, render } = await setup();
    const card = createBlankCard({ name: '草稿角色' });
    const [message] = await repository.appendMessages(a.room.id, [
      {
        ...messageFor(a, 'before'),
        role: 'admin',
        artifacts: [
          {
            id: 'discard-during-edit',
            kind: 'character-card',
            title: card.name,
            summary: '待确认的角色',
            status: 'pending',
            payload: card,
            targetId: null,
            createdAt: card.createdAt,
          },
        ],
      },
    ]);
    if (!message) throw new Error('message fixture missing');
    await render().openWorld(a.room.id);
    const gate = barrier();
    const update = repository.updateMessage.bind(repository);
    const spy = vi.spyOn(repository, 'updateMessage').mockImplementation(async (id, patch) => {
      const updated = await update(id, patch);
      gate.enter();
      await gate.released;
      return updated;
    });
    const pending = render().updateMessage(message.id, { content: 'after' });
    try {
      await gate.entered;
      await render().discardArtifact(message.id, 'discard-during-edit');
      expect(render().messages[0]?.artifacts?.[0]?.status).toBe('discarded');
    } finally {
      gate.release();
      await pending;
      spy.mockRestore();
    }
    expect.soft(render().messages[0]?.content).toBe('after');
    expect.soft(render().messages[0]?.artifacts?.[0]?.status).toBe('discarded');
    const stored = (await repository.listMessages(a.room.id))[0];
    expect.soft(stored?.content).toBe('after');
    expect.soft(stored?.artifacts?.[0]?.status).toBe('discarded');
  });

  it('does not revive an instance that was loaded and then removed before its earlier add returns', async () => {
    const { repository, a, render } = await setup();
    await render().openWorld(a.room.id);
    const card = createBlankCard({ name: '后来删除的 X' });
    const gate = barrier();
    let held = false;
    const spy = observeCommittedRooms(repository, async (room) => {
      if (room.cardIds.includes(card.id) && !held) {
        held = true;
        gate.enter();
        await gate.released;
      }
    });
    const pending = render().addInstance(card);
    let removedId: string | undefined;
    try {
      await gate.entered;
      await render().reloadWorld();
      const loaded = render().instances.find((instance) => instance.cardId === card.id);
      if (!loaded) throw new Error('persisted instance fixture missing');
      removedId = loaded.id;
      await render().removeInstance(loaded.id);
      expect(render().instances.some((instance) => instance.id === removedId)).toBe(false);
    } finally {
      gate.release();
      await pending;
      spy.mockRestore();
    }
    expect.soft(render().instances.some((instance) => instance.id === removedId)).toBe(false);
    expect.soft(render().world?.instanceIds.some((id) => id === removedId)).toBe(false);
    expect.soft(render().scene?.cast.some((id) => id === removedId)).toBe(false);
    expect.soft((await repository.listInstances(a.room.id)).some((instance) => instance.id === removedId)).toBe(false);
    expect.soft((await repository.getRoom(a.room.id))?.instanceIds.some((id) => id === removedId)).toBe(false);
  });

  it('keeps the latest committed conversation when a delayed rename rereads an older stored choice', async () => {
    const { repository, a, render } = await setup();
    const other = createConversation({ roomId: a.room.id, title: 'C2', kind: 'main' });
    await repository.saveConversation(other);
    await render().openWorld(a.room.id);
    const opening = barrier();
    const renaming = barrier();
    let heldOpen = false;
    let heldRename = false;
    const renamedTitle = '改名但保持 C2 选择';
    const spy = observeCommittedRooms(repository, async (room) => {
      if (room.title === renamedTitle && !heldRename) {
        heldRename = true;
        renaming.enter();
        await renaming.released;
      } else if (room.activeConversationId === other.id && !heldOpen) {
        heldOpen = true;
        opening.enter();
        await opening.released;
      }
    });
    const pendingOpen = render().openConversation(other.id);
    let pendingRename: Promise<void> | undefined;
    try {
      await opening.entered;
      expect(render().conversation?.id).toBe(a.conversation.id);
      pendingRename = render().renameWorld(renamedTitle);
      await renaming.entered;
      opening.release();
      await pendingOpen;
      expect(render().conversation?.id).toBe(other.id);
    } finally {
      opening.release();
      renaming.release();
      await Promise.all([pendingOpen, pendingRename]);
      spy.mockRestore();
    }
    expect.soft(render().conversation?.id).toBe(other.id);
    expect.soft(render().world?.title).toBe(renamedTitle);
    expect.soft(render().conversations.map((conversation) => conversation.id)).toContain(a.conversation.id);
    expect.soft(render().conversations.map((conversation) => conversation.id)).toContain(other.id);
    const stored = await repository.getRoom(a.room.id);
    expect.soft(stored?.title).toBe(renamedTitle);
    expect.soft(stored?.activeConversationId).toBe(other.id);
  });

  it('honors an explicit conversation target when an append advances revision before its delayed open completes', async () => {
    const { repository, a, render } = await setup();
    const other = createConversation({ roomId: a.room.id, title: 'C2', kind: 'main' });
    await repository.saveConversation(other);
    await render().openWorld(a.room.id);
    const opening = barrier();
    const renaming = barrier();
    let heldOpen = false;
    let heldRename = false;
    const renamedTitle = '显式选择 C2 遇追加';
    const spy = observeCommittedRooms(repository, async (room) => {
      if (room.title === renamedTitle && !heldRename) {
        heldRename = true;
        renaming.enter();
        await renaming.released;
      } else if (room.activeConversationId === other.id && !heldOpen) {
        heldOpen = true;
        opening.enter();
        await opening.released;
      }
    });
    const pendingOpen = render().openConversation(other.id);
    let pendingRename: Promise<void> | undefined;
    try {
      await opening.entered;
      pendingRename = render().renameWorld(renamedTitle);
      await renaming.entered;
      await render().appendMessages([messageFor(a, 'C1 期间追加')]);
      opening.release();
      await pendingOpen;
      expect.soft(render().conversation?.id).toBe(other.id);
    } finally {
      opening.release();
      renaming.release();
      await Promise.all([pendingOpen, pendingRename]);
      spy.mockRestore();
    }
    expect.soft(render().conversation?.id).toBe(other.id);
    expect.soft(render().world?.title).toBe(renamedTitle);
    expect
      .soft(
        render()
          .bundleOf(a.conversation.id)
          ?.messages.map((message) => message.content),
      )
      .toEqual(['C1 期间追加']);
    expect.soft(render().conversations.map((conversation) => conversation.id)).toContain(other.id);
    const stored = await repository.getRoom(a.room.id);
    expect.soft(stored?.title).toBe(renamedTitle);
    expect.soft(stored?.activeConversationId).toBe(other.id);
  });

  it('honors a newly created side target when an append advances revision before its delayed open completes', async () => {
    const { repository, a, render } = await setup();
    await render().openWorld(a.room.id);
    const opening = barrier();
    const renaming = barrier();
    let heldOpen = false;
    let heldRename = false;
    let sideId: string | undefined;
    const renamedTitle = '副对话选择遇追加';
    const spy = observeCommittedRooms(repository, async (room) => {
      if (room.title === renamedTitle && !heldRename) {
        heldRename = true;
        renaming.enter();
        await renaming.released;
      } else if (room.activeConversationId !== a.conversation.id && !heldOpen) {
        heldOpen = true;
        opening.enter();
        await opening.released;
      }
    });
    const pendingOpen = render().openSideConversation();
    let pendingRename: Promise<void> | undefined;
    try {
      await opening.entered;
      const side = (await repository.listConversations(a.room.id)).find((conversation) => conversation.kind === 'side');
      if (!side) throw new Error('persisted side conversation fixture missing');
      sideId = side.id;
      pendingRename = render().renameWorld(renamedTitle);
      await renaming.entered;
      await render().appendMessages([messageFor(a, 'C1 期间追加')]);
      opening.release();
      await pendingOpen;
      expect.soft(render().conversation?.id).toBe(sideId);
    } finally {
      opening.release();
      renaming.release();
      await Promise.all([pendingOpen, pendingRename]);
      spy.mockRestore();
    }
    expect.soft(render().conversation?.id).toBe(sideId);
    expect.soft(render().conversation?.kind).toBe('side');
    expect.soft(render().world?.title).toBe(renamedTitle);
    expect
      .soft(
        render()
          .bundleOf(a.conversation.id)
          ?.messages.map((message) => message.content),
      )
      .toEqual(['C1 期间追加']);
    expect.soft(render().conversations.some((conversation) => conversation.id === sideId)).toBe(true);
    const stored = await repository.getRoom(a.room.id);
    expect.soft(stored?.title).toBe(renamedTitle);
    expect.soft(stored?.activeConversationId).toBe(sideId);
  });

  it('honors a new main target when an append advances revision before its delayed creation completes', async () => {
    const { repository, a, render } = await setup();
    await render().openWorld(a.room.id);
    const opening = barrier();
    const renaming = barrier();
    const renamedTitle = '新主对话选择遇追加';
    let createdId: string | undefined;
    let heldRename = false;
    const writeSpy = observeCommittedRooms(repository, async (room) => {
      if (room.title === renamedTitle && !heldRename) {
        heldRename = true;
        renaming.enter();
        await renaming.released;
      } else if (!createdId && room.activeConversationId !== a.conversation.id) {
        createdId = room.activeConversationId ?? undefined;
        opening.enter();
        await opening.released;
      }
    });
    const pendingOpen = render().startConversation({ title: '新主对话', cards: [] });
    let pendingRename: Promise<void> | undefined;
    try {
      await opening.entered;
      if (!createdId) throw new Error('persisted main conversation fixture missing');
      pendingRename = render().renameWorld(renamedTitle);
      await renaming.entered;
      await render().appendMessages([messageFor(a, 'C1 期间追加')]);
      opening.release();
      await pendingOpen;
      expect.soft(render().conversation?.id).toBe(createdId);
    } finally {
      opening.release();
      renaming.release();
      await Promise.all([pendingOpen, pendingRename]);
      writeSpy.mockRestore();
    }
    expect.soft(render().conversation?.id).toBe(createdId);
    expect.soft(render().world?.title).toBe(renamedTitle);
    expect
      .soft(
        render()
          .bundleOf(a.conversation.id)
          ?.messages.map((message) => message.content),
      )
      .toEqual(['C1 期间追加']);
    expect.soft(render().conversations.some((conversation) => conversation.id === createdId)).toBe(true);
    const stored = await repository.getRoom(a.room.id);
    expect.soft(stored?.title).toBe(renamedTitle);
    expect.soft(stored?.activeConversationId).toBe(createdId);
  });

  it('keeps an appended message when a conversation refresh retries a superseded full read', async () => {
    const { repository, a, render } = await setup();
    await render().openWorld(a.room.id);
    const archive = render().startConversation({ title: '随后归档', cards: [] });
    const created = await archive;
    if (!created) throw new Error('conversation fixture missing');
    await render().openConversation(a.conversation.id);
    const gate = holdLoadedRoom(repository, a.room.id);
    const pending = render().archiveConversation(created.conversation.id);
    try {
      await gate.entered;
      await render().appendMessages([messageFor(a, 'm2')]);
    } finally {
      gate.release();
      await pending;
      gate.restore();
    }
    expect.soft(render().messages.map((item) => item.content)).toEqual(['m2']);
    expect.soft(render().archivedConversations.some((item) => item.id === created.conversation.id)).toBe(true);
  });

  it('keeps the committed conversation through a persona deletion full read of an older stored choice', async () => {
    const { repository, a, other, render } = await setupCommittedChoice();
    const persona = createPersona({ name: '待删除身份' });
    await repository.savePersona(persona);
    await render().listPersonas();
    expect(render().personas.some((item) => item.id === persona.id)).toBe(true);
    await render().deletePersona(persona.id);
    expect.soft(render().conversation?.id).toBe(other.id);
    expect.soft(render().personas.some((item) => item.id === persona.id)).toBe(false);
    expect.soft((await repository.listPersonas()).some((item) => item.id === persona.id)).toBe(false);
    expect
      .soft(render().conversations.map((item) => item.id))
      .toEqual(expect.arrayContaining([a.conversation.id, other.id]));
    expect.soft((await repository.getRoom(a.room.id))?.activeConversationId).toBe(a.conversation.id);
  });

  it('keeps the committed conversation when an append fallback message read is superseded', async () => {
    const { repository, a, other, render } = await setupCommittedChoice();
    const appending = barrier();
    const reading = barrier();
    const append = repository.appendMessages.bind(repository);
    const listMessages = repository.listMessages.bind(repository);
    const appendSpy = vi.spyOn(repository, 'appendMessages').mockImplementation(async (id, messages) => {
      const stamped = await append(id, messages);
      appending.enter();
      await appending.released;
      return stamped;
    });
    let heldRead = false;
    const readSpy = vi.spyOn(repository, 'listMessages').mockImplementation(async (id, options) => {
      const messages = await listMessages(id, options);
      if (!heldRead) {
        heldRead = true;
        reading.enter();
        await reading.released;
      }
      return messages;
    });
    const pending = render().appendMessages([messageFor(a, 'fallback m1')]);
    try {
      await appending.entered;
      await render().renameConversation(a.conversation.id, 'C1 第一次改名');
      appending.release();
      await reading.entered;
      await render().renameConversation(other.id, 'C2 第二次改名');
    } finally {
      appending.release();
      reading.release();
      await pending;
      appendSpy.mockRestore();
      readSpy.mockRestore();
    }
    expect.soft(render().conversation?.id).toBe(other.id);
    expect.soft(render().conversation?.title).toBe('C2 第二次改名');
    expect
      .soft(
        render()
          .bundleOf(a.conversation.id)
          ?.messages.map((item) => item.content),
      )
      .toEqual(['fallback m1']);
    expect.soft((await repository.listMessages(a.room.id)).map((item) => item.content)).toEqual(['fallback m1']);
    expect.soft((await repository.getRoom(a.room.id))?.activeConversationId).toBe(a.conversation.id);
  });

  it('honors an archived explicit target when its delayed open encounters a revision conflict', async () => {
    const { repository, a, render } = await setup();
    const archived = createConversation({ roomId: a.room.id, title: '归档回顾', kind: 'main' });
    await repository.saveConversation(archived);
    await repository.archiveConversation(archived.id);
    await render().openWorld(a.room.id);
    const gate = barrier();
    let held = false;
    const spy = observeCommittedRooms(repository, async (room) => {
      if (room.activeConversationId === archived.id && !held) {
        held = true;
        gate.enter();
        await gate.released;
      }
    });
    const pending = render().openConversation(archived.id);
    try {
      await gate.entered;
      await render().renameWorld('归档打开期间改名');
    } finally {
      gate.release();
      await pending;
      spy.mockRestore();
    }
    expect.soft(render().conversation?.id).toBe(archived.id);
    expect.soft(render().conversation?.archivedAt).toEqual(expect.any(String));
    expect.soft(render().world?.title).toBe('归档打开期间改名');
    expect.soft(render().conversations.map((item) => item.id)).toContain(a.conversation.id);
    expect.soft(render().archivedConversations.map((item) => item.id)).toContain(archived.id);
    expect.soft((await repository.getRoom(a.room.id))?.activeConversationId).toBe(archived.id);
  });

  it('keeps the current archived review when an ordinary mutation rereads after a revision conflict', async () => {
    const { repository, a, other, render } = await setupCommittedChoice(true);
    const gate = barrier();
    const saveRoom = repository.saveRoom.bind(repository);
    const spy = observeCommittedRooms(repository, async (_room) => {
      gate.enter();
      await gate.released;
    });
    const pending = render().renameWorld('归档回顾期间改名');
    try {
      await gate.entered;
      // An older captured room write may finish while the mutation is pending, as case 15 demonstrates.
      await saveRoom({ ...a.room, title: '归档回顾期间改名' });
      await render().renameConversation(a.conversation.id, 'C1 同时改名');
    } finally {
      gate.release();
      await pending;
      spy.mockRestore();
    }
    expect.soft(render().conversation?.id).toBe(other.id);
    expect.soft(render().conversation?.archivedAt).toEqual(expect.any(String));
    expect.soft(render().world?.title).toBe('归档回顾期间改名');
    expect.soft(render().conversations.find((item) => item.id === a.conversation.id)?.title).toBe('C1 同时改名');
    expect.soft((await repository.getRoom(a.room.id))?.activeConversationId).toBe(a.conversation.id);
  });

  it.each(['archive-other', 'archive-current', 'delete-other', 'delete-archived-other'] as const)(
    'uses the latest committed choice at the full read boundary for %s',
    async (operation) => {
      const { repository, a, other, render } = await setupCommittedChoice();
      const third = createConversation({ roomId: a.room.id, title: 'C3', kind: 'main' });
      await repository.saveConversation(third);
      if (operation === 'delete-archived-other') await repository.archiveConversation(third.id);
      const targetId = operation === 'archive-current' ? other.id : third.id;
      const gate = holdLoadedRoom(repository, a.room.id);
      const pending = operation.startsWith('archive')
        ? render().archiveConversation(targetId)
        : operation === 'delete-archived-other'
          ? render().deleteArchivedConversation(targetId)
          : render().deleteConversation(targetId);
      try {
        await gate.entered;
        await render().renameConversation(a.conversation.id, 'C1 在读取期间改名');
      } finally {
        gate.release();
        await pending;
        gate.restore();
      }
      const expectedId = operation === 'archive-current' ? a.conversation.id : other.id;
      expect.soft(render().conversation?.id).toBe(expectedId);
      expect
        .soft(render().conversations.find((item) => item.id === a.conversation.id)?.title)
        .toBe('C1 在读取期间改名');
      expect.soft(render().conversations.some((item) => item.id === a.conversation.id)).toBe(true);
      if (operation.startsWith('archive')) {
        expect.soft(render().archivedConversations.some((item) => item.id === targetId)).toBe(true);
        expect.soft((await repository.getConversation(targetId))?.archivedAt).toEqual(expect.any(String));
      } else {
        expect.soft(render().conversations.some((item) => item.id === targetId)).toBe(false);
        expect.soft(await repository.getConversation(targetId)).toBeNull();
      }
      expect.soft((await repository.getRoom(a.room.id))?.activeConversationId).toBe(a.conversation.id);
    },
  );

  it('excludes the newly archived conversation selected while its completion read is pending', async () => {
    const { repository, a, render } = await setup();
    const other = createConversation({ roomId: a.room.id, title: '待归档 C2', kind: 'main' });
    await repository.saveConversation(other);
    await render().openWorld(a.room.id);
    const opening = barrier();
    let heldOpen = false;
    const saveSpy = observeCommittedRooms(repository, async (room) => {
      if (room.activeConversationId === other.id && !heldOpen) {
        heldOpen = true;
        opening.enter();
        await opening.released;
      }
    });
    const pendingOpen = render().openConversation(other.id);
    let reading: ReturnType<typeof holdLoadedRoom> | undefined;
    let pendingArchive: ReturnType<SessionApi['archiveConversation']> | undefined;
    try {
      await opening.entered;
      expect(render().conversation?.id).toBe(a.conversation.id);
      reading = holdLoadedRoom(repository, a.room.id);
      pendingArchive = render().archiveConversation(other.id);
      await reading.entered;
      opening.release();
      await pendingOpen;
      expect(render().conversation?.id).toBe(other.id);
    } finally {
      opening.release();
      reading?.release();
      await Promise.all([pendingOpen, pendingArchive]);
      reading?.restore();
      saveSpy.mockRestore();
    }
    expect.soft(render().conversation?.id).toBe(a.conversation.id);
    expect.soft(render().archivedConversations.some((item) => item.id === other.id)).toBe(true);
    expect.soft((await repository.getRoom(a.room.id))?.activeConversationId).toBe(a.conversation.id);
    expect.soft((await repository.getConversation(other.id))?.archivedAt).toEqual(expect.any(String));
  });
});
