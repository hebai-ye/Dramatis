import {
  flushPendingAccountDeletions,
  type LocalAccount,
  listAccountSecretRefs,
  pendingAccountDeletionCount,
  queueAccountDeletion,
  readAccountRegistryForDeletion,
  removeAccount,
  withAccountDeletionLock,
} from './db';
import { syncPasswordKeyRef } from './sync';
import { createSerialQueue } from './sync-queue';

export interface AccountDeletionResult {
  requiresReload: boolean;
  pending: number;
  warning: string | null;
}

const deletionQueue = createSerialQueue();

/** 只删除本机账户容器。当前页面持有的库连接由调用方在 reload 时释放。 */
export function deleteAccountLocally(account: LocalAccount): Promise<AccountDeletionResult> {
  return deletionQueue.run(async () => {
    const requiresReload = await withAccountDeletionLock(async () => {
      const registry = readAccountRegistryForDeletion();
      const target = registry.accounts.find((item) => item.id === account.id);
      if (target === undefined) throw new Error('找不到这个账户，请重新打开账户列表。');
      if (registry.accounts.length <= 1) throw new Error('至少要保留一个账户。');

      const secretRefs = await listAccountSecretRefs(target.dbName);
      // 读取库期间列表可能变化；排队前再核实，使用注册表的真实容器记录。
      const latest = readAccountRegistryForDeletion();
      const current = latest.accounts.find((item) => item.id === target.id);
      if (current === undefined || current.dbName !== target.dbName) {
        throw new Error('账户列表已变化，请重新打开后再删除。');
      }
      if (latest.accounts.length <= 1) throw new Error('至少要保留一个账户。');
      const active = latest.activeId === target.id;
      queueAccountDeletion(current, [...secretRefs, syncPasswordKeyRef(current.id)]);
      removeAccount(current.id);
      return active;
    });

    // flush 也取同一把锁，必须先释放注册表与队列临界段，避免嵌套锁死锁。
    if (requiresReload) return { requiresReload: true, pending: pendingAccountDeletionCount(), warning: null };
    try {
      const result = await flushPendingAccountDeletions();
      return {
        requiresReload: false,
        pending: result.remaining,
        warning:
          result.remaining > 0
            ? '账户已从列表移除，本机数据或密钥仍待清理；关闭其他标签页后重新打开应用会自动重试。'
            : null,
      };
    } catch (error) {
      return {
        requiresReload: false,
        pending: pendingAccountDeletionCount(),
        warning: `账户已从列表移除，但本机清理未完成：${error instanceof Error ? error.message : String(error)}。重新打开应用会自动重试。`,
      };
    }
  });
}
