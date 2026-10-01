export interface AccountSyncBadge {
  state: 'known' | 'unknown';
  configured: boolean;
  unlocked: boolean;
  lastSyncAt: string | null;
  endpoint: string | null;
  error: string | null;
}

export async function copyRecoveryCode(
  code: string,
  clipboard: Pick<Clipboard, 'writeText'> | undefined,
): Promise<{ ok: boolean; message: string }> {
  try {
    if (clipboard === undefined) throw new Error('clipboard-unavailable');
    await clipboard.writeText(code);
    return { ok: true, message: '已复制恢复码，请存到安全的地方，再确认已保存。' };
  } catch {
    return { ok: false, message: '此浏览器无法复制，请手动选中恢复码并存到安全的地方。' };
  }
}

export function createAccountOperationGate() {
  let pending = false;
  return {
    async run<T>(
      action: () => Promise<T>,
      onPending: (pending: boolean) => void,
    ): Promise<{ started: false } | { started: true; value: T }> {
      if (pending) return { started: false };
      pending = true;
      onPending(true);
      try {
        return { started: true, value: await action() };
      } finally {
        pending = false;
        onPending(false);
      }
    },
  };
}

export function accountLeaveGuard(
  operation: string | null,
  recoveryCode: string | null,
  discard: () => void,
): { kind: 'busy' | 'recovery'; message: string; discard?: () => void } | null {
  if (operation !== null) return { kind: 'busy', message: `${operation}，请等操作结束后再离开。` };
  if (recoveryCode !== null)
    return { kind: 'recovery', message: '恢复码只显示这一次。请先安全保存；确认已保存后才能继续。', discard };
  return null;
}

export async function loadAccountBadges<T extends { id: string }>(
  accounts: readonly T[],
  read: (account: T) => Promise<Omit<AccountSyncBadge, 'state' | 'error'>>,
): Promise<Record<string, AccountSyncBadge>> {
  const entries = await Promise.all(
    accounts.map(async (account) => {
      try {
        return [account.id, { ...(await read(account)), state: 'known' as const, error: null }] as const;
      } catch (error) {
        return [
          account.id,
          {
            state: 'unknown' as const,
            configured: false,
            unlocked: false,
            lastSyncAt: null,
            endpoint: null,
            error: error instanceof Error ? error.message : String(error),
          },
        ] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}
