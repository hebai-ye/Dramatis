import {
  type Card,
  type CharacterInstance,
  type EventId,
  type InstanceId,
  META_KEYS,
  type MemoryEvent,
  type Message,
  type MessageId,
  nowIso,
  type Persona,
  type Presence,
  type RoomId,
  type RoomSnapshot,
  type RoomSummary,
  type Scene,
  type WorldBook,
  type WorldBookId,
} from '@dramatis/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type DramatisDb, openDramatisDb } from './db';
import { createInstanceFor, createSceneFor, createWorldFromCard } from './world';

export interface BootReport {
  backendKind: string;
  degraded: boolean;
  recoveredTasks: number;
  migrationsApplied: number;
}

/**
 * 打开数据库（ROADMAP P0-1 / P0-2）。
 *
 * IndexedDB 在隐私模式或部分企业策略下不可用。这种情况下退回内存实现，
 * 让应用还能用，但必须把「本次数据不会保存」明确告诉用户，
 * 而不是静默地让他以为一切正常。
 */
export function useDatabase(): {
  db: DramatisDb | null;
  boot: BootReport | null;
  error: string | null;
} {
  const [db, setDb] = useState<DramatisDb | null>(null);
  const [boot, setBoot] = useState<BootReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const opened = await openDramatisDb();
        if (cancelled) return;

        const migration = await opened.repository.migrate();
        const recoveredTasks = await opened.queue.recoverInterrupted();

        setDb(opened);
        setBoot({
          backendKind: opened.backendKind,
          degraded: opened.backendKind === 'memory',
          recoveredTasks,
          migrationsApplied: migration.applied.length,
        });
      } catch (openError) {
        if (!cancelled) {
          setError(openError instanceof Error ? openError.message : String(openError));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { db, boot, error };
}

export interface SessionApi {
  ready: boolean;
  error: string | null;
  rooms: RoomSummary[];
  snapshot: RoomSnapshot | null;
  activeScene: Scene | null;
  openRoom: (id: RoomId) => Promise<void>;
  /** 返回新建房间的快照，便于调用方接着写入开场白。 */
  createRoom: (card: Card, persona: Persona) => Promise<RoomSnapshot | null>;
  /** 把手里的角色卡加入当前房间，成为新的角色实例（P0-3）。 */
  addInstance: (card: Card) => Promise<CharacterInstance | null>;
  removeInstance: (id: InstanceId) => Promise<void>;
  updateInstance: (id: InstanceId, patch: Partial<CharacterInstance>) => Promise<void>;
  /** 切换在场状态，并同步场景名单（P0-6）。 */
  setPresence: (id: InstanceId, presence: Presence) => Promise<void>;
  /** 结束当前场景并开一个新的（P0-6）。 */
  startNewScene: (title: string) => Promise<void>;
  deleteMessage: (id: MessageId) => Promise<void>;
  updateMessage: (id: MessageId, patch: Partial<Message>) => Promise<void>;
  /** 重新从存储载入当前房间；后台任务写入记忆后调用。 */
  reloadRoom: () => Promise<void>;
  updateMemory: (id: EventId, patch: Partial<MemoryEvent>) => Promise<void>;
  deleteMemory: (id: EventId) => Promise<void>;
  markRecalled: (events: readonly MemoryEvent[], now: string) => Promise<void>;
  /** 撤销某个回合的记忆写入，重抽与删除消息时使用（P0-7 的回滚）。 */
  deleteMemoriesByTurn: (turnId: string) => Promise<void>;
  /** 把一本世界书挂到当前房间。core 早就实现了匹配，这里补上入口。 */
  attachWorldBook: (book: WorldBook) => Promise<void>;
  /** 只解绑，不删库——世界书可能被别的房间共用。 */
  detachWorldBook: (id: WorldBookId) => Promise<void>;
  /**
   * 切换这个房间使用的玩家身份（P0-3）。
   *
   * 刻意不叫 `usePersona`：以 `use` 开头的名字会被 lint 当成 React Hook，
   * 于是每次在事件回调里调用都会报「Hook 不能在非顶层调用」。
   */
  setPersona: (persona: Persona) => Promise<void>;
  savePersona: (persona: Persona) => Promise<void>;
  listPersonas: () => Promise<Persona[]>;
  deleteRoom: (id: RoomId) => Promise<void>;
  appendMessages: (messages: readonly Message[]) => Promise<void>;
  updateScene: (patch: Partial<Scene>) => Promise<void>;
  renameRoom: (title: string) => Promise<void>;
  clearError: () => void;
}

export function useSession(db: DramatisDb | null): SessionApi {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [snapshot, setSnapshotState] = useState<RoomSnapshot | null>(null);

  // 用一个 ref 跟随快照，避免每个回调都依赖 snapshot 而频繁重建
  const snapshotRef = useRef<RoomSnapshot | null>(null);
  const setSnapshot = useCallback((next: RoomSnapshot | null) => {
    snapshotRef.current = next;
    setSnapshotState(next);
  }, []);

  const refreshRooms = useCallback(async () => {
    if (!db) return;
    setRooms(await db.repository.listRooms());
  }, [db]);

  useEffect(() => {
    if (!db) return;
    let cancelled = false;

    void (async () => {
      try {
        const lastRoomId = await db.repository.getMeta<RoomId>(META_KEYS.lastRoomId);
        if (lastRoomId !== null) {
          const loaded = await db.repository.loadRoom(lastRoomId);
          if (loaded && !cancelled) setSnapshot(loaded);
        }
        await refreshRooms();
      } catch (sessionError) {
        if (!cancelled) {
          setError(sessionError instanceof Error ? sessionError.message : String(sessionError));
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [db, refreshRooms, setSnapshot]);

  const openRoom = useCallback(
    async (id: RoomId) => {
      if (!db) return;
      const loaded = await db.repository.loadRoom(id);
      if (!loaded) {
        setError('这个房间已经不存在了');
        return;
      }
      setSnapshot(loaded);
      await db.repository.setMeta(META_KEYS.lastRoomId, id);
      await refreshRooms();
    },
    [db, refreshRooms, setSnapshot],
  );

  const createRoom = useCallback(
    async (card: Card, persona: Persona): Promise<RoomSnapshot | null> => {
      if (!db) return null;
      const world = createWorldFromCard(card, persona);

      await db.repository.saveSnapshot({
        room: world.room,
        scenes: [world.scene],
        instances: [world.instance],
        cards: [card],
      });
      await db.repository.setMeta(META_KEYS.lastRoomId, world.room.id);

      const loaded = await db.repository.loadRoom(world.room.id);
      setSnapshot(loaded);
      await refreshRooms();
      return loaded;
    },
    [db, refreshRooms, setSnapshot],
  );

  const deleteRoom = useCallback(
    async (id: RoomId) => {
      if (!db) return;
      await db.repository.deleteRoom(id);

      const current = snapshotRef.current;
      if (current?.room.id === id) {
        setSnapshot(null);
        await db.repository.setMeta(META_KEYS.lastRoomId, null);
      }
      await refreshRooms();
    },
    [db, refreshRooms, setSnapshot],
  );

  const appendMessages = useCallback(
    async (messages: readonly Message[]) => {
      const current = snapshotRef.current;
      if (!db || !current || messages.length === 0) return;

      const stamped = await db.repository.appendMessages(current.room.id, messages);
      setSnapshot({ ...current, messages: [...current.messages, ...stamped] });
      await refreshRooms();
    },
    [db, refreshRooms, setSnapshot],
  );

  const updateScene = useCallback(
    async (patch: Partial<Scene>) => {
      const current = snapshotRef.current;
      if (!db || !current) return;

      const scene = current.scenes.find((item) => item.id === current.room.activeSceneId);
      if (!scene) return;

      const next: Scene = { ...scene, ...patch };
      await db.repository.saveScene(next);
      setSnapshot({
        ...current,
        scenes: current.scenes.map((item) => (item.id === next.id ? next : item)),
      });
    },
    [db, setSnapshot],
  );

  const renameRoom = useCallback(
    async (title: string) => {
      const current = snapshotRef.current;
      if (!db || !current) return;

      const room = { ...current.room, title };
      await db.repository.saveRoom(room);
      setSnapshot({ ...current, room });
      await refreshRooms();
    },
    [db, refreshRooms, setSnapshot],
  );

  const addInstance = useCallback(
    async (card: Card): Promise<CharacterInstance | null> => {
      const current = snapshotRef.current;
      if (!db || !current) return null;

      const instance = createInstanceFor(card, current.room.id);
      const room = {
        ...current.room,
        cardIds: current.room.cardIds.includes(card.id) ? current.room.cardIds : [...current.room.cardIds, card.id],
        instanceIds: [...current.room.instanceIds, instance.id],
        updatedAt: nowIso(),
      };

      const active = current.scenes.find((scene) => scene.id === room.activeSceneId);
      let scenes = current.scenes;
      if (active) {
        const nextScene: Scene = { ...active, cast: [...active.cast, instance.id] };
        await db.repository.saveScene(nextScene);
        scenes = current.scenes.map((scene) => (scene.id === nextScene.id ? nextScene : scene));
      }

      await db.repository.saveCard(card);
      await db.repository.saveInstance(instance);
      await db.repository.saveRoom(room);

      setSnapshot({
        ...current,
        room,
        scenes,
        instances: [...current.instances, instance],
        cards: current.cards.some((item) => item.id === card.id) ? current.cards : [...current.cards, card],
      });
      await refreshRooms();
      return instance;
    },
    [db, refreshRooms, setSnapshot],
  );

  const removeInstance = useCallback(
    async (id: InstanceId) => {
      const current = snapshotRef.current;
      if (!db || !current) return;

      const room = { ...current.room, instanceIds: current.room.instanceIds.filter((item) => item !== id) };
      let scenes = current.scenes;

      // 从所有场景的名单里摘掉，而不只是当前场景：
      // 否则回到旧场景时会出现指向已删除角色的悬空引用
      for (const scene of current.scenes) {
        if (!scene.cast.includes(id)) continue;
        const nextScene: Scene = { ...scene, cast: scene.cast.filter((item) => item !== id) };
        await db.repository.saveScene(nextScene);
        scenes = scenes.map((item) => (item.id === nextScene.id ? nextScene : item));
      }

      await db.repository.saveRoom(room);
      await db.repository.deleteInstance(id);

      setSnapshot({
        ...current,
        room,
        scenes,
        instances: current.instances.filter((item) => item.id !== id),
      });
      await refreshRooms();
    },
    [db, refreshRooms, setSnapshot],
  );

  const updateInstance = useCallback(
    async (id: InstanceId, patch: Partial<CharacterInstance>) => {
      const current = snapshotRef.current;
      if (!db || !current) return;
      const instance = current.instances.find((item) => item.id === id);
      if (!instance) return;

      const next: CharacterInstance = { ...instance, ...patch, updatedAt: nowIso() };
      await db.repository.saveInstance(next);
      setSnapshot({
        ...current,
        instances: current.instances.map((item) => (item.id === id ? next : item)),
      });
    },
    [db, setSnapshot],
  );

  const setPresence = useCallback(
    async (id: InstanceId, presence: Presence) => {
      const current = snapshotRef.current;
      if (!db || !current) return;
      const instance = current.instances.find((item) => item.id === id);
      if (!instance) return;

      const next: CharacterInstance = { ...instance, presence, updatedAt: nowIso() };
      await db.repository.saveInstance(next);

      const active = current.scenes.find((scene) => scene.id === current.room.activeSceneId);
      let scenes = current.scenes;

      if (active) {
        const shouldBeInCast = presence === 'onstage' || presence === 'muted';
        if (shouldBeInCast !== active.cast.includes(id)) {
          const nextScene: Scene = {
            ...active,
            cast: shouldBeInCast ? [...active.cast, id] : active.cast.filter((item) => item !== id),
          };
          await db.repository.saveScene(nextScene);
          scenes = scenes.map((scene) => (scene.id === nextScene.id ? nextScene : scene));
        }
      }

      setSnapshot({
        ...current,
        scenes,
        instances: current.instances.map((item) => (item.id === id ? next : item)),
      });
    },
    [db, setSnapshot],
  );

  const startNewScene = useCallback(
    async (title: string) => {
      const current = snapshotRef.current;
      if (!db || !current) return;

      const active = current.scenes.find((scene) => scene.id === current.room.activeSceneId);
      const cast = (active?.cast ?? current.room.instanceIds).filter((id) =>
        current.instances.some(
          (instance) => instance.id === id && (instance.presence === 'onstage' || instance.presence === 'muted'),
        ),
      );

      const now = nowIso();
      const nextScene = createSceneFor(current.room.id, cast, { title });
      const closedScene: Scene | null = active ? { ...active, endedAt: now } : null;
      const room = { ...current.room, activeSceneId: nextScene.id, updatedAt: now };

      if (closedScene) await db.repository.saveScene(closedScene);
      await db.repository.saveScene(nextScene);
      await db.repository.saveRoom(room);

      setSnapshot({
        ...current,
        room,
        scenes: [
          ...current.scenes.map((scene) => (closedScene && scene.id === closedScene.id ? closedScene : scene)),
          nextScene,
        ],
      });
    },
    [db, setSnapshot],
  );

  const deleteMessage = useCallback(
    async (id: MessageId) => {
      const current = snapshotRef.current;
      if (!db || !current) return;
      await db.repository.deleteMessage(id);
      setSnapshot({ ...current, messages: current.messages.filter((message) => message.id !== id) });
      await refreshRooms();
    },
    [db, refreshRooms, setSnapshot],
  );

  const updateMessage = useCallback(
    async (id: MessageId, patch: Partial<Message>) => {
      const current = snapshotRef.current;
      if (!db || !current) return;
      const updated = await db.repository.updateMessage(id, patch);
      if (!updated) return;
      setSnapshot({
        ...current,
        messages: current.messages.map((message) => (message.id === id ? updated : message)),
      });
    },
    [db, setSnapshot],
  );

  const setPersona = useCallback(
    async (persona: Persona) => {
      const current = snapshotRef.current;
      if (!db || !current) return;
      const room = {
        ...current.room,
        personaId: persona.id,
        playerName: persona.name,
        playerPersona: persona.description,
        updatedAt: nowIso(),
      };
      await db.repository.saveRoom(room);
      setSnapshot({ ...current, room });
    },
    [db, setSnapshot],
  );

  const savePersona = useCallback(
    async (persona: Persona) => {
      const current = snapshotRef.current;
      if (!db) return;
      await db.repository.savePersona(persona);
      if (!current) return;

      const personas = current.personas.some((item) => item.id === persona.id)
        ? current.personas.map((item) => (item.id === persona.id ? persona : item))
        : [...current.personas, persona];

      // 改了当前 persona 的名字或设定，房间上的冗余副本也要跟着走
      const room =
        current.room.personaId === persona.id
          ? { ...current.room, playerName: persona.name, playerPersona: persona.description }
          : current.room;

      setSnapshot({ ...current, personas, room });
    },
    [db, setSnapshot],
  );

  const listPersonas = useCallback(async (): Promise<Persona[]> => {
    return db ? db.repository.listPersonas() : [];
  }, [db]);

  const deleteMemoriesByTurn = useCallback(
    async (turnId: string) => {
      const current = snapshotRef.current;
      if (!db || !current) return;
      await db.repository.deleteMemoriesByTurn(current.room.id, turnId);
      setSnapshot({
        ...current,
        memories: current.memories.filter((memory) => !memory.sourceTurnIds.includes(turnId)),
      });
    },
    [db, setSnapshot],
  );

  const attachWorldBook = useCallback(
    async (book: WorldBook) => {
      const current = snapshotRef.current;
      if (!db || !current) return;

      await db.repository.saveWorldBook(book);
      if (current.room.worldBookIds.includes(book.id)) return;

      const room = {
        ...current.room,
        worldBookIds: [...current.room.worldBookIds, book.id],
        updatedAt: nowIso(),
      };
      await db.repository.saveRoom(room);
      setSnapshot({ ...current, room, worldBooks: [...current.worldBooks, book] });
    },
    [db, setSnapshot],
  );

  const detachWorldBook = useCallback(
    async (id: WorldBookId) => {
      const current = snapshotRef.current;
      if (!db || !current) return;

      const room = {
        ...current.room,
        worldBookIds: current.room.worldBookIds.filter((item) => item !== id),
        updatedAt: nowIso(),
      };
      await db.repository.saveRoom(room);
      setSnapshot({ ...current, room, worldBooks: current.worldBooks.filter((book) => book.id !== id) });
    },
    [db, setSnapshot],
  );

  const reloadRoom = useCallback(async () => {
    const current = snapshotRef.current;
    if (!db || !current) return;
    const loaded = await db.repository.loadRoom(current.room.id);
    if (loaded) setSnapshot(loaded);
  }, [db, setSnapshot]);

  const updateMemory = useCallback(
    async (id: EventId, patch: Partial<MemoryEvent>) => {
      const current = snapshotRef.current;
      if (!db || !current) return;
      const updated = await db.repository.updateMemory(id, patch);
      if (!updated) return;
      setSnapshot({
        ...current,
        memories: current.memories.map((memory) => (memory.id === id ? updated : memory)),
      });
    },
    [db, setSnapshot],
  );

  const deleteMemory = useCallback(
    async (id: EventId) => {
      const current = snapshotRef.current;
      if (!db || !current) return;
      await db.repository.deleteMemory(id);
      setSnapshot({ ...current, memories: current.memories.filter((memory) => memory.id !== id) });
    },
    [db, setSnapshot],
  );

  const markRecalled = useCallback(
    async (events: readonly MemoryEvent[], now: string) => {
      const current = snapshotRef.current;
      if (!db || !current || events.length === 0) return;

      const touched = events.map((event) => ({
        ...event,
        lastRecalledAt: now,
        recallCount: event.recallCount + 1,
      }));
      await db.repository.saveMemories(touched);
      setSnapshot({
        ...current,
        memories: current.memories.map((memory) => touched.find((item) => item.id === memory.id) ?? memory),
      });
    },
    [db, setSnapshot],
  );

  const activeScene =
    snapshot === null ? null : (snapshot.scenes.find((scene) => scene.id === snapshot.room.activeSceneId) ?? null);

  return {
    ready,
    error,
    rooms,
    snapshot,
    activeScene,
    openRoom,
    createRoom,
    deleteRoom,
    appendMessages,
    updateScene,
    renameRoom,
    addInstance,
    removeInstance,
    updateInstance,
    setPresence,
    startNewScene,
    deleteMessage,
    updateMessage,
    reloadRoom,
    updateMemory,
    deleteMemory,
    markRecalled,
    deleteMemoriesByTurn,
    attachWorldBook,
    detachWorldBook,
    setPersona,
    savePersona,
    listPersonas,
    clearError: () => setError(null),
  };
}
