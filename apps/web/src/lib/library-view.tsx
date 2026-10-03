import { createContext, useContext } from 'react';

export type LibraryView = 'personas' | 'worldbooks' | 'cards';

export const LIBRARY_VIEWS: ReadonlyArray<{ id: LibraryView; label: string; hint: string }> = [
  { id: 'personas', label: '我的身份', hint: '浏览与管理全部玩家身份' },
  { id: 'worldbooks', label: '世界书', hint: '浏览全部世界书，明确本世界的挂载状态' },
  { id: 'cards', label: '角色卡', hint: '浏览与管理全部角色模板' },
];
export const LIBRARY_SURFACE_ID = 'library-surface';

export interface LibraryLeaveHandle {
  flush: () => Promise<void>;
  pending: () => string | null;
  discard: () => void;
}

export interface LibraryNavigationState {
  activeView: LibraryView | null;
  busy: boolean;
  notice: string | null;
  pendingMessage: string | null;
  returnFocus: boolean;
}

type Action = () => void | Promise<void>;

export interface LibraryActions {
  registerEditor: (view: LibraryView, handle: LibraryLeaveHandle) => () => void;
  requestAction: (action: Action) => Promise<boolean>;
}

const defaults: LibraryActions = {
  registerEditor: () => () => {},
  requestAction: async (action) => {
    await action();
    return true;
  },
};

export interface LibraryViewActions extends LibraryActions {
  activeView: LibraryView | null;
  busy: boolean;
  toggle: (view: LibraryView) => Promise<boolean>;
  close: () => Promise<boolean>;
  dismissForNavigation: () => void;
}
export const LibraryContext = createContext<LibraryViewActions>({
  ...defaults,
  activeView: null,
  busy: false,
  toggle: async () => false,
  close: async () => false,
  dismissForNavigation: () => {},
});
export const useLibraryView = (): LibraryViewActions => useContext(LibraryContext);
export const useLibraryActions = (): LibraryActions => useContext(LibraryContext);

export function createLibraryNavigation(onState: (state: LibraryNavigationState) => void = () => {}) {
  let current: LibraryNavigationState = {
    activeView: null,
    busy: false,
    notice: null,
    pendingMessage: null,
    returnFocus: false,
  };
  const editors = new Map<LibraryView, LibraryLeaveHandle>();
  let pendingAction: Action | null = null;
  const publish = (patch: Partial<LibraryNavigationState>): void => {
    current = { ...current, ...patch };
    onState(current);
  };
  const run = async (action: Action): Promise<boolean> => {
    publish({ busy: true, notice: null, pendingMessage: null });
    try {
      // Inactive, previously visited editors can still own an in-flight write.
      for (const handle of editors.values()) await handle.flush();
      await action();
      publish({ busy: false });
      return true;
    } catch (error) {
      publish({ busy: false, notice: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };
  const requestAction = async (action: Action): Promise<boolean> => {
    if (current.busy || pendingAction !== null) return false;
    for (const handle of editors.values()) {
      const message = handle.pending();
      if (message !== null) {
        pendingAction = action;
        publish({ pendingMessage: message, notice: null });
        return false;
      }
    }
    return run(action);
  };
  return {
    state: () => current,
    registerEditor: (view: LibraryView, handle: LibraryLeaveHandle): (() => void) => {
      editors.set(view, handle);
      return () => {
        if (editors.get(view) === handle) editors.delete(view);
      };
    },
    requestAction,
    toggle: (view: LibraryView) =>
      requestAction(() => {
        const closing = current.activeView === view;
        publish({ activeView: closing ? null : view, returnFocus: closing });
      }),
    close: () =>
      requestAction(() => {
        publish({ activeView: null, returnFocus: true });
      }),
    cancel: (): void => {
      pendingAction = null;
      publish({ pendingMessage: null, notice: null });
    },
    confirmDiscard: async (): Promise<boolean> => {
      if (pendingAction === null || current.busy) return false;
      const action = pendingAction;
      pendingAction = null;
      for (const handle of editors.values()) if (handle.pending() !== null) handle.discard();
      return run(action);
    },
    dismissForNavigation: (): void => {
      pendingAction = null;
      publish({ activeView: null, pendingMessage: null, notice: null, returnFocus: false });
    },
  };
}

/** Resolve only after the UI has actually committed the requested world/conversation. */
export async function waitForLibraryNavigation(
  committed: () => boolean,
  nextCommit: () => Promise<void> = () => new Promise((resolve) => requestAnimationFrame(() => resolve())),
): Promise<boolean> {
  if (committed()) return true;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await nextCommit();
    if (committed()) return true;
  }
  return false;
}

/** Keep validation, the committed follow-up, and dismissal inside one deferred intent. */
export async function runLibraryNavigation(options: {
  action: () => Promise<void>;
  committed: () => boolean;
  exists?: () => Promise<boolean>;
  onCommitted?: () => void;
  leave: () => void;
}): Promise<void> {
  const failed = () => new Error('未能打开目标世界或对话，请确认它仍然存在后重试。');
  if (options.exists && !(await options.exists())) throw failed();
  await options.action();
  if (options.exists && !(await options.exists())) throw failed();
  if (!(await waitForLibraryNavigation(options.committed))) throw failed();
  options.onCommitted?.();
  options.leave();
}
