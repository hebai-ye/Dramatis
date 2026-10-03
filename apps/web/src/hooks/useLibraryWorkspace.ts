import type { ConversationId, RoomId } from '@dramatis/core';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { DramatisDb } from '../lib/db';
import { type LibraryViewActions, runLibraryNavigation, waitForLibraryNavigation } from '../lib/library-view';
import type { SessionApi } from '../lib/session';
import { NARROW_SCREEN_QUERY } from '../lib/viewport';
import type { useImport } from './useImport';

type NavigationSession = Pick<SessionApi, 'world' | 'conversation' | 'openWorld' | 'openConversation'>;
type SurfaceSession = Pick<
  SessionApi,
  | 'world'
  | 'personas'
  | 'library'
  | 'ready'
  | 'savePersona'
  | 'deletePersona'
  | 'saveCard'
  | 'deleteCard'
  | 'saveWorldBook'
  | 'deleteWorldBook'
  | 'attachWorldBook'
  | 'detachWorldBook'
>;

export function useLibraryNavigation(
  session: NavigationSession,
  db: DramatisDb | null,
  narrow: boolean,
  setCollapsed: (value: boolean) => void,
  setPanelOpen: (value: boolean) => void,
) {
  useEffect(() => {
    if (narrow) setPanelOpen(false);
  }, [narrow, setPanelOpen]);
  const libraryNavigation = useRef<LibraryViewActions | null>(null);
  const currentSession = useRef(session);
  useLayoutEffect(() => {
    currentSession.current = session;
  }, [session]);
  const controls = useRef({ setCollapsed, setPanelOpen });
  controls.current = { setCollapsed, setPanelOpen };
  const enterLibrary = useCallback(() => {
    if (narrow) {
      controls.current.setCollapsed(true);
      controls.current.setPanelOpen(false);
    }
  }, [narrow]);
  const returnFromLibrary = useCallback(() => controls.current.setCollapsed(false), []);
  const dismiss = useCallback(() => {
    libraryNavigation.current?.dismissForNavigation();
    if (window.matchMedia(NARROW_SCREEN_QUERY).matches) controls.current.setCollapsed(true);
  }, []);
  const navigate = useCallback(
    async (
      action: () => Promise<void>,
      committed: () => boolean,
      options: { exists?: () => Promise<boolean>; onCommitted?: () => void } = {},
    ) => {
      const run = () =>
        runLibraryNavigation({
          action,
          committed,
          ...options,
          leave: dismiss,
        });
      if (libraryNavigation.current) return libraryNavigation.current.requestAction(run);
      await run();
      return true;
    },
    [dismiss],
  );
  const openWorld = useCallback(
    (id: RoomId, onCommitted?: () => void) =>
      navigate(
        () => currentSession.current.openWorld(id),
        () => currentSession.current.world?.id === id,
        { exists: async () => db !== null && (await db.repository.getRoom(id)) !== null, onCommitted },
      ),
    [db, navigate],
  );
  const openConversation = useCallback(
    (id: ConversationId) =>
      navigate(
        () => currentSession.current.openConversation(id),
        () => currentSession.current.conversation?.id === id,
        {
          exists: async () => {
            const target = db === null ? null : await db.repository.getConversation(id);
            return target !== null && target.roomId === currentSession.current.world?.id;
          },
        },
      ),
    [db, navigate],
  );
  const navigateCreated = useCallback(
    (action: () => Promise<void>) => {
      let before: ConversationId | undefined;
      return navigate(
        async () => {
          before = currentSession.current.conversation?.id;
          await action();
        },
        () => currentSession.current.conversation !== null && currentSession.current.conversation?.id !== before,
      );
    },
    [navigate],
  );
  const navigateSide = useCallback(
    (action: () => Promise<void>) =>
      navigate(
        action,
        () => currentSession.current.world !== null && currentSession.current.conversation?.kind === 'side',
        {
          exists: async () => {
            const current = currentSession.current;
            if (current.world === null) return true;
            if (db === null || (await db.repository.getRoom(current.world.id)) === null) return false;
            return (
              current.conversation?.kind !== 'side' ||
              (await db.repository.getConversation(current.conversation.id)) !== null
            );
          },
        },
      ),
    [db, navigate],
  );
  const navigateImported = useCallback(
    async <T extends { ok: boolean; error?: string; message?: string } | null>(action: () => Promise<T>) => {
      let result: T | null = null;
      const run = async () => {
        const before = currentSession.current.world?.id;
        result = await action();
        if (result === null) return;
        if (!result.ok) throw new Error(result.error ?? result.message ?? '导入失败，请重试。');
        if (
          await waitForLibraryNavigation(
            () => currentSession.current.world !== null && currentSession.current.world.id !== before,
          )
        )
          dismiss();
      };
      if (libraryNavigation.current) await libraryNavigation.current.requestAction(run);
      else await run();
      return result;
    },
    [dismiss],
  );
  return {
    libraryNavigation,
    currentSession,
    enterLibrary,
    returnFromLibrary,
    navigate,
    openWorld,
    openConversation,
    navigateCreated,
    navigateSide,
    navigateImported,
  };
}

export function useLibrarySurface(
  session: SurfaceSession,
  disabled: boolean,
  handleImport: ReturnType<typeof useImport>['handleImport'],
) {
  const libraryCounts = useMemo(
    () => ({
      personas: session.personas.length,
      cards: session.library.cards.length,
      worldbooks: session.library.worldBooks.length,
    }),
    [session.personas.length, session.library.cards.length, session.library.worldBooks.length],
  );
  const world = session.world;
  const importToLibrary = useCallback((file: File) => handleImport(file, 'library'), [handleImport]);
  const librarySurface = useMemo(
    () => ({
      personas: session.personas,
      cards: session.library.cards,
      books: session.library.worldBooks,
      counts: libraryCounts,
      ready: session.ready,
      mutationDisabled: disabled,
      world: world === null ? null : { id: world.id, title: world.title, attachedIds: world.worldBookIds },
      onSavePersona: session.savePersona,
      onDeletePersona: session.deletePersona,
      onSaveCard: session.saveCard,
      onDeleteCard: session.deleteCard,
      onSaveBook: session.saveWorldBook,
      onDeleteBook: session.deleteWorldBook,
      onAttach: session.attachWorldBook,
      onDetach: session.detachWorldBook,
      onImport: importToLibrary,
    }),
    [
      session.personas,
      session.library.cards,
      session.library.worldBooks,
      libraryCounts,
      session.ready,
      disabled,
      world,
      session.savePersona,
      session.deletePersona,
      session.saveCard,
      session.deleteCard,
      session.saveWorldBook,
      session.deleteWorldBook,
      session.attachWorldBook,
      session.detachWorldBook,
      importToLibrary,
    ],
  );
  return { libraryCounts, librarySurface };
}
