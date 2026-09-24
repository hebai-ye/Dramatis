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

// 体积的显示格式搬到 lib/format.ts（顺序 65 收敛重复）：与时间格式放在一起，
// 想看「界面上这些数字长什么样」不用再翻存储模块。

export interface StorageApi {
  status: StorageStatus;
  /** 用量占配额的比例；算不出来时是 null。 */
  ratio: number | null;
  /**
   * 申请持久化存储。要放在用户点击里调用——有些浏览器只在用户手势下才批。
   *
   * 返回**这一次到底成没成**，而不是无声无息地失败：Chrome 不弹窗，
   * 它按「有没有装成应用 / 来过几次」自己判断，被拒是常态，
   * 用户至少要知道「点了没用」和「为什么没用」。
   */
  requestPersist: () => Promise<boolean>;
  /**
   * 装成应用（PWA）的入口。
   *
   * 这不是「锦上添花」：Chrome 上**装到桌面之后才会给持久化存储**，
   * 所以它是拿到持久化的正路；拿不到事件时（已经装过、或浏览器不支持）
   * 返回 false，界面负责告诉用户去地址栏找安装按钮。
   */
  installApp: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
  /** 能不能一键装（浏览器给了 beforeinstallprompt）。 */
  canInstall: boolean;
  reload: () => Promise<void>;
}

export function useStorageStatus(): StorageApi {
  const [status, setStatus] = useState<StorageStatus>(UNKNOWN);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);

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

  const requestPersist = useCallback(async (): Promise<boolean> => {
    const manager = navigator.storage;
    if (manager === undefined || typeof manager.persist !== 'function') return false;
    const granted = await manager.persist();
    await reload();
    return granted;
  }, [reload]);

  const installApp = useCallback(async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    if (installEvent === null) return 'unavailable';
    await installEvent.prompt();
    const choice = await installEvent.userChoice;
    setInstallEvent(null);
    return choice.outcome === 'accepted' ? 'accepted' : 'dismissed';
  }, [installEvent]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * 页面加载时**自动申请一次**持久化。
   *
   * 为什么不只留按钮：Chrome 会看「这个站点被访问过几次 / 有没有装成应用」，
   * 自动申请那些次会慢慢把它推到「该给」的那一档，用户不必记得点。
   * 这里不打扰任何人：失败就失败，界面照旧显示「未获得」。
   */
  useEffect(() => {
    void requestPersist().catch(() => {});
  }, [requestPersist]);

  // 浏览器给出安装机会时记下来，界面就能给一个真正的「装成应用」按钮
  useEffect(() => {
    const onPrompt = (event: Event): void => {
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  const ratio = status.usage !== null && status.quota !== null && status.quota > 0 ? status.usage / status.quota : null;

  return { status, ratio, requestPersist, installApp, canInstall: installEvent !== null, reload };
}

/** Chrome 的安装事件（还没进标准类型定义，自己声明一下用得到的那两个成员）。 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
