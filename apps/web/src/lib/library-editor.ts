import { useEffect, useRef, useState } from 'react';
import { type LibraryView, useLibraryActions } from './library-view';

export function createLibraryEditor<T extends { id: string }>(
  initial: T | null,
  save: (draft: T) => void | Promise<void>,
  changed: () => void = () => {},
) {
  let draft = initial;
  let saved = initial;
  let writing: Promise<void> | null = null;
  let operation: Promise<void> | null = null;
  let composing = false;
  let generation = 0;
  let pendingRefresh: { next: T | null; baseline: T | null } | null = null;
  const same = (left: T | null, right: T | null) => JSON.stringify(left) === JSON.stringify(right);
  const adopt = (next: T | null) => {
    generation += 1;
    pendingRefresh = null;
    draft = next;
    saved = next;
    changed();
  };
  const settleRefresh = () => {
    if (writing || operation || composing || !same(draft, saved) || pendingRefresh === null) return;
    const pending = pendingRefresh;
    pendingRefresh = null;
    // A successful local write supersedes external snapshots observed before it.
    if (pending.baseline === saved && !same(pending.next, draft)) adopt(pending.next);
  };
  const saveDraft = async (): Promise<void> => {
    if (composing) throw new Error('输入仍在组合中，请完成输入后再离开。');
    while (writing || !same(draft, saved)) {
      if (composing) throw new Error('输入仍在组合中，请完成输入后再离开。');
      if (writing) {
        await writing;
        continue;
      }
      const next = draft;
      if (!next) return;
      const writingGeneration = generation;
      const task = Promise.resolve()
        .then(() => save(next))
        .then(() => {
          if (writingGeneration === generation) saved = next;
        });
      writing = task;
      changed();
      try {
        await task;
      } finally {
        if (writing === task) writing = null;
        settleRefresh();
        changed();
      }
    }
  };
  const flush = async (): Promise<void> => {
    if (operation) await operation;
    await saveDraft();
  };
  const run = (action: () => void | Promise<void>): Promise<void> => {
    if (operation) return Promise.reject(new Error('操作正在进行，请稍候。'));
    const task = Promise.resolve().then(async () => {
      await saveDraft();
      await action();
    });
    operation = task;
    changed();
    return task.finally(() => {
      if (operation === task) operation = null;
      settleRefresh();
      changed();
    });
  };
  return {
    get draft() {
      return draft;
    },
    get composing() {
      return composing;
    },
    get dirty() {
      return !same(draft, saved);
    },
    get busy() {
      return writing !== null || operation !== null;
    },
    patch(changes: Partial<T>) {
      if (draft) {
        draft = { ...draft, ...changes };
        changed();
      }
    },
    replace(next: T) {
      draft = next;
      changed();
    },
    refresh(next: T | null) {
      if (writing || operation || composing || !same(draft, saved)) {
        pendingRefresh = { next, baseline: saved };
        return;
      }
      pendingRefresh = null;
      if (!same(next, draft)) adopt(next);
    },
    invalidate() {
      composing = false;
      adopt(null);
    },
    select(next: T | null) {
      adopt(next);
    },
    flush,
    run,
    create(next: T) {
      return run(async () => {
        await save(next);
        adopt(next);
      });
    },
    remove(remove: () => void | Promise<void>) {
      const removingGeneration = generation;
      return run(async () => {
        await remove();
        // External removal/selection repair can finish before its load completes.
        if (removingGeneration === generation) adopt(null);
      });
    },
    beginComposition() {
      composing = true;
    },
    endComposition() {
      composing = false;
      settleRefresh();
    },
  };
}

export interface LibraryEditorProps<T> {
  items: T[];
  view: LibraryView;
  selectedId?: string | null;
  initialId?: string | null;
  onSelectionChange?: (id: string | null) => void;
  disabled: boolean;
  onSave: (draft: T) => void | Promise<void>;
  pending?: () => string | null;
  discard?: () => void;
}

