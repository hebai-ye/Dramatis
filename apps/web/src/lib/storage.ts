import { useCallback, useEffect, useState } from 'react';

/**
 * 本机存储的持久化与配额（ROADMAP P2-3）。
 *
 * 为什么必须管这件事：浏览器的存储默认是**尽力而为**的——磁盘紧张时，
 * 或者用户长时间不开这个站点，浏览器可以悄悄清掉 IndexedDB。对一个把
 * 整条世界线放在本地、又还没做云同步的应用来说，那是灾难性的。
 *
 * 所以这里做两件事：
 * 1. 尽量拿到**持久化存储**（persisted）——拿到之后浏览器不会自动清；
 * 2. 把**用量与配额**摆给用户看，快满的时候提醒他导出一份封存。
 *
 * 注意：`persist()` 在多数浏览器不弹窗，而是按「站点是否被收藏 / 是否装到桌面 /
 * 是否常来」自行判断。所以它可能返回 false，这不是错误，如实告诉用户就好。
 */
export interface StorageStatus {
  /** 浏览器有没有这套 API。 */
  supported: boolean;
  /** 是否已经拿到持久化；未知时是 null。 */
  persisted: boolean | null;
  /** 已用字节数；未知时是 null。 */
  usage: number | null;
  /** 配额字节数；未知时是 null。 */
  quota: number | null;
}

const UNKNOWN: StorageStatus = { supported: false, persisted: null, usage: null, quota: null };

/** 用到这个比例就提醒用户备份（导出封存），而不是等到写不进去。 */
export const QUOTA_WARN_RATIO = 0.8;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export interface StorageApi {
  status: StorageStatus;
  /** 用量占配额的比例；算不出来时是 null。 */
  ratio: number | null;
  /** 申请持久化存储。要放在用户点击里调用——有些浏览器只在用户手势下才批。 */
  requestPersist: () => Promise<void>;
  reload: () => Promise<void>;
}

export function useStorageStatus(): StorageApi {
  const [status, setStatus] = useState<StorageStatus>(UNKNOWN);

  const reload = useCallback(async () => {
    const manager = navigator.storage;
    if (manager === undefined) {
      setStatus(UNKNOWN);
      return;
    }

    const persisted = typeof manager.persisted === 'function' ? await manager.persisted() : null;
    const estimate = typeof manager.estimate === 'function' ? await manager.estimate() : {};

    setStatus({
      supported: true,
      persisted,
      usage: typeof estimate.usage === 'number' ? estimate.usage : null,
      quota: typeof estimate.quota === 'number' ? estimate.quota : null,
    });
  }, []);

  const requestPersist = useCallback(async () => {
    const manager = navigator.storage;
    if (manager === undefined || typeof manager.persist !== 'function') return;
    await manager.persist();
    await reload();
  }, [reload]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const ratio = status.usage !== null && status.quota !== null && status.quota > 0 ? status.usage / status.quota : null;

  return { status, ratio, requestPersist, reload };
}
