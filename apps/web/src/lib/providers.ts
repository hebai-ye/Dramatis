import {
  type CreateProviderProfileInput,
  createProviderProfile,
  createVault,
  type KeyStore,
  newId,
  nowIso,
  type ProviderCredential,
  type ProviderProfile,
} from '@dramatis/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DramatisDb } from './db';
import { type DeepSeekSetupOwner, type DeepSeekSetupReceipt, isDeepSeekProfile } from './deepseek-setup';

export { deepseekSetupState, isDeepSeekProfile } from './deepseek-setup';

import {
  browserVaultStorage,
  createBrowserKeyStore,
  hasBrowserVault,
  type KeyStorageMode,
  openBrowserVault,
  type VaultSession,
} from './keystore';
import type { SyncApi } from './sync';
import type { BackgroundProviderConfig } from './worker';

const META_ACTIVE_PROFILE = 'provider.activeId';
const META_KEY_MODE = 'provider.keyMode';

const DEFAULT_PROFILE: CreateProviderProfileInput = {
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  role: 'main',
};

export type ProviderNumericField = 'temperature' | 'maxTokens' | 'reserveForReply' | 'priceInput' | 'priceOutput';

/** Save-time validation only: never normalize stored profiles or historical usage. */
export function providerNumericErrors(
  profile: Pick<ProviderProfile, 'temperature' | 'maxTokens' | 'reserveForReply' | 'price'>,
): Partial<Record<ProviderNumericField, string>> {
  const errors: Partial<Record<ProviderNumericField, string>> = {};
  if (!Number.isFinite(profile.temperature) || profile.temperature < 0 || profile.temperature > 2)
    errors.temperature = '温度必须是 0–2 之间的有限数值。';
  if (!Number.isSafeInteger(profile.maxTokens) || profile.maxTokens <= 0) errors.maxTokens = '上下文窗口必须是正整数。';
  if (!Number.isSafeInteger(profile.reserveForReply) || profile.reserveForReply <= 0)
    errors.reserveForReply = '预留回复必须是正整数。';
  else if (Number.isFinite(profile.maxTokens) && profile.reserveForReply >= profile.maxTokens)
    errors.reserveForReply = '预留回复必须小于上下文窗口。';
  if (profile.price != null) {
    if (!Number.isFinite(profile.price.inputPerMillion) || profile.price.inputPerMillion < 0)
      errors.priceInput = '输入价 / 百万 token 必须是非负有限数值，也可以留空。';
    if (!Number.isFinite(profile.price.outputPerMillion) || profile.price.outputPerMillion < 0)
      errors.priceOutput = '输出价 / 百万 token 必须是非负有限数值，也可以留空。';
  }
  return errors;
}

