import { useCallback, useEffect, useRef, useState } from 'react';

/** Serialize writes sharing a parent snapshot and keep callbacks owned by their target. */
export function useSerialSave(scope: string) {
  const [, redraw] = useState(0);
  const ownerRef = useRef<{
    scope: string;
    tail: Promise<void> | null;
    pending: number;
    error: string | null;
    active: boolean;
  } | null>(null);
  if (ownerRef.current === null || ownerRef.current.scope !== scope) {
    if (ownerRef.current) ownerRef.current.active = false;
    ownerRef.current = { scope, tail: null, pending: 0, error: null, active: true };
  }
  const owner = ownerRef.current;
  const notify = useCallback(() => {
    if (owner.active && ownerRef.current === owner) redraw((n) => n + 1);
  }, [owner]);
  useEffect(() => {
    owner.active = true;
    return () => {
      owner.active = false;
    };
  }, [owner]);
  const run = useCallback(
    (action: () => void | Promise<void>): Promise<void> => {
      const run = () => {
        if (!owner.active || ownerRef.current !== owner) throw new Error('保存目标已切换，请重新编辑当前内容。');
        return action();
      };
      const task = owner.tail ? owner.tail.catch(() => {}).then(run) : Promise.resolve().then(run);
      owner.tail = task;
      owner.pending += 1;
      notify();
      void task
        .then(
          () => {
            owner.error = null;
          },
          (reason: unknown) => {
            owner.error = reason instanceof Error ? reason.message : String(reason);
          },
        )
        .then(() => {
          owner.pending -= 1;
          if (owner.tail === task) owner.tail = null;
          notify();
        });
      return task;
    },
    [owner, notify],
  );
  const flush = useCallback(async (): Promise<boolean> => {
    try {
      while (owner.tail) await owner.tail;
      return owner.active && ownerRef.current === owner;
    } catch {
      return false;
    }
  }, [owner]);
  return {
    busy: owner.pending > 0,
    error: owner.error,
    run,
    flush,
  };
}
