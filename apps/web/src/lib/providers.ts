import {
  type CreateProviderProfileInput,
  createProviderProfile,
  type KeyStore,
  type ProviderProfile,
} from '@dramatis/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DramatisDb } from './db';
import { createBrowserKeyStore, type KeyStorageMode } from './keystore';

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
  /**
   * 后台任务（记忆抽取等）使用的配置。
   *
   * 优先用标了 background 的配置，通常是更便宜的模型；没有单独配置时
   * 退回当前配置，保证功能可用。
   */
  background: { baseUrl: string; apiKey: string; model: string; temperature: number } | null;
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
  const [keyMode, setKeyModeState] = useState<KeyStorageMode>('session');
  const [apiKey, setApiKeyState] = useState('');
  const [backgroundKey, setBackgroundKey] = useState('');
  const [keyKind, setKeyKind] = useState<KeyStore['kind']>('memory');

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
      setKeyModeState(storedMode === 'device' ? 'device' : 'session');
      setActiveId(storedActive ?? list[0]?.id ?? null);
    })();

    return () => {
      cancelled = true;
    };
  }, [db]);

  // 存储档位或当前配置变化时，重建 KeyStore 并把已有密钥读回来
  useEffect(() => {
    const store = createBrowserKeyStore(keyMode);
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
  }, [keyMode, activeId, profiles]);

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
    async (input: { profile: Partial<ProviderProfile>; apiKey: string; keyMode: KeyStorageMode }) => {
      if (!db) return;
      const profile = profiles.find((item) => item.id === activeId);
      if (!profile) return;

      // 先按目标档位把密钥写好，再切换档位：KeyStore 的重建发生在下次渲染之后，
      // 直接调用 setApiKey 会写进旧的存储实例
      const target = createBrowserKeyStore(input.keyMode);
      if (input.apiKey.trim() === '') await target.remove(profile.keyRef);
      else await target.set(profile.keyRef, input.apiKey);

      if (input.keyMode !== keyMode) {
        // 从「保存在本机浏览器」切回「仅本次会话」时，顺手清掉明文那份，
        // 否则用户以为已经收回了，磁盘上其实还留着
        if (keyMode === 'device') await createBrowserKeyStore('device').remove(profile.keyRef);
        setKeyModeState(input.keyMode);
        await db.repository.setMeta(META_KEY_MODE, input.keyMode);
      }

      keyStoreRef.current = target;
      setKeyKind(target.kind);
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
      return { baseUrl: dedicated.baseUrl, apiKey: backgroundKey, model: dedicated.model, temperature: 0.2 };
    }

    const fallback = profiles.find((item) => item.id === activeId);
    if (!fallback) return null;
    return { baseUrl: fallback.baseUrl, apiKey, model: fallback.model, temperature: 0.2 };
  }
}