export function useLibraryEditor<T extends { id: string }>(props: LibraryEditorProps<T>) {
  const [, redraw] = useState(0);
  const [localId, setLocalId] = useState<string | null>(props.selectedId ?? props.initialId ?? null);
  const [error, setError] = useState<string | null>(null);
  const [requestBusy, setRequestBusy] = useState(false);
  const [createdGrace, setCreatedGrace] = useState<string | null>(null);
  const requesting = useRef(false);
  const latest = useRef(props);
  latest.current = props;
  const selectedId = props.selectedId === undefined ? localId : props.selectedId;
  const selected = props.items.find((item) => item.id === selectedId) ?? null;
  const [editor] = useState(() =>
    createLibraryEditor(
      selected,
      (next) => latest.current.onSave(next),
      () => redraw((n) => n + 1),
    ),
  );
  const actions = useLibraryActions();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const creationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const flush = async () => {
    clearTimer();
    await editor.flush();
    setError(null);
  };
  const report = (reason: unknown) => setError(reason instanceof Error ? reason.message : '保存失败，请重试。');
  const commit = async () => {
    try {
      await flush();
    } catch (reason) {
      report(reason);
    }
  };
  const queueSave = () => {
    clearTimer();
    if (editor.composing) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void commit();
    }, 300);
  };
  const notifySelection = (id: string | null) => {
    setLocalId(id);
    latest.current.onSelectionChange?.(id);
  };
  const request = async (action: () => void | Promise<void>) => {
    if (requesting.current) return false;
    requesting.current = true;
    setRequestBusy(true);
    try {
      return await actions.requestAction(async () => {
        try {
          await flush();
          await action();
        } catch (reason) {
          report(reason);
          throw reason;
        }
      });
    } catch (reason) {
      report(reason);
      return false;
    } finally {
      requesting.current = false;
      setRequestBusy(false);
    }
  };

  useEffect(() => {
    const currentId = editor.draft?.id;
    if (currentId && createdGrace !== currentId && !props.items.some((item) => item.id === currentId)) {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      editor.invalidate();
    }
    if (selected !== null && createdGrace === selected.id) {
      if (creationTimer.current !== null) {
        clearTimeout(creationTimer.current);
        creationTimer.current = null;
      }
      setCreatedGrace(null);
    }
    if (selected === null && selectedId !== null) {
      // Only this creation can lead the parent's array, and only for 300 ms.
      if (createdGrace === selectedId && editor.draft?.id === selectedId) return;
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      editor.invalidate();
      setLocalId(null);
      latest.current.onSelectionChange?.(null);
      return;
    }
    editor.refresh(selected);
  }, [selected, selectedId, props.items, editor, createdGrace]);
  const [leaveHandle] = useState(() => ({
    flush: async () => {
      try {
        await flush();
      } catch (reason) {
        report(reason);
        throw reason;
      }
    },
    pending: () => latest.current.pending?.() ?? null,
    discard: () => latest.current.discard?.(),
  }));
  useEffect(() => actions.registerEditor(props.view, leaveHandle), [actions, props.view, leaveHandle]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      if (creationTimer.current !== null) clearTimeout(creationTimer.current);
    },
    [],
  );

  const writeDisabled = props.disabled || editor.busy || requestBusy;
  return {
    draft: editor.draft,
    selectedId,
    error,
    writeDisabled,
    patch(changes: Partial<T>, nativeComposing = false) {
      if (latest.current.disabled || editor.busy || requesting.current) return;
      if (nativeComposing) editor.beginComposition();
      editor.patch(changes);
      if (!nativeComposing) queueSave();
    },
    replace(next: T) {
      if (latest.current.disabled || editor.busy || requesting.current) return;
      editor.replace(next);
      queueSave();
    },
    commit,
    beginComposition() {
      editor.beginComposition();
      clearTimer();
    },
    endComposition() {
      editor.endComposition();
      queueSave();
    },
    select(id: string | null) {
      return request(() => {
        editor.select(latest.current.items.find((item) => item.id === id) ?? null);
        notifySelection(id);
      });
    },
    create(next: T) {
      if (latest.current.disabled || editor.busy || requesting.current) return Promise.resolve(false);
      return request(async () => {
        await editor.create(next);
        if (creationTimer.current !== null) clearTimeout(creationTimer.current);
        setCreatedGrace(next.id);
        creationTimer.current = setTimeout(() => {
          creationTimer.current = null;
          setCreatedGrace(null);
        }, 300);
        notifySelection(next.id);
      });
    },
    remove(remove: () => void | Promise<void>) {
      if (latest.current.disabled || editor.busy || requesting.current) return Promise.resolve(false);
      return request(async () => {
        await editor.remove(remove);
        notifySelection(editor.draft?.id ?? null);
      });
    },
    run(action: () => void | Promise<void>) {
      if (latest.current.disabled || editor.busy || requesting.current) return Promise.resolve(false);
      return request(() => editor.run(action));
    },
  };
}