/** 两份配置列表内容是否一致（审计 A10：一致就别 set，免得引用变化触发重渲染）。 */
export function sameProfiles(a: readonly ProviderProfile[], b: readonly ProviderProfile[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((profile, index) => JSON.stringify(profile) === JSON.stringify(b[index]));
}

function isAutoCreatedDefault(profile: ProviderProfile): boolean {
  return (
    profile.name === DEFAULT_PROFILE.name &&
    profile.baseUrl === DEFAULT_PROFILE.baseUrl &&
    (profile.model === DEFAULT_PROFILE.model || profile.model === 'deepseek-chat')
  );
}

interface KeyReadStamp {
  profileId: string;
  keyRef: string;
  mode: KeyStorageMode;
  vault: VaultSession | null;
  db: DramatisDb | null;
  reload: number;
}

interface KeyRead {
  stamp: KeyReadStamp;
  value: string;
  error: string | null;
}

function sameKeyStamp(left: KeyReadStamp | null | undefined, right: KeyReadStamp | null): boolean {
  return (
    left != null &&
    right !== null &&
    left.profileId === right.profileId &&
    left.keyRef === right.keyRef &&
    left.mode === right.mode &&
    left.vault === right.vault &&
    left.db === right.db &&
    left.reload === right.reload
  );
}

export interface ProvidersApi {
  setupOwner: DeepSeekSetupOwner | null;
  saveDeepSeekKey: (apiKey: string, expectedOwner: DeepSeekSetupOwner) => Promise<DeepSeekSetupReceipt>;
  profiles: ProviderProfile[];
  activeId: string | null;
  active: ProviderProfile | null;
  apiKey: string;
  /** 当前配置的本机 Key 尚未读取完毕；这时 apiKey 保持为空。 */
  keyLoading: boolean;
  /** 读取失败不等于没有 Key；需重新读取后才能保存。 */
  keyError: string | null;
  reloadApiKey: () => void;
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
 * 账户同步可以传输配置与密钥的密文；KeyStore 控制本机的密钥缓存方式。
 */
export function useProviders(
  db: DramatisDb | null,
  sync: Pick<SyncApi, 'config' | 'status' | 'requestAutoSync' | 'sealSecret' | 'openSecret'>,
): ProvidersApi {
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
  const [keyRead, setKeyRead] = useState<KeyRead | null>(null);
  const [backgroundRead, setBackgroundRead] = useState<KeyRead | null>(null);
  const [keyReload, setKeyReload] = useState(0);
  const [keyKind, setKeyKind] = useState<KeyStore['kind']>('memory');
  const [vault, setVault] = useState<VaultSession | null>(null);
  const [vaultExists, setVaultExists] = useState(false);

  const keyStoreRef = useRef<KeyStore>(createBrowserKeyStore('session'));
  const sessionStoreRef = useRef(keyStoreRef.current);
  const providerKeyStore = useCallback(
    (mode: KeyStorageMode, session: VaultSession | null = null) =>
      mode === 'session' ? sessionStoreRef.current : createBrowserKeyStore(mode, session, { strictRead: true }),
    [],
  );
  const keyReadRef = useRef<KeyRead | null>(null);
  const keyRequestRef = useRef(0);
  const backgroundRequestRef = useRef(0);
  const active = profiles.find((profile) => profile.id === activeId) ?? null;
  const dedicated = profiles.find((profile) => profile.role === 'background') ?? null;
  const activeProfileId = active?.id ?? null;
  const activeKeyRef = active?.keyRef ?? null;
  const activeBaseUrl = active?.baseUrl ?? null;
  const setupContext = useMemo(() => ({ db, keyMode, vault }), [db, keyMode, vault]);
  const setupOwner = useMemo<DeepSeekSetupOwner | null>(
    () =>
      activeProfileId === null || activeKeyRef === null || db === null
        ? null
        : { profileId: activeProfileId, keyMode, context: setupContext, token: { activeKeyRef, activeBaseUrl } },
    [activeProfileId, activeKeyRef, activeBaseUrl, db, keyMode, setupContext],
  );
  const setupOwnerRef = useRef(setupOwner);
  setupOwnerRef.current = setupOwner;
  const setupTargetRef = useRef<{ owner: DeepSeekSetupOwner; target: ProviderProfile } | null>(null);
  const setupSavingRef = useRef(false);
  const setupRevisionRef = useRef(0);
  const backgroundProfileId = dedicated?.id ?? null;
  const backgroundKeyRef = dedicated?.keyRef ?? null;
  const activeStamp = useMemo<KeyReadStamp | null>(
    () =>
      activeProfileId === null || activeKeyRef === null
        ? null
        : {
            profileId: activeProfileId,
            keyRef: activeKeyRef,
            mode: keyMode,
            vault,
            db,
            reload: keyReload,
          },
    [activeProfileId, activeKeyRef, keyMode, vault, db, keyReload],
  );
  const backgroundStamp = useMemo<KeyReadStamp | null>(
    () =>
      backgroundProfileId === null || backgroundKeyRef === null
        ? null
        : {
            profileId: backgroundProfileId,
            keyRef: backgroundKeyRef,
            mode: keyMode,
            vault,
            db,
            reload: keyReload,
          },
    [backgroundProfileId, backgroundKeyRef, keyMode, vault, db, keyReload],
  );
  const activeStampRef = useRef(activeStamp);
  activeStampRef.current = activeStamp;
  const backgroundStampRef = useRef(backgroundStamp);
  backgroundStampRef.current = backgroundStamp;
  const currentRead = sameKeyStamp(keyRead?.stamp, activeStamp) ? keyRead : null;
  const keyLoading = activeStamp !== null && currentRead === null;
  const keyError = currentRead?.error ?? null;
  const apiKey = currentRead?.error === null ? currentRead.value : '';
  const backgroundKey =
    sameKeyStamp(backgroundRead?.stamp, backgroundStamp) && backgroundRead?.error === null ? backgroundRead.value : '';

  const invalidateKeyRead = useCallback(() => {
    keyRequestRef.current += 1;
    keyReadRef.current = null;
    setKeyRead(null);
  }, []);
  const reloadApiKey = useCallback(() => {
    invalidateKeyRead();
    setKeyReload((value) => value + 1);
  }, [invalidateKeyRead]);
  const requireKeyReady = useCallback((stamp: KeyReadStamp | null) => {
    if (stamp?.mode === 'encrypted' && stamp.vault === null)
      throw new Error('本机口令库尚未解锁，请先解锁并读取当前配置的 API Key 后再保存。');
    const read = keyReadRef.current;
    if (!sameKeyStamp(read?.stamp, stamp) || !sameKeyStamp(stamp, activeStampRef.current)) {
      throw new Error('当前配置的 API Key 尚未读取完成，请等待后再保存。');
    }
    if (read?.error != null) throw new Error(`当前配置的 API Key 读取失败，请重新读取后再保存：${read.error}`);
  }, []);
  const publishBackgroundKey = useCallback((stamp: KeyReadStamp, value: string) => {
    if (!sameKeyStamp(stamp, backgroundStampRef.current)) return;
    backgroundRequestRef.current += 1;
    setBackgroundRead({ stamp, value, error: null });
  }, []);
  const publishActiveKey = useCallback(
    (stamp: KeyReadStamp, value: string) => {
      publishBackgroundKey(stamp, value);
      if (!sameKeyStamp(stamp, activeStampRef.current)) return;
      keyRequestRef.current += 1;
      const read = { stamp, value, error: null };
      keyReadRef.current = read;
      setKeyRead(read);
    },
    [publishBackgroundKey],
  );

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
      const activeIdValue = storedActive ?? list.find((profile) => profile.active === true)?.id ?? list[0]?.id ?? null;
      if (activeIdValue !== null && !list.some((profile) => profile.active === true)) {
        list = list.map((profile) => (profile.id === activeIdValue ? { ...profile, active: true } : profile));
        const selected = list.find((profile) => profile.id === activeIdValue);
        if (selected !== undefined) await db.repository.saveProviderProfile(selected);
      }

      if (cancelled) return;
      setProfiles(list);
      setKeyModeState(storedMode === 'session' ? 'session' : storedMode === 'encrypted' ? 'encrypted' : 'device');
      setActiveId(activeIdValue);
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
    const store = providerKeyStore(keyMode, vault);
    keyStoreRef.current = store;
    setKeyKind(store.kind);
    /*
     * 读 Key 是异步的（审计 B5）：快速切换配置时，旧请求可能后返回，把 A 的 Key
     * 写进当前状态、随后发给 B 的服务商。cleanup 置 cancelled，旧结果一律丢弃。
     */
    let cancelled = false;

    const request = ++keyRequestRef.current;
    if (activeStamp !== null) {
      const complete = (value: string, error: string | null) => {
        if (cancelled || request !== keyRequestRef.current) return;
        const read = { stamp: activeStamp, value, error };
        keyReadRef.current = read;
        setKeyRead(read);
      };
      void store
        .get(activeStamp.keyRef)
        .then((secret) => complete(secret ?? '', null))
        .catch((error: unknown) => complete('', error instanceof Error ? error.message : String(error)));
    }

    return () => {
      cancelled = true;
    };
  }, [keyMode, vault, activeStamp, providerKeyStore]);

  useEffect(() => {
    if (backgroundStamp === null) return;
    const store = providerKeyStore(backgroundStamp.mode, backgroundStamp.vault);
    const request = ++backgroundRequestRef.current;
    let cancelled = false;
    void store
      .get(backgroundStamp.keyRef)
      .then((secret) => {
        if (!cancelled && request === backgroundRequestRef.current)
          setBackgroundRead({ stamp: backgroundStamp, value: secret ?? '', error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled && request === backgroundRequestRef.current)
          setBackgroundRead({
            stamp: backgroundStamp,
            value: '',
            error: error instanceof Error ? error.message : String(error),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [backgroundStamp, providerKeyStore]);

  const syncCredential = useCallback(
    async (
      profile: ProviderProfile,
      secret: string,
      guard?: {
        assertCurrent: () => Promise<void>;
        onWrite: (previous: ProviderCredential | undefined, next: ProviderCredential) => void;
      },
    ): Promise<void> => {
      if (db === null || sync.config === null || sync.status !== 'ready') return;
      if (secret.trim() === '') {
        await db.repository.deleteProviderCredential(profile.keyRef);
        sync.requestAutoSync();
        return;
      }

      const existing = (await db.repository.listProviderCredentials()).find((item) => item.id === profile.keyRef);
      const revision = newId();
      const encryptedSecret = await sync.sealSecret(profile.keyRef, revision, secret);
      if (encryptedSecret === null) return;
      await guard?.assertCurrent();
      const credential: ProviderCredential = {
        id: profile.keyRef,
        providerId: profile.id,
        revision,
        encryptedSecret,
        createdAt: existing?.createdAt ?? nowIso(),
        updatedAt: nowIso(),
        deletedAt: null,
      };
      guard?.onWrite(existing, credential);
      await db.repository.saveProviderCredential(credential);
      await guard?.assertCurrent();
      sync.requestAutoSync();
    },
    [db, sync.config, sync.requestAutoSync, sync.sealSecret, sync.status],
  );

  // effect 里要读「当前」配置与选中项，但不能把它们当依赖（审计 A10：那会读库 → set → 再触发）
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const lastSyncAt = sync.config?.lastSyncAt ?? null;
  const profilesLoaded = profiles.length > 0;
  const keysReady = !(keyMode === 'encrypted' && vault === null);

  /**
   * 账户同步接通（或又同步了一轮）后，把库里的配置列表读回来（审计 A10 拆分之一）。
   *
   * 以前这一步与凭据对齐写在同一个依赖 `profiles` 的 effect 里：每次从库里读出一个
   * **新数组**再 setProfiles，引用一变 effect 又跑，根组件无休止地重渲染、反复读库。
   * 现在只依赖「同步状态 / 最近一次同步时间」，并且内容一致时不 set。
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: lastSyncAt 是触发器——每同步一轮就把别的设备推来的配置读回来
  useEffect(() => {
    if (db === null || sync.status !== 'ready' || !keysReady || !profilesLoaded) return;
    let cancelled = false;

    void (async () => {
      const currentProfiles = profilesRef.current;
      const currentActive = activeIdRef.current;
      const remoteProfiles = await db.repository.listProviderProfiles();
      const remoteIds = new Set(remoteProfiles.map((profile) => profile.id));
      let nextActiveId =
        remoteProfiles.find((profile) => profile.active === true)?.id ??
        (currentActive !== null && remoteIds.has(currentActive) ? currentActive : (remoteProfiles[0]?.id ?? null));
      for (const localProfile of currentProfiles) {
        if (remoteIds.has(localProfile.id) || !isAutoCreatedDefault(localProfile)) continue;
        const localSecret = await keyStoreRef.current.get(localProfile.keyRef);
        if (localSecret !== null && localSecret !== '') continue;
        await db.repository.deleteProviderProfile(localProfile.id);
        if (nextActiveId === localProfile.id) nextActiveId = remoteProfiles[0]?.id ?? null;
      }
      if (cancelled) return;
      if (remoteProfiles.length > 0 && !sameProfiles(profilesRef.current, remoteProfiles)) {
        setProfiles(remoteProfiles);
      }
      if (nextActiveId !== activeIdRef.current) {
        invalidateKeyRead();
        setActiveId(nextActiveId);
        await db.repository.setMeta(META_ACTIVE_PROFILE, nextActiveId);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [db, keysReady, lastSyncAt, profilesLoaded, sync.status, invalidateKeyRead]);

  /**
   * 凭据对齐（审计 A10 拆分之二）：
   *
   * - 本机有 Key、账户里还没有密文：补一条加密凭据；
   * - 账户里有密文、本机没有缓存：解开并写回当前 KeyStore；
   * - 本机已有缓存：不回写，避免覆盖用户刚编辑的值。
   *
   * 它依赖 `profiles`，但自己**从不 setProfiles**，所以不会自激。
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: lastSyncAt 是触发器——同步拉来新凭据后要再对齐一次
  useEffect(() => {
    if (db === null || sync.status !== 'ready' || profiles.length === 0 || !keysReady) return;
    let cancelled = false;
    const store = providerKeyStore(keyMode, vault);

    void (async () => {
      const credentials = await db.repository.listProviderCredentials();
      const byId = new Map(credentials.map((credential) => [credential.id, credential]));
      for (const profile of profiles) {
        if (cancelled) return;
        const setupRevision = setupRevisionRef.current;
        const local = await store.get(profile.keyRef);
        if (cancelled) return;
        if (setupRevision !== setupRevisionRef.current) continue;
        // The setup operation owns this ref until its scope checks and reread finish.
        if (setupSavingRef.current && setupTargetRef.current?.target.keyRef === profile.keyRef) continue;
        if (local !== null && local !== '') {
          if (!byId.has(profile.keyRef)) await syncCredential(profile, local);
          continue;
        }

        const credential = byId.get(profile.keyRef);
        if (credential === undefined) continue;
        const opened = await sync.openSecret(profile.keyRef, credential.revision, credential.encryptedSecret);
        if (cancelled) return;
        if (
          setupRevision !== setupRevisionRef.current ||
          (setupSavingRef.current && setupTargetRef.current?.target.keyRef === profile.keyRef)
        )
          continue;
        if (opened === null || opened === '') continue;
        await store.set(profile.keyRef, opened);
        if (cancelled) return;
        if (
          activeStamp !== null &&
          profile.id === activeStamp.profileId &&
          sameKeyStamp(activeStamp, activeStampRef.current)
        ) {
          keyRequestRef.current += 1;
          const read = { stamp: activeStamp, value: opened, error: null };
          keyReadRef.current = read;
          setKeyRead(read);
        }
        if (backgroundStamp !== null && profile.id === backgroundStamp.profileId) {
          publishBackgroundKey(backgroundStamp, opened);
        }
      }
    })().catch(() => {
      // 当前配置的本机读取错误由上面的 Key 加载状态显示；同步不把失败冒充空 Key。
    });

    return () => {
      cancelled = true;
    };
  }, [
    db,
    keysReady,
    keyMode,
    vault,
    activeStamp,
    backgroundStamp,
    lastSyncAt,
    profiles,
    sync.openSecret,
    sync.status,
    syncCredential,
    providerKeyStore,
    publishBackgroundKey,
  ]);

  /**
   * 解开本机的口令库（顺序 10）。
   *
   * 解开之后把 KeyStore 换成库里的那份，界面上的「已连接」状态跟着变——
   * 这一条与「存进去」是两件事：库在盘上，钥匙在口令里。
   */
  const unlockVault = useCallback(
    async (passphrase: string) => {
      const opened = await openBrowserVault(passphrase);
      invalidateKeyRead();
      setVault(opened);
      setVaultExists(true);
    },
    [invalidateKeyRead],
  );

  const selectProfile = useCallback(
    async (id: string) => {
      if (id !== activeId) invalidateKeyRead();
      setActiveId(id);
      await db?.repository.setMeta(META_ACTIVE_PROFILE, id);
      const next = profiles.map((profile) =>
        profile.active === (profile.id === id) ? profile : { ...profile, active: profile.id === id },
      );
      setProfiles(next);
      for (const profile of next) {
        const previous = profiles.find((item) => item.id === profile.id);
        if (previous?.active === profile.active) continue;
        await db?.repository.saveProviderProfile(profile);
      }
    },
    [activeId, db, profiles, invalidateKeyRead],
  );

  const addProfile = useCallback(
    async (input: CreateProviderProfileInput) => {
      if (!db) return;
      const created = { ...createProviderProfile(input), active: true };
      for (const profile of profiles.filter((item) => item.active === true)) {
        await db.repository.saveProviderProfile({ ...profile, active: false });
      }
      await db.repository.saveProviderProfile(created);
      await refresh();
      await selectProfile(created.id);
    },
    [db, profiles, refresh, selectProfile],
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
      requireKeyReady(activeStamp);
      const profile = profiles.find((item) => item.id === activeId);
      if (!profile) return;

      if (value === '') {
        await keyStoreRef.current.remove(profile.keyRef);
        if (activeStamp !== null) publishActiveKey(activeStamp, '');
        await syncCredential(profile, '');
        return;
      }
      await keyStoreRef.current.set(profile.keyRef, value);
      if (activeStamp !== null) publishActiveKey(activeStamp, value);
      await syncCredential(profile, value);
    },
    [activeId, activeStamp, profiles, syncCredential, requireKeyReady, publishActiveKey],
  );

  const saveDeepSeekKey = useCallback(
    async (value: string, expectedOwner: DeepSeekSetupOwner) => {
      const key = value.trim();
      let scopeChanged = false;
      const rejectScope = () => {
        scopeChanged = true;
        throw new Error('配置目标已变化，请关闭后重新配置。');
      };
      const assertOwner = () => {
        if (!db || expectedOwner?.token !== setupOwnerRef.current?.token) rejectScope();
      };
      assertOwner();
      requireKeyReady(activeStamp);
      if (!key.startsWith('sk-') || key.length <= 3 || /\s/.test(key))
        throw new Error('请粘贴完整的 DeepSeek API Key。');
      if (setupSavingRef.current) throw new Error('正在保存 API Key，请等待完成。');
      const source = profiles.find((profile) => profile.id === expectedOwner.profileId);
      if (!db || !source) throw new Error('当前模型配置不可用，请重新读取。');
      const database = db;
      const store = keyStoreRef.current;
      const target =
        setupTargetRef.current?.owner.token === expectedOwner.token
          ? setupTargetRef.current.target
          : isDeepSeekProfile(source)
            ? source
            : { ...createProviderProfile(DEFAULT_PROFILE), active: false };
      setupTargetRef.current = { owner: expectedOwner, target };
      setupSavingRef.current = true;
      setupRevisionRef.current += 1;
      const assertProfiles = async (targetRequired = true, repository = database.repository) => {
        assertOwner();
        const current = await repository.listProviderProfiles();
        assertOwner();
        const savedSource = current.find((profile) => profile.id === source.id);
        const savedTarget = current.find((profile) => profile.id === target.id);
        if (
          savedSource?.keyRef !== source.keyRef ||
          savedSource.baseUrl !== source.baseUrl ||
          (targetRequired && (savedTarget?.keyRef !== target.keyRef || savedTarget.baseUrl !== target.baseUrl))
        )
          rejectScope();
        return current;
      };
      let previousKey: string | null = null;
      let wroteKey = false;
      let credentialWrite: { previous: ProviderCredential | undefined; next: ProviderCredential } | null = null;
      try {
        const initial = await assertProfiles(false);
        if (target.id !== source.id && !initial.some((item) => item.id === target.id)) {
          await database.repository.saveProviderProfile(target);
        }
        await assertProfiles();
        previousKey = await store.get(target.keyRef);
        await assertProfiles();
        await store.set(target.keyRef, key);
        wroteKey = true;
        await assertProfiles();
        if ((await store.get(target.keyRef)) !== key) throw new Error('API Key 保存结果未确认，请核对后重试。');
        await assertProfiles();
        await syncCredential(target, key, {
          assertCurrent: async () => {
            await assertProfiles();
          },
          onWrite: (previous, next) => {
            credentialWrite = { previous, next };
          },
        });
        await assertProfiles();
        if (target.id === source.id) {
          if (activeStamp !== null) publishActiveKey(activeStamp, key);
        } else {
          // Profile fields and active selection must come from the same storage snapshot.
          const next = await database.repository.atomic(async (repository) => {
            const current = await assertProfiles(true, repository);
            const selected = current.map((profile) => ({ ...profile, active: profile.id === target.id }));
            for (const profile of selected) {
              assertOwner();
              if (current.find((item) => item.id === profile.id)?.active !== profile.active)
                await repository.saveProviderProfile(profile);
            }
            assertOwner();
            await repository.setMeta(META_ACTIVE_PROFILE, target.id);
            assertOwner();
            return selected;
          });
          await assertProfiles();
          invalidateKeyRead();
          setProfiles(next);
          setActiveId(target.id);
        }
        return { profileId: target.id, keyRef: target.keyRef, baseUrl: target.baseUrl };
      } catch (reason) {
        if (scopeChanged && wroteKey) {
          try {
            // Do not overwrite a newer write from another operation during cleanup.
            if ((await store.get(target.keyRef)) === key) {
              if (previousKey === null) await store.remove(target.keyRef);
              else await store.set(target.keyRef, previousKey);
            }
            // The callback runs before the async credential write and captures its revision.
            const attempted = credentialWrite as {
              previous: ProviderCredential | undefined;
              next: ProviderCredential;
            } | null;
            if (attempted !== null) {
              const current = (await database.repository.listProviderCredentials()).find(
                (item) => item.id === target.keyRef,
              );
              if (current?.revision === attempted.next.revision) {
                if (attempted.previous) await database.repository.saveProviderCredential(attempted.previous);
                else await database.repository.deleteProviderCredential(target.keyRef);
              }
            }
          } catch {
            throw new Error('配置目标已变化，保存未完成。请关闭后检查对应配置的密钥。');
          }
        }
        throw reason;
      } finally {
        setupSavingRef.current = false;
        setupRevisionRef.current += 1;
      }
    },
    [db, activeStamp, profiles, requireKeyReady, syncCredential, publishActiveKey, invalidateKeyRead],
  );

  const setKeyMode = useCallback(
    async (mode: KeyStorageMode) => {
      if (mode === keyMode) return;
      invalidateKeyRead();
      setKeyModeState(mode);
      await db?.repository.setMeta(META_KEY_MODE, mode);
    },
    [db, keyMode, invalidateKeyRead],
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
      requireKeyReady(activeStamp);

      const errors = providerNumericErrors({ ...profile, ...input.profile });
      if (Object.keys(errors).length > 0) throw new Error(Object.values(errors).join(' '));

      /*
       * 口令加密那一档（顺序 10）：先把库备好，再往里写。
       *
       * 「新建库」与「解锁已有库」在用户眼里是同一件事（都在这一句口令上），
       * 所以这里自动分流：本机还没有库就用这句口令建一个，已经有了就用它解锁。
       * 口令不对就抛出去——宁可让用户再打一遍，也不能把 Key 写进一个解不开的库。
       */
      let target: KeyStore | null = null;
      let targetVault = vault;
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
        targetVault = opened;
        target = opened.store;
      }

      // 先按目标档位把密钥写好，再切换档位：KeyStore 的重建发生在下次渲染之后，
      // 直接调用 setApiKey 会写进旧的存储实例
      const store = target ?? providerKeyStore(input.keyMode);
      if (input.apiKey.trim() === '') await store.remove(profile.keyRef);
      else await store.set(profile.keyRef, input.apiKey);

      // A 的保存可以完成其自身写入，但不能把晚到结果发布到已选中的 B。
      // 档位是账户级状态；切换途中也不能让旧操作改变新配置的缓存方式。
      const stillCurrent = sameKeyStamp(activeStamp, activeStampRef.current);
      if (!stillCurrent && input.keyMode !== keyMode)
        throw new Error('保存期间当前模型配置已变化，缓存方式未切换。请重新打开对应配置检查后保存。');

      if (input.keyMode !== keyMode) {
        /*
         * 离开「明文存在本机」这一档时，顺手把明文那份删掉：
         * 否则用户以为已经收回了（换成密文 / 只留内存），磁盘上其实还留着。
         */
        if (keyMode === 'device') await createBrowserKeyStore('device').remove(profile.keyRef);
        if (!sameKeyStamp(activeStamp, activeStampRef.current))
          throw new Error('保存期间当前模型配置已变化，缓存方式未切换。请重新打开对应配置检查后保存。');
        await db.repository.setMeta(META_KEY_MODE, input.keyMode);
        // 档位属于整个账户，落库成功后保持状态一致；当前配置的 Key 由读取 effect 获取。
        setKeyModeState(input.keyMode);
      }

      if (sameKeyStamp(activeStamp, activeStampRef.current)) {
        keyStoreRef.current = store;
        setKeyKind(store.kind);
        if (targetVault !== vault) {
          setVault(targetVault);
          setVaultExists(true);
        }
      }
      if (activeStamp !== null && input.keyMode === keyMode && targetVault === vault)
        publishActiveKey(activeStamp, input.apiKey);
      // 更换档位／解锁后由身份不同的读取 effect 从同一个 store 重读。
      await updateProfile(profile.id, input.profile);
      await syncCredential(profile, input.apiKey);
    },
    [
      activeId,
      activeStamp,
      db,
      keyMode,
      profiles,
      syncCredential,
      updateProfile,
      requireKeyReady,
      vault,
      providerKeyStore,
      publishActiveKey,
    ],
  );

  /**
   * 后台任务用的配置：有标了「只用于后台」的就用它，否则退回当前配置。
   * 单独 memo：它是 worker 的依赖，每次渲染新造一个对象会让 worker 的 effect 反复重挂。
   */
  const background = useMemo<ProvidersApi['background']>(() => {
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
  }, [activeId, apiKey, backgroundKey, profiles]);

  // 返回对象要稳定（顺序 59）：App 里一串 useCallback 拿它当依赖
  return useMemo(
    () => ({
      profiles,
      setupOwner,
      saveDeepSeekKey,
      activeId,
      active: profiles.find((item) => item.id === activeId) ?? null,
      apiKey,
      keyLoading,
      keyError,
      reloadApiKey,
      keyMode,
      keyKind,
      vaultExists,
      vaultLocked: keyMode === 'encrypted' && vault === null,
      unlockVault,
      background,
      selectProfile,
      addProfile,
      updateProfile,
      deleteProfile,
      setApiKey,
      setKeyMode,
      commitConfig,
    }),
    [
      setupOwner,
      saveDeepSeekKey,
      activeId,
      addProfile,
      apiKey,
      keyLoading,
      keyError,
      reloadApiKey,
      background,
      commitConfig,
      deleteProfile,
      keyKind,
      keyMode,
      profiles,
      selectProfile,
      setApiKey,
      setKeyMode,
      unlockVault,
      updateProfile,
      vault,
      vaultExists,
    ],
  );
}
