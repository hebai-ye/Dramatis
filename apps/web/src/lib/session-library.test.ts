import {
  COLLECTIONS,
  createBackgroundRunner,
  createBlankWorldBook,
  createConversation,
  createMemoryEntityStore,
  createPersona,
  createPlayerMessage,
  createUsageLedger,
  newId,
  nowIso,
  Repository,
  type Room,
  roomId,
} from '@dramatis/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DramatisDb } from './db';
import { useSession } from './session';
import { createTaskQueueExtras } from './task-queue';

// A small hook host makes the asynchronous snapshot publications observable without a browser dependency.
const host = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  stateIndex: 0,
  refIndex: 0,
}));
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = host.stateIndex++;
    if (!(index in host.states)) host.states[index] = typeof initial === 'function' ? initial() : initial;
    return [
      host.states[index],
      (value: unknown) => {
        host.states[index] = typeof value === 'function' ? value(host.states[index]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = host.refIndex++;
    host.refs[index] ??= { current: initial };
    return host.refs[index];
  },
  useEffect: () => {},
  useCallback: (callback: unknown) => callback,
  useMemo: (callback: () => unknown) => callback(),
}));
beforeEach(() => {
  host.states = [];
  host.refs = [];
  host.stateIndex = 0;
  host.refIndex = 0;
});
async function setup() {
  const store = createMemoryEntityStore();
  const repository = new Repository(store);
  const db: DramatisDb = {
    backendKind: store.kind,
    store,
    repository,
    queue: createBackgroundRunner(store),
    ledger: createUsageLedger(store),
    tasks: createTaskQueueExtras(store),
  };
  const persona = createPersona({ name: 'Before' });
  const book = createBlankWorldBook('Book');
  const id = roomId(newId());
  const conversation = createConversation({
    roomId: id,
    title: 'Main',
    persona: { personaId: persona.id, name: persona.name, description: '' },
  });
  const room: Room = {
    id,
    title: 'World',
    personaId: persona.id,
    playerName: persona.name,
    playerPersona: '',
    cardIds: [],
    instanceIds: [],
    worldBookIds: [book.id],
    activeConversationId: conversation.id,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    deletedAt: null,
  };
  await repository.savePersona(persona);
  await repository.saveWorldBook(book);
  await repository.saveRoom(room);
  await repository.saveConversation(conversation);
  const render = () => {
    host.stateIndex = 0;
    host.refIndex = 0;
    return useSession(db);
  };
  const api = render();
  await api.openWorld(id);
  const lateMessage = createPlayerMessage({
    roomId: id,
    conversationId: conversation.id,
    sceneId: null,
    turnId: 'late',
    speakerName: 'Player',
    content: 'Arrived during save',
  });
  const lateReload = async () => {
    await repository.appendMessages(id, [lateMessage]);
    await api.reloadWorld();
  };
  return { api, render, repository, store, persona, book, room, conversation, lateMessage, lateReload };
}
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('library snapshot publications', () => {
  it.each(['savePersona', 'attachWorldBook', 'detachWorldBook', 'deleteWorldBook'] as const)(
    '%s preserves messages loaded during delayed save',
    async (operation) => {
      const h = await setup();
      const wait = gate();
      const started = gate();
      if (operation === 'savePersona') {
        const save = h.repository.saveConversation.bind(h.repository);
        vi.spyOn(h.repository, 'saveConversation').mockImplementation(async (item) => {
          started.release();
          await wait.promise;
          await save(item);
        });
      } else {
        const save = h.repository.saveRoom.bind(h.repository);
        vi.spyOn(h.repository, 'saveRoom').mockImplementation(async (item) => {
          started.release();
          await wait.promise;
          await save(item);
        });
      }
      const pending =
        operation === 'savePersona'
          ? h.api.savePersona({ ...h.persona, name: 'After' })
          : operation === 'attachWorldBook'
            ? h.api.attachWorldBook(createBlankWorldBook('Attached'))
            : h.api[operation](h.book.id);
      await started.promise;
      await h.lateReload();
      wait.release();
      await pending;
      expect(h.render().messages.map((message) => message.content)).toEqual(['Arrived during save']);
      if (operation === 'savePersona') expect(h.render().conversation?.playerName).toBe('After');
    },
  );
  it('deletePersona does not publish stale loaded messages after a refresh', async () => {
    const h = await setup();
    const wait = gate();
    const started = gate();
    const load = h.repository.loadRoom.bind(h.repository);
    let delay = true;
    vi.spyOn(h.repository, 'loadRoom').mockImplementation(async (id) => {
      const result = await load(id);
      if (delay) {
        delay = false;
        started.release();
        await wait.promise;
      }
      return result;
    });
    const pending = h.api.deletePersona(h.persona.id);
    await started.promise;
    await h.lateReload();
    wait.release();
    await pending;
    expect(h.render().messages.map((message) => message.content)).toEqual(['Arrived during save']);
    expect(h.render().world?.personaId).toBeNull();
  });
  it('does not restore a different world after navigation while an attachment saves', async () => {
    const h = await setup();
    const wait = gate();
    const started = gate();
    const save = h.repository.saveRoom.bind(h.repository);
    const other = { ...h.room, id: roomId(newId()), title: 'Other', activeConversationId: null, worldBookIds: [] };
    await save(other);
    vi.spyOn(h.repository, 'saveRoom').mockImplementation(async (item) => {
      started.release();
      await wait.promise;
      await save(item);
    });
    const pending = h.api.attachWorldBook(createBlankWorldBook('Attached'));
    await started.promise;
    await h.api.openWorld(other.id);
    wait.release();
    await pending;
    expect(h.render().world?.id).toBe(other.id);
    expect(h.render().worldBooks).toEqual([]);
  });
  it('soft deletes books from the library without an open world', async () => {
    const h = await setup();
    const snapshotRef = host.refs[0];
    if (!snapshotRef) throw new Error('snapshot ref missing');
    snapshotRef.current = null;
    host.states[5] = null;
    await h.api.deleteWorldBook(h.book.id);
    expect(await h.repository.listWorldBooks()).toEqual([]);
    expect((await h.store.get<{ deletedAt: string | null }>(COLLECTIONS.worldBooks, h.book.id))?.deletedAt).toEqual(
      expect.any(String),
    );
    expect((await h.repository.getRoom(h.room.id))?.worldBookIds).toEqual([h.book.id]);
  });
});
