import {
  type BudgetEditorSession,
  type BudgetLimits,
  budgetDraftSignature,
  budgetLimitsSignature,
  createBudgetDraft,
  reconcileBudgetDraft,
} from '@dramatis/core';
import { type Dispatch, type SetStateAction, useCallback, useRef, useState } from 'react';

/** Owned by one mounted application/library shell; never persisted or shared globally. */
export type BudgetDraftStore = Map<string, BudgetEditorSession>;
export function createBudgetDraftStore(): BudgetDraftStore {
  return new Map();
}

/** The caller keys the editor by world ID; unidentified legacy callers retain local state only. */
export function useBudgetDraftMemory(
  worldId: string | null | undefined,
  limits: BudgetLimits | null | undefined,
  store: BudgetDraftStore | undefined,
): [BudgetEditorSession, Dispatch<SetStateAction<BudgetEditorSession>>] {
  const key = typeof worldId === 'string' && worldId.trim() !== '' ? worldId : null;
  const [editor, setEditor] = useState(() => {
    const remembered = key === null ? undefined : store?.get(key);
    if (remembered) return reconcileBudgetDraft(remembered, limits);
    const draft = createBudgetDraft(limits);
    return { draft, baseSignature: budgetLimitsSignature(limits), cleanSignature: budgetDraftSignature(draft) };
  });
  const current = useRef(editor);
  current.current = editor;
  const update = useCallback<Dispatch<SetStateAction<BudgetEditorSession>>>(
    (next) => {
      const value = typeof next === 'function' ? next(current.current) : next;
      current.current = value;
      // Remember immediately, including a final input change followed by tab unmount.
      if (key !== null) store?.set(key, value);
      setEditor(value);
    },
    [key, store],
  );
  return [editor, update];
}
