import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { type DialogGuard, DialogShell } from './DialogShell';

/** 保留小弹窗的标题、正文与页脚，所有关闭和焦点行为复用 DialogShell。 */
export interface ModalProps {
  /** 无障碍标签：`aria-label` 与遮罩按钮的「关闭 ××」都由它拼出来。 */
  label: string;
  onClose: () => void;
  /** 标题栏左侧的内容（标题、说明、头像、输入框都行）。 */
  head: ReactNode;
  /** 标题栏右侧那颗退出按钮写什么字（默认「关闭」；新对话那处写「取消」）。 */
  closeLabel?: string;
  children: ReactNode;
  /** 底部按钮那一行；不传就不渲染 `modal-foot`（角色详情就是这种）。 */
  footer?: ReactNode | ((requestClose: () => void) => ReactNode);
  guard?: DialogGuard | null;
  initialFocus?: string;
}

export function Modal(props: ModalProps) {
  const [returnFocus] = useState(() =>
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  return <DialogShell {...props} appearance="modal" returnFocus={returnFocus} />;
}

/** Track actual writes without losing debounce/IME draft behavior on close. */
export function useModalSaves(scope: string) {
  const ownerRef = useRef({
    scope,
    pending: new Set<Promise<boolean>>(),
    tail: null as Promise<boolean> | null,
    latest: new Map<string, object>(),
    failed: new Map<string, { action: () => void | Promise<void>; retryOnClose: boolean; message: string }>(),
  });
  if (ownerRef.current.scope !== scope)
    ownerRef.current = { scope, pending: new Set(), tail: null, latest: new Map(), failed: new Map() };
  const owner = ownerRef.current;
  const activeRef = useRef<typeof owner | null>(owner);
  const [feedback, setFeedback] = useState<{ owner: typeof owner; busy: boolean; error: string | null } | null>(null);
  useLayoutEffect(() => {
    activeRef.current = owner;
    return () => {
      if (activeRef.current === owner) activeRef.current = null;
    };
  }, [owner]);
  const update = (error: string | null): void => {
    if (activeRef.current === owner)
      setFeedback({
        owner,
        busy: owner.pending.size > 0,
        error: error ?? [...owner.failed.values()].at(-1)?.message ?? null,
      });
  };
  const save = (key: string, action: () => void | Promise<void>, retryOnClose = true): Promise<boolean> => {
    const token = {};
    owner.latest.set(key, token);
    owner.failed.delete(key);
    let result: void | Promise<void>;
    const run = () => {
      if (activeRef.current !== owner) throw new Error('保存目标已变化，未提交排队的旧更改。');
      return action();
    };
    try {
      result = owner.tail ? owner.tail.then(run, run) : run();
    } catch (error) {
      result = Promise.reject(error);
    }
    const pending = Promise.resolve(result)
      .then(
        () => {
          if (owner.latest.get(key) === token) owner.failed.delete(key);
          return activeRef.current === owner;
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (owner.latest.get(key) === token) owner.failed.set(key, { action, retryOnClose, message });
          update(null);
          return false;
        },
      )
      .finally(() => {
        owner.pending.delete(pending);
        if (owner.tail === pending) owner.tail = null;
        if (activeRef.current === owner) update(null);
      });
    owner.pending.add(pending);
    owner.tail = pending;
    update(null);
    return pending;
  };
  const flush = async (): Promise<boolean> => {
    // Failed writes have advanced useDraftField's saved marker; retry the exact
    // write instead of treating that marker as evidence of durable storage.
    const retries = [...owner.failed.entries()].filter(([, failure]) => failure.retryOnClose);
    for (const [key, failure] of retries) void save(key, failure.action);
    while (owner.pending.size > 0) await Promise.all([...owner.pending]);
    return activeRef.current === owner && ![...owner.failed.values()].some((failure) => failure.retryOnClose);
  };
  return {
    save,
    flush,
    isBusy: () => owner.pending.size > 0,
    busy: feedback?.owner === owner && feedback.busy,
    error: feedback?.owner === owner ? feedback.error : null,
  };
}
