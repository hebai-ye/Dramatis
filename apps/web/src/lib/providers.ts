import {
  type CreateProviderProfileInput,
  createProviderProfile,
  createVault,
  type KeyStore,
  type ProviderProfile,
} from '@dramatis/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DramatisDb } from './db';
import {
  browserVaultStorage,
  createBrowserKeyStore,
  hasBrowserVault,
  type KeyStorageMode,
  openBrowserVault,
  type VaultSession,
} from './keystore';
import type { BackgroundProviderConfig } from './worker';

const META_ACTIVE_PROFILE = 'provider.activeId';
const META_KEY_MODE = 'provider.keyMode';

const DEFAULT_PROFILE: CreateProviderProfileInput = {
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  role: 'main',
};

export interface ProvidersApi {
  profiles: ProviderProfile[];
  activeId: string | null;
  active: ProviderProfile | null;
  apiKey: string;
  keyMode: KeyStorageMode;
  keyKind: KeyStore['kind'];
  /** 本机已经有一个口令库（界面用它决定显示「解锁」还是「设口令」）。 */
  vaultExists: boolean;
  /** 选了口令加密、但这次会话还没解开：现在拿不到 Key。 */
  vaultLocked: boolean;
  /** 用口令解开本机的口令库；口令不对时抛错（信息是给人看的）。 */
  unlockVault: (passphrase: string) => Promise<void>;
  /**
   * 后台任务（记忆抽取等）使用的配置。
   *
   * 优先用标了 background 的配置，通常是更便宜的模型；没有单独配置时
   * 退回当前配置，保证功能可用。
   */
  background: BackgroundProviderConfig | null;
  selectProfile: (id: string) => Promise<void>;
  addProfile: (input: CreateProviderProfileInput) => Promise<void>;
  updateProfile: (id: string, patch: Partial<ProviderProfile>) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  setApiKey: (value: string) => Promise<void>;
  setKeyMode: (mode: KeyStorageMode) => Promise<void>;
  /**
   * 一次性提交「模型接入」面板上的全部改动。
   *
   * 面板是草稿式的：改字段不再即时落库，而是等用户点保存。这样既给了「改完再确认」
   * 的机会，也让「密钥保存方式」和密钥本身能一起生效——分成两步做的话，先切档位
   * 再写密钥会写进旧的存储实例（KeyStore 的重建发生在下次渲染之后）。
   */
  commitConfig: (input: {
    profile: Partial<ProviderProfile>;
    apiKey: string;
    keyMode: KeyStorageMode;
    /** `keyMode === 'encrypted'` 时带上：新建口令库用它，已有库用它解锁。 */
    vaultPassphrase?: string;
  }) => Promise<void>;
}

/**
 * 模型服务配置管理（ROADMAP P0-8）。
 *
 * 配置本身落在实体表里，密钥落在 KeyStore 里，两者通过 keyRef 关联。
 * 这样配置将来可以安全同步，密钥永远不会离开设备。
 */
