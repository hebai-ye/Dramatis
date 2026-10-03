import type { MutableRefObject, ReactNode } from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChatVisibilityContext } from '../lib/chat-visibility';
import { createLazyModule } from '../lib/lazy-module';
import {
  createLibraryNavigation,
  LIBRARY_SURFACE_ID,
  LIBRARY_VIEWS,
  LibraryContext,
  type LibraryNavigationState,
  type LibraryView,
  type LibraryViewActions,
  useLibraryView,
} from '../lib/library-view';
import { DialogShell } from './DialogShell';
import { LazyPanel } from './LazyPanel';
import type { LibrarySurfaceProps } from './LibrarySurface';
import surfaceModule from './LibrarySurface?lazy-module-url';

const loadSurface = createLazyModule(
  surfaceModule,
  (module: typeof import('./LibrarySurface')) => module.LibrarySurface,
);

export function LibraryWorkspaceProvider({
  children,
  navigationRef,
  onEnter,
  onReturn,
}: {
  children: ReactNode;
  navigationRef: MutableRefObject<LibraryViewActions | null>;
  onEnter: () => void;
  onReturn: () => void;
}) {
  const [state, setState] = useState<LibraryNavigationState>({
    activeView: null,
    busy: false,
    notice: null,
    pendingMessage: null,
    returnFocus: false,
  });
  const [controller] = useState(() => createLibraryNavigation(setState));
  const lastView = useRef<LibraryView>('personas');
  const callbacks = useRef({ onEnter, onReturn });
  callbacks.current = { onEnter, onReturn };
  const actions = useMemo<LibraryViewActions>(
    () => ({
      activeView: state.activeView,
      busy: state.busy,
      registerEditor: controller.registerEditor,
      requestAction: controller.requestAction,
      close: controller.close,
      dismissForNavigation: controller.dismissForNavigation,
      toggle: controller.toggle,
    }),
    [controller, state.activeView, state.busy],
  );
  navigationRef.current = actions;
  const previous = useRef<LibraryView | null>(null);
  useLayoutEffect(() => {
    let returnFrame: number | null = null;
    if (state.activeView !== null && previous.current !== state.activeView) {
      lastView.current = state.activeView;
      callbacks.current.onEnter();
    }
    if (previous.current !== null && state.activeView === null && state.returnFocus) {
      callbacks.current.onReturn();
      const returnView = lastView.current;
      returnFrame = requestAnimationFrame(() => {
        if (controller.state().activeView !== null) return;
        document.querySelector<HTMLElement>(`[data-library-trigger="${returnView}"]`)?.focus({ preventScroll: true });
      });
    }
    previous.current = state.activeView;
    return () => {
      if (returnFrame !== null) cancelAnimationFrame(returnFrame);
    };
  }, [controller, state.activeView, state.returnFocus]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        controller.state().activeView === null
      )
        return;
      if (document.querySelector('[role="dialog"], [aria-modal="true"], .dialog-backdrop, .crop-overlay') !== null)
        return;
      event.preventDefault();
      if (controller.state().pendingMessage !== null) controller.cancel();
      else void controller.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controller]);
  const confirmReturn = useRef<HTMLElement | null>(null);
  if (state.pendingMessage !== null && confirmReturn.current === null && typeof document !== 'undefined')
    confirmReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (state.pendingMessage === null) confirmReturn.current = null;
  return (
    <LibraryContext.Provider value={actions}>
      {children}
      {state.notice !== null ? (
        <div className="library-navigation-notice notice error" role="alert">
          {state.notice}
        </div>
      ) : null}
      {state.pendingMessage !== null ? (
        <DialogShell
          label="尚有未确认的更改"
          className="library-leave-dialog"
          returnFocus={confirmReturn.current}
          onClose={controller.cancel}
        >
          <p>{state.pendingMessage}</p>
          <div className="inline">
            <button type="button" onClick={controller.cancel}>
              继续编辑
            </button>
            <button type="button" className="ghost danger" onClick={() => void controller.confirmDiscard()}>
              放弃更改并继续
            </button>
          </div>
        </DialogShell>
      ) : null}
    </LibraryContext.Provider>
  );
}

/** Overlay retains the original grid children and chat nodes at their existing positions. */
export function LibraryWorkspace({
  children,
  surfaceProps,
  hasConversation,
}: {
  children: ReactNode;
  surfaceProps: LibrarySurfaceProps;
  hasConversation: boolean;
}) {
  const library = useLibraryView();
  const active = library.activeView;
  const lastView = useRef<LibraryView>('personas');
  const visited = useRef(false);
  if (active !== null) {
    visited.current = true;
    lastView.current = active;
  }
  const workspaceRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const meta = LIBRARY_VIEWS.find((view) => view.id === (active ?? lastView.current));
  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace || active === null) return;
    const originals = new Map<HTMLElement, { inert: string | null; aria: string | null }>();
    const isolate = () => {
      for (const child of Array.from(workspace.children)) {
        if (!(child instanceof HTMLElement) || child.id === LIBRARY_SURFACE_ID) continue;
        if (!originals.has(child))
          originals.set(child, { inert: child.getAttribute('inert'), aria: child.getAttribute('aria-hidden') });
        child.setAttribute('inert', '');
        child.setAttribute('aria-hidden', 'true');
      }
    };
    isolate();
    const observer = new MutationObserver(isolate);
    observer.observe(workspace, { childList: true });
    titleRef.current?.focus({ preventScroll: true });
    return () => {
      observer.disconnect();
      for (const [node, original] of originals) {
        if (original.inert === null) node.removeAttribute('inert');
        else node.setAttribute('inert', original.inert);
        if (original.aria === null) node.removeAttribute('aria-hidden');
        else node.setAttribute('aria-hidden', original.aria);
      }
    };
  }, [active]);
  return (
    <div ref={workspaceRef} className={active === null ? 'workspace' : 'workspace library-open'}>
      <ChatVisibilityContext.Provider value={active === null}>{children}</ChatVisibilityContext.Provider>
      {visited.current ? (
        <section
          id={LIBRARY_SURFACE_ID}
          className={active === null ? 'library-overlay library-closed' : 'library-overlay'}
          aria-labelledby="library-title"
        >
          <header className="library-head">
            <div>
              <h1 id="library-title" ref={titleRef} tabIndex={-1}>
                {meta?.label} <span className="library-count">{surfaceProps.counts[active ?? lastView.current]}</span>
              </h1>
              <p className="hint">{meta?.hint}</p>
            </div>
            <button type="button" className="ghost" disabled={library.busy} onClick={() => void library.close()}>
              {hasConversation ? '返回对话' : '关闭素材库'}
            </button>
          </header>
          {!surfaceProps.ready ? (
            <p className="hint" role="status">
              正在读取素材库…
            </p>
          ) : (
            <LazyPanel load={loadSurface} label="素材库" panelProps={surfaceProps} />
          )}
        </section>
      ) : null}
    </div>
  );
}
