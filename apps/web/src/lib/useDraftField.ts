import { type ChangeEvent, useCallback, useEffect, useRef, useState } from 'react';

export type DraftSaveStatus = 'pending' | 'saving' | 'saved' | 'error';
export type DraftFlush = () => Promise<boolean>;

export interface UseDraftFieldOptions {
  /** The parent's last stored value. */
  value: string;
  /** Return the actual write so failure cannot be mistaken for durable storage. */
  commit: (value: string) => void | Promise<void>;
  delay?: number;
  /** A stable target identity; late work must never adopt another target's callback. */
  scope?: string;
}

type TextControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
export interface DraftField {
  bind: {
    value: string;
    onChange: (event: ChangeEvent<TextControl>) => void;
    onFocus: () => void;
    onBlur: () => void;
    onCompositionStart: () => void;
    onCompositionEnd: () => void;
  };
  /** Await all currently requested edits; false retains the draft and blocks leaving. */
  flush: DraftFlush;
  status: DraftSaveStatus;
  dirty: boolean;
  error: string | null;
  active: boolean;
}

/** Recheck every live draft after a round so edits during another field's write are included. */
export async function flushDraftFields(fields: readonly DraftField[], flushOperations: DraftFlush): Promise<boolean> {
  for (;;) {
    const results = await Promise.all([...fields.map((field) => field.flush()), flushOperations()]);
    if (!results.at(-1) || fields.some((field) => !field.active || field.error !== null)) return false;
    if (fields.every((field) => !field.dirty)) return results.every(Boolean);
  }
}

function createOwner({ value, commit, scope }: UseDraftFieldOptions) {
  return {
    scope,
    draft: value,
    saved: value,
    focused: false,
    composing: false,
    nativeComposing: false,
    timer: null as number | null,
    writing: null as Promise<boolean> | null,
    requested: false,
    error: null as string | null,
    active: true,
    commit,
  };
}

/** Local IME-safe drafts, debounced writes, and serial submission of the latest text. */
export function useDraftField(options: UseDraftFieldOptions): DraftField {
  const { value, delay = 300 } = options;
  const [, redraw] = useState(0);
  const ownerRef = useRef<ReturnType<typeof createOwner> | null>(null);
  if (ownerRef.current === null || ownerRef.current.scope !== options.scope) {
    const previous = ownerRef.current;
    if (previous) {
      previous.active = false;
      if (previous.timer !== null) window.clearTimeout(previous.timer);
    }
    ownerRef.current = createOwner(options);
  }
  const owner = ownerRef.current;
  owner.commit = options.commit;
  const notify = useCallback(() => {
    if (owner.active && ownerRef.current === owner) redraw((n) => n + 1);
  }, [owner]);
  const clearTimer = useCallback(() => {
    if (owner.timer !== null) window.clearTimeout(owner.timer);
    owner.timer = null;
  }, [owner]);

  useEffect(() => {
    if (owner.draft === value) return;
    if (owner.focused || owner.composing || owner.nativeComposing || owner.writing || owner.draft !== owner.saved)
      return;
    owner.draft = value;
    owner.saved = value;
    notify();
  }, [owner, value, notify]);
  useEffect(() => {
    owner.active = true;
    return () => {
      clearTimer();
      owner.active = false;
    };
  }, [owner, clearTimer]);

  const flush = useCallback((): Promise<boolean> => {
    clearTimer();
    if (!owner.active) return Promise.resolve(false);
    if (owner.composing || owner.nativeComposing) {
      owner.error = '输入仍在组合中，请完成输入后再离开。';
      notify();
      return Promise.resolve(false);
    }
    owner.requested = true;
    if (owner.writing) return owner.writing;
    if (owner.draft === owner.saved) {
      owner.error = null;
      notify();
      return Promise.resolve(true);
    }
    let task!: Promise<boolean>;
    task = (async () => {
      try {
        do {
          const next = owner.draft;
          owner.requested = false;
          owner.error = null;
          let result: void | Promise<void>;
          try {
            result = owner.commit(next);
          } catch (reason) {
            result = Promise.reject(reason);
          }
          await result;
          // Advance the stored marker only after a successful actual write.
          owner.saved = next;
          notify();
        } while (
          owner.active &&
          owner.requested &&
          !owner.composing &&
          !owner.nativeComposing &&
          owner.draft !== owner.saved
        );
        return owner.active && !owner.composing && !owner.nativeComposing && owner.draft === owner.saved;
      } catch (reason) {
        owner.error = reason instanceof Error ? reason.message : String(reason);
        return false;
      } finally {
        if (owner.writing === task) owner.writing = null;
        notify();
      }
    })();
    owner.writing = task;
    notify();
    return task;
  }, [owner, clearTimer, notify]);

  const queue = useCallback(() => {
    clearTimer();
    if (owner.composing || owner.nativeComposing) return;
    owner.timer = window.setTimeout(() => {
      owner.timer = null;
      void flush();
    }, delay);
  }, [owner, clearTimer, flush, delay]);
  const onChange = useCallback(
    (event: ChangeEvent<TextControl>) => {
      owner.draft = event.target.value;
      owner.nativeComposing = (event.nativeEvent as InputEvent).isComposing === true;
      owner.error = null;
      notify();
      if (owner.composing || owner.nativeComposing) {
        clearTimer();
        return;
      }
      queue();
    },
    [owner, notify, queue, clearTimer],
  );

  return {
    bind: {
      value: owner.draft,
      onChange,
      onFocus: () => {
        owner.focused = true;
      },
      onBlur: () => {
        owner.focused = false;
        void flush();
      },
      onCompositionStart: () => {
        owner.composing = true;
        clearTimer();
      },
      onCompositionEnd: () => {
        owner.composing = false;
        owner.nativeComposing = false;
        queue();
      },
    },
    flush,
    get status() {
      return owner.writing ? 'saving' : owner.error ? 'error' : owner.draft !== owner.saved ? 'pending' : 'saved';
    },
    get dirty() {
      return owner.draft !== owner.saved;
    },
    get error() {
      return owner.error;
    },
    get active() {
      return owner.active;
    },
  };
}