export function useProviders(db: DramatisDb | null): ProvidersApi {
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  /**
   * 密钥保存方式的默认值：**保存在本机浏览器**。
   *
   * 之前默认「仅本次会话」，结果是用户填了 Key、点了保存，刷新之后又要重填——
   * 看起来就像「保存按钮没用」（用户 2026-09-21 反馈）。功能是对的，默认不对：
   * 「点保存就该留住」才符合直觉。想更保守的人随时可以切回「仅本次会话」。
   */
  const [keyMode, setKeyModeState] = useState<KeyStorageMode>('device');
  const [apiKey, setApiKeyState] = useState('');
  const [backgroundKey, setBackgroundKey] = useState('');
  const [keyKind, setKeyKind] = useState<KeyStore['kind']>('memory');
  const [vault, setVault] = useState<VaultSession | null>(null);
  const [vaultExists, setVaultExists] = useState(false);

  const keyStoreRef = useRef<KeyStore>(createBrowserKeyStore('session'));

  const refresh = useCallback(async () => {
    if (!db) return [];
    const list = await db.repository.listProviderProfiles();
    setProfiles(list);
    return list;
  }, [db]);

  // 首次运行给一份可用的默认配置，避免空白界面
  useEffect(() => {
    if (!db) return;
    let cancelled = false;

    void (async () => {
      let list = await db.repository.listProviderProfiles();

      if (list.length === 0) {
        const created = createProviderProfile(DEFAULT_PROFILE);
        await db.repository.saveProviderProfile(created);
        list = [created];
      }

      const storedMode = await db.repository.getMeta<KeyStorageMode>(META_KEY_MODE);
      const storedActive = await db.repository.getMeta<string>(META_ACTIVE_PROFILE);

      if (cancelled) return;
      setProfiles(list);
      setKeyModeState(storedMode === 'session' ? 'session' : storedMode === 'encrypted' ? 'encrypted' : 'device');
      setActiveId(storedActive ?? list[0]?.id ?? null);
    })();

    // 本机有没有口令库：不需要口令就能问，界面靠它决定显示「解锁」还是「设口令」
    void hasBrowserVault()
      .then((exists) => {
        if (!cancelled) setVaultExists(exists);
      })
      .catch(() => {
        // 文件坏了：不在这里处置（ProviderPanel 打开时会如实报错）
      });

    return () => {
      cancelled = true;
    };
  }, [db]);

  // 存储档位 / 口令库 / 当前配置变化时，重建 KeyStore 并把已有密钥读回来
  useEffect(() => {
    const store = createBrowserKeyStore(keyMode, vault);
    keyStoreRef.current = store;
    setKeyKind(store.kind);

    const profile = profiles.find((item) => item.id === activeId);
    if (!profile) {
      setApiKeyState('');
      return;
    }

    void store.get(profile.keyRef).then((secret) => setApiKeyState(secret ?? ''));

    const backgroundProfile = profiles.find((item) => item.role === 'background');
    if (!backgroundProfile) {
      setBackgroundKey('');
      return;
    }
    void store.get(backgroundProfile.keyRef).then((secret) => setBackgroundKey(secret ?? ''));
  }, [keyMode, vault, activeId, profiles]);

  /**
   * 解开本机的口令库（顺序 10）。
   *
   * 解开之后把 KeyStore 换成库里的那份，界面上的「已连接」状态跟着变——
   * 这一条与「存进去」是两件事：库在盘上，钥匙在口令里。
   */
  const unlockVault = useCallback(async (passphrase: string) => {
    const opened = await openBrowserVault(passphrase);
    setVault(opened);
    setVaultExists(true);
  }, []);

  const selectProfile = useCallback(
    async (id: string) => {
      setActiveId(id);
      await db?.repository.setMeta(META_ACTIVE_PROFILE, id);
    },
    [db],
  );

  const addProfile = useCallback(
    async (input: CreateProviderProfileInput) => {
      if (!db) return;
      const created = createProviderProfile(input);
      await db.repository.saveProviderProfile(created);
      await refresh();
      await selectProfile(created.id);
    },
    [db, refresh, selectProfile],
  );

  const updateProfile = useCallback(
    async (id: string, patch: Partial<ProviderProfile>) => {
      if (!db) return;
      const existing = profiles.find((item) => item.id === id);
      if (!existing) return;

      const next: ProviderProfile = { ...existing, ...patch, id: existing.id, keyRef: existing.keyRef };
      await db.repository.saveProviderProfile(next);
      setProfiles((previous) => previous.map((item) => (item.id === id ? next : item)));
    },
    [db, profiles],
  );

  const deleteProfile = useCallback(
    async (id: string) => {
      if (!db) return;
      const existing = profiles.find((item) => item.id === id);
      if (existing) await keyStoreRef.current.remove(existing.keyRef);

      await db.repository.deleteProviderProfile(id);
      const remaining = await refresh();
      if (activeId === id) await selectProfile(remaining[0]?.id ?? '');
    },
    [activeId, db, profiles, refresh, selectProfile],
  );

  const setApiKey = useCallback(
    async (value: string) => {
      setApiKeyState(value);
      const profile = profiles.find((item) => item.id === activeId);
      if (!profile) return;

      if (value === '') {
        await keyStoreRef.current.remove(profile.keyRef);
        return;
      }
      await keyStoreRef.current.set(profile.keyRef, value);
    },
    [activeId, profiles],
  );

  const setKeyMode = useCallback(
    async (mode: KeyStorageMode) => {
      setKeyModeState(mode);
      await db?.repository.setMeta(META_KEY_MODE, mode);
    },
    [db],
  );

  const commitConfig = useCallback(
    async (input: {
      profile: Partial<ProviderProfile>;
      apiKey: string;
      keyMode: KeyStorageMode;
      vaultPassphrase?: string;
    }) => {
      if (!db) return;
      const profile = profiles.find((item) => item.id === activeId);
      if (!profile) return;

      /*
       * 口令加密那一档（顺序 10）：先把库备好，再往里写。
       *
       * 「新建库」与「解锁已有库」在用户眼里是同一件事（都在这一句口令上），
       * 所以这里自动分流：本机还没有库就用这句口令建一个，已经有了就用它解锁。
       * 口令不对就抛出去——宁可让用户再打一遍，也不能把 Key 写进一个解不开的库。
       */
      let target: KeyStore | null = null;
      if (input.keyMode === 'encrypted') {
        const passphrase = input.vaultPassphrase ?? '';
        if (passphrase.trim() === '') {
          throw new Error('选了「口令加密」就要给一句口令：它用来加密这台机器上的 Key。');
        }
        const opened = await openBrowserVault(passphrase).catch(async (error: unknown) => {
          if (await hasBrowserVault()) throw error;
          await createVault(browserVaultStorage(), passphrase);
          return openBrowserVault(passphrase);
        });
        setVault(opened);
        setVaultExists(true);
        target = opened.store;
      }

      // 先按目标档位把密钥写好，再切换档位：KeyStore 的重建发生在下次渲染之后，
      // 直接调用 setApiKey 会写进旧的存储实例
      const store = target ?? createBrowserKeyStore(input.keyMode);
      if (input.apiKey.trim() === '') await store.remove(profile.keyRef);
      else await store.set(profile.keyRef, input.apiKey);

      if (input.keyMode !== keyMode) {
        /*
         * 离开「明文存在本机」这一档时，顺手把明文那份删掉：
         * 否则用户以为已经收回了（换成密文 / 只留内存），磁盘上其实还留着。
         */
        if (keyMode === 'device') await createBrowserKeyStore('device').remove(profile.keyRef);
        setKeyModeState(input.keyMode);
        await db.repository.setMeta(META_KEY_MODE, input.keyMode);
      }

      keyStoreRef.current = store;
      setKeyKind(store.kind);
      setApiKeyState(input.apiKey);
      await updateProfile(profile.id, input.profile);
    },
    [activeId, db, keyMode, profiles, updateProfile],
  );

  return {
    profiles,
    activeId,
    active: profiles.find((item) => item.id === activeId) ?? null,
    apiKey,
    keyMode,
    keyKind,
    vaultExists,
    vaultLocked: keyMode === 'encrypted' && vault === null,
    unlockVault,
    background: buildBackground(),
    selectProfile,
    addProfile,
    updateProfile,
    deleteProfile,
    setApiKey,
    setKeyMode,
    commitConfig,
  };

  function buildBackground(): ProvidersApi['background'] {
    const dedicated = profiles.find((item) => item.role === 'background');
    if (dedicated) {
      return {
        baseUrl: dedicated.baseUrl,
        apiKey: backgroundKey,
        model: dedicated.model,
        temperature: 0.2,
        price: dedicated.price ?? null,
      };
    }

    const fallback = profiles.find((item) => item.id === activeId);
    if (!fallback) return null;
    return {
      baseUrl: fallback.baseUrl,
      apiKey,
      model: fallback.model,
      temperature: 0.2,
      price: fallback.price ?? null,
    };
  }
}
