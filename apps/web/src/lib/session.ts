import {
  type Card,
  META_KEYS,
  type Message,
  type RoomId,
  type RoomSnapshot,
  type RoomSummary,
  type Scene,
} from '@dramatis/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type DramatisDb, openDramatisDb } from './db';
import { createWorldFromCard } from './world';

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
  createRoom: (card: Card, playerName: string) => Promise<RoomSnapshot | null>;
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
    async (card: Card, playerName: string): Promise<RoomSnapshot | null> => {
      if (!db) return null;
      const world = createWorldFromCard(card, playerName);

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
    clearError: () => setError(null),
  };
}
