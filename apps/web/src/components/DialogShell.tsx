import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { createDialogController, type DialogGuard, type DialogState } from '../lib/dialog-controller';

interface DialogActions {
  requestAction: (action: () => void) => void;
  setGuard: (guard: DialogGuard | null) => void;
}

const DialogContext = createContext<DialogActions>({ requestAction: (action) => action(), setGuard: () => {} });
export const useDialogActions = (): DialogActions => useContext(DialogContext);
export type { DialogGuard };

interface Props {
  label: string;
  className?: string;
  onClose: () => void;
  returnFocus: HTMLElement | null;
  children: ReactNode;
}

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
function available(element: HTMLElement): boolean {
  return element.isConnected && element.getClientRects().length > 0 && element.closest('[inert]') === null;
}

function visibleInViewport(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return (
    available(element) &&
    rect.right > 0 &&
    rect.left < window.innerWidth &&
    rect.bottom > 0 &&
    rect.top < window.innerHeight
  );
}

/** 两个大弹窗共用外壳；业务内容加载和确认都保留在同一焦点范围内。 */
export function DialogShell({ label, className = '', onClose, returnFocus, children }: Props) {
  const [state, setState] = useState<DialogState>({ guard: null, pending: null, notice: null });
  const controllerRef = useRef<ReturnType<typeof createDialogController> | null>(null);
  if (controllerRef.current === null) controllerRef.current = createDialogController(setState);
  const controller = controllerRef.current;
  const actions = useMemo(() => ({ requestAction: controller.request, setGuard: controller.setGuard }), [controller]);
  const backdropRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const confirmId = useId();
  const descriptionId = useId();

  useLayoutEffect(() => {
    const backdrop = backdropRef.current;
    if (backdrop === null) return;
    const originals = new Map<HTMLElement, string | null>();
    const isolate = (): void => {
      for (const sibling of Array.from(document.body.children)) {
        if (!(sibling instanceof HTMLElement) || sibling === backdrop || sibling.contains(backdrop)) continue;
        if (!originals.has(sibling)) originals.set(sibling, sibling.getAttribute('inert'));
        sibling.setAttribute('inert', '');
      }
    };
    isolate();
    const observer = new MutationObserver(isolate);
    observer.observe(document.body, { childList: true });
    closeRef.current?.focus();
    const keepFocus = (event: FocusEvent): void => {
      if (event.target instanceof Node && !sectionRef.current?.contains(event.target)) closeRef.current?.focus();
    };
    document.addEventListener('focusin', keepFocus);
    return () => {
      observer.disconnect();
      document.removeEventListener('focusin', keepFocus);
      for (const [element, original] of originals) {
        if (original === null) element.removeAttribute('inert');
        else element.setAttribute('inert', original);
      }
      if (returnFocus !== null && visibleInViewport(returnFocus)) returnFocus.focus();
      else {
        const fallback = document.querySelector<HTMLElement>('[data-dialog-return]');
        if (fallback !== null && visibleInViewport(fallback)) fallback.focus();
      }
    };
  }, [returnFocus]);

  useEffect(() => {
    const viewport = window.visualViewport;
    const update = (): void => {
      backdropRef.current?.style.setProperty('--dialog-height', `${viewport?.height ?? window.innerHeight}px`);
      backdropRef.current?.style.setProperty('--dialog-top', `${viewport?.offsetTop ?? 0}px`);
    };
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  useLayoutEffect(() => {
    if (state.pending !== null) {
      if (confirmFocus.current === null && document.activeElement instanceof HTMLElement)
        confirmFocus.current = document.activeElement;
      cancelRef.current?.focus();
    } else if (confirmFocus.current !== null) {
      const target = confirmFocus.current;
      confirmFocus.current = null;
      if (available(target)) target.focus();
    }
  }, [state.pending]);

  const requestClose = (): void => {
    if (controller.state().pending !== null) controller.cancel();
    else controller.request(onClose);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      requestClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const candidates = Array.from(sectionRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(available);
    const first = candidates[0];
    const last = candidates.at(-1);
    if (first === undefined || last === undefined) {
      event.preventDefault();
      sectionRef.current?.focus();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !candidates.includes(active as HTMLElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !candidates.includes(active as HTMLElement))) {
      event.preventDefault();
      first.focus();
    }
  };
  const content = (
    <DialogContext.Provider value={actions}>
      <div ref={backdropRef} className="dialog-backdrop">
        <button
          type="button"
          className="dialog-scrim"
          tabIndex={-1}
          aria-label={`关闭${label}`}
          onPointerDown={(event) => event.preventDefault()}
          onClick={requestClose}
        />
        <section
          ref={sectionRef}
          className={`dialog ${className}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          onKeyDown={handleKeyDown}
        >
          <header className="dialog-head">
            <h2 id={titleId}>{label}</h2>
            <button ref={closeRef} type="button" className="ghost" onClick={requestClose}>
              关闭
            </button>
          </header>
          {state.notice === null ? null : (
            <p className="notice warn" role="status">
              {state.notice}
            </p>
          )}
          {state.pending === null ? null : (
            <section
              className="dialog-confirm notice warn"
              role="alertdialog"
              aria-labelledby={confirmId}
              aria-describedby={descriptionId}
            >
              <h3 id={confirmId}>
                {state.pending.guard.kind === 'recovery' ? '恢复码已安全保存吗？' : '尚有未保存的更改'}
              </h3>
              <p id={descriptionId}>{state.pending.guard.message}</p>
              <div className="save-bar">
                <button ref={cancelRef} type="button" onClick={controller.cancel}>
                  {state.pending.guard.kind === 'recovery' ? '返回保存恢复码' : '继续编辑'}
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={state.guard?.kind === 'busy'}
                  onClick={controller.confirm}
                >
                  {state.pending.guard.kind === 'recovery' ? '已安全保存并继续' : '放弃更改并继续'}
                </button>
              </div>
            </section>
          )}
          <div className="dialog-content" inert={state.pending !== null}>
            {children}
          </div>
        </section>
      </div>
    </DialogContext.Provider>
  );
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}
