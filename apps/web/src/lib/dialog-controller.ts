export interface DialogGuard {
  kind: 'busy' | 'recovery' | 'dirty';
  message: string;
  discard?: () => void;
}

export interface DialogState {
  guard: DialogGuard | null;
  pending: { guard: DialogGuard; action: () => void } | null;
  notice: string | null;
}

export function createDialogController(changed?: (state: DialogState) => void) {
  let current: DialogState = { guard: null, pending: null, notice: null };
  const update = (patch: Partial<DialogState>): void => {
    current = { ...current, ...patch };
    changed?.(current);
  };
  return {
    state: () => current,
    setGuard: (guard: DialogGuard | null): void => update({ guard, notice: null }),
    request: (action: () => void): void => {
      if (current.guard?.kind === 'busy') {
        update({ notice: current.guard.message });
      } else if (current.guard !== null) {
        update({ pending: { guard: current.guard, action }, notice: null });
      } else {
        action();
      }
    },
    confirm: (): void => {
      const pending = current.pending;
      if (pending === null) return;
      if (current.guard?.kind === 'busy') {
        update({ notice: current.guard.message });
        return;
      }
      if (current.guard !== null && current.guard !== pending.guard) {
        update({ pending: { ...pending, guard: current.guard } });
        return;
      }
      update({ pending: null, guard: null, notice: null });
      pending.guard.discard?.();
      pending.action();
    },
    cancel: (): void => update({ pending: null, notice: null }),
  };
}
