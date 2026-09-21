import {
  createAutoSync,
  createHttpSyncTransport,
  createRemoteSpace,
  createSpaceCredentials,
  decryptRecord,
  deriveSpaceHandle,
  type EncryptedRecord,
  encryptRecord,
  fetchRemoteSpace,
  normalizeRecoveryCode,
  openSpace,
  type RemoteSpaceMeta,
  rotatePassword as rotateSpacePassword,
  runSync,
  type SyncDeviceSummary,
  type SyncPulledRecord,
  type SyncReport,
} from '@dramatis/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type DramatisDb, readActiveAccount } from './db';
import { createBrowserFileIO } from './fileio';
import { createBrowserKeyStore, type KeyStorageMode } from './keystore';
import { buildSnapshot, parseSnapshot, type ServerSnapshot, snapshotFileName } from './snapshot';

/**
 * 多设备同步的会话层（P2-6 第四步·界面）。
 *
 * 它把内核的三块拼起来给界面用：
 *
 * ```
 * 用户填：服务端地址 + 用户 id + 同步密码（或恢复码）
 *   → 算空间句柄 → 问服务端「这个空间存在吗」
 *       不存在：建空间（显示一次恢复码）→ 两份钥匙封装存到服务端
 *       已存在：取回「包起来的主密钥」→ 用密码解开 → 拿到 encKey
 *   → runSync（推 / 拉 / 合并）
 * ```
 *
 * 密码存哪，按设置里的「保存方式」走，与模型 API Key 完全一致：
 * `session` = 只在内存里（关掉页面要重填）；`device` = 明文存在本机浏览器
 * （不参与同步，换设备要重填）。**密码永远不会发给服务端**——服务端只拿到
 * 它的哈希（做凭证校验用）。
 */

const META_CONFIG = 'sync.config';
const LEGACY_SYNC_PASSWORD_KEY_REF = 'sync:password';

/**
 * 同步密码的本机缓存必须按账户分开。
 *
 * A1 之后一个账户一条同步空间；如果仍共用 `sync:password`，先连 A、再连 B
 * 就会把 A 的密码覆盖掉，切回 A 时自动同步必然失败。键里带上内部 storageId，
 * 并在首次读取时把旧版全局键迁移到当前账户。
 */
export function syncPasswordKeyRef(accountId: string): string {
  return `${LEGACY_SYNC_PASSWORD_KEY_REF}:${accountId}`;
}

/**
 * 两次自动同步之间的最小间隔。
 *
 * 一轮对话会连着写好几次（消息、记忆、情绪、账单），每次都推就是白跑流量；
 * 但间隔又不能太长——用户聊完就想在手机上看到。20 秒是「刚聊完这一轮的内容
 * 基本都落库了」与「不至于每次都推」之间的折中。
 */
const AUTO_SYNC_INTERVAL_MS = 20_000;

/** 定期同步的心跳间隔：5 分钟。 */
const AUTO_SYNC_HEARTBEAT_MS = 5 * 60 * 1000;

export interface SyncConfig {
  endpoint: string;
  userId: string;
  spaceHandle: string;
  keyMode: KeyStorageMode;
  createdAt: string;
  lastSyncAt: string | null;
  lastReport: SyncReport | null;
  /** 上次把「服务端那份」存成本机文件的时间（顺序 17 的每日提醒用）。 */
  lastSnapshotAt?: string | null;
}

/** 运行时才有的东西：凭证与主密钥（都不落盘）。 */
interface SyncSession {
  credential: string;
  encKey: CryptoKey;
}

export type SyncStatus = 'off' | 'ready' | 'needs-secret' | 'error';

export interface SyncConnectInput {
  endpoint: string;
  userId: string;
  /** 同步密码，或者恢复码（两者等价）。 */
  secret: string;
  keyMode: KeyStorageMode;
}

export interface SyncApi {
  config: SyncConfig | null;
  status: SyncStatus;
  busy: boolean;
  error: string | null;
  /** 建空间时显示**一次**的恢复码；界面必须让用户抄下来。 */
  recoveryCode: string | null;
  dismissRecoveryCode: () => void;
  connect: (input: SyncConnectInput) => Promise<void>;
  syncNow: () => Promise<void>;
  /**
   * 把本地游标清回去，重新完整拉一遍（**修分页漏拉用的逃生口**）。
   *
   * 一页装不下的空间在旧版本客户端上会「同步成功但只拉到一部分」，而本地游标
   * 已经被推到末尾——升级之后光靠再同步是拉不回来的，得先把这个游标清掉。
   * 清的是「拉到哪儿」这一个数字，不动本地数据，也不动服务端。
   */
  resync: () => Promise<void>;
  /**
   * 每轮对话结束后的自动同步（P2-6 的收尾项）。
   *
   * 调用它本身不阻塞也不抛错：排进节流窗口，能跑就跑，跑失败只记在「上次结果」里。
   */
  requestAutoSync: () => void;
  /** 有没有排着队的自动同步，界面用它显示「本轮会自动推」。 */
  autoSyncPending: boolean;
  disconnect: () => Promise<void>;
  /** 切换「保存方式」（把密码在内存版与本地版之间搬一次）。 */
  setKeyMode: (mode: KeyStorageMode) => Promise<void>;
  /** 这个空间最近有哪些设备在写（顺序 14）。本机那台的号也一并给出来，界面好标「这台」。 */
  listDevices: () => Promise<{ devices: SyncDeviceSummary[]; localDeviceId: string }>;
  /**
   * 换同步密码（顺序 15）。
   *
   * 语义要说清楚：换完之后**只知道旧密码的设备再也同步不了**——
   * 这就是「断开一台设备」的真实做法。本机不用重连（凭证与主密钥都还在手上），
   * 但下一次在新设备上要用新密码。
   */
  rotatePassword: (newPassword: string) => Promise<void>;
  /** 服务端上的这个空间已经存满（撞过 413）。界面据此**一直**提示，直到真的推进去东西。 */
  spaceFull: boolean;
  /**
   * 把服务端上那份**原文**（密文 + 坐标）拉全并存成一个文件（顺序 17）。
   *
   * 为什么不是「拉回来写进本地库」：那正是同步在做的事。这里要的是一份
   * **能拿在手里的副本**——服务端被清空时它可以灌回去（`restoreSnapshot`）。
   * 用户取消保存时返回 null。
   */
  exportSnapshot: () => Promise<{ records: number; bytes: number; name: string } | null>;
  /** 把一份快照灌回**当前**服务端（服务端被清空后的恢复路）。 */
  restoreSnapshot: (snapshot: ServerSnapshot) => Promise<{ pushed: number; head: number }>;
  /** 把一条账户秘密封进同步主密钥，供账户内实体携带。 */
  sealSecret: (id: string, revision: string, secret: string) => Promise<EncryptedRecord | null>;
  /** 解开账户内携带的秘密；还没解锁同步时返回 null。 */
  openSecret: (id: string, revision: string, sealed: EncryptedRecord) => Promise<string | null>;
}

function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed === '') throw new Error('请填服务端地址（例如 https://dramatis-sync.xxx.ts.net）。');
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('服务端地址要以 http:// 或 https:// 开头。');
  }
  return trimmed;
}

/**
 * 用密码或恢复码解开主密钥。
 *
 * 先按「密码」试，失败再按「恢复码」试——用户不需要告诉应用他手里拿的是哪一个
 * （恢复码就是忘了密码时的等价凭证，见 SYNC §3.1）。两次都失败时抛后一个错，
 * 那句话是「解不开主密钥：密码（或恢复码）不对」，正好对用户说。
 */
async function openWithSecret(
  meta: RemoteSpaceMeta,
  secret: string,
): Promise<{ credential: string; encKey: CryptoKey }> {
  const byPassword = meta.keyWraps.password;
  if (byPassword !== undefined) {
    try {
      const opened = await openSpace({
        spaceHandle: meta.spaceHandle,
        secret,
        purpose: 'password',
        wrapped: byPassword as never,
      });
      return { credential: opened.credential, encKey: opened.encKey };
    } catch {
      // 落到恢复码那条路
    }
  }

  const opened = await openSpace({
    spaceHandle: meta.spaceHandle,
    secret: normalizeRecoveryCode(secret),
    purpose: 'recovery',
    wrapped: meta.keyWraps.recovery as never,
  });
  return { credential: opened.credential, encKey: opened.encKey };
}

export function useSync(db: DramatisDb | null, options: { onChanged?: () => void } = {}): SyncApi {
  const [config, setConfig] = useState<SyncConfig | null>(null);
  const [status, setStatus] = useState<SyncStatus>('off');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [autoSyncPending, setAutoSyncPending] = useState(false);
  /**
   * 这个空间在服务端上已经存满（顺序 17 演练发现的洞）。
   *
   * 为什么单独记一个状态、而不是复用 `error`：护栏撞满之后，**接下来几次同步很可能
   * 是「成功的」**（没有新东西要推，服务端也不检查），于是 `setError(null)` 会把那条
   * 提示清掉——用户看到的画面就变成「一切正常」，而实际上数据再也推不上去了。
   * 所以它只在「真的推进去东西」之后才清除。
   */
  const [spaceFull, setSpaceFull] = useState(false);

  const sessionRef = useRef<SyncSession | null>(null);
  const configRef = useRef<SyncConfig | null>(null);
  const keyModeRef = useRef<KeyStorageMode>('session');
  const passwordRef = syncPasswordKeyRef(readActiveAccount().id);

  // 同步写完库之后要有人告诉界面「重新读一遍」——否则用户会以为
  // 「同步成功了但什么都没来」。用 ref 跟随，避免把 drain 变成依赖泥球。
  const onChangedRef = useRef(options.onChanged);
  onChangedRef.current = options.onChanged;

  const remember = useCallback(
    async (next: SyncConfig, secret: string | null): Promise<void> => {
      configRef.current = next;
      setConfig(next);
      if (db === null) return;
      await db.repository.setMeta(META_CONFIG, next);
      if (secret !== null) await createBrowserKeyStore(next.keyMode).set(passwordRef, secret);
    },
    [db, passwordRef],
  );

  const doSync = useCallback(
    async (current: SyncConfig, session: SyncSession): Promise<SyncReport> => {
      if (db === null) throw new Error('数据库还没准备好。');
      const report = await runSync({
        repository: db.repository,
        transport: createHttpSyncTransport({ endpoint: current.endpoint }),
        spaceHandle: current.spaceHandle,
        credential: session.credential,
        encKey: session.encKey,
      }).catch((error: unknown) => {
        // 撞上服务端护栏：记下来，界面会一直提示到真的恢复为止
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('存满')) setSpaceFull(true);
        throw error;
      });

      if (report.pushed > 0) setSpaceFull(false);

      const updated: SyncConfig = {
        ...current,
        lastSyncAt: new Date().toISOString(),
        lastReport: report,
      };
      await remember(updated, null);
      onChangedRef.current?.();
      return report;
    },
    [db, remember],
  );

  // ---- 启动：读配置，能自动登录就自动同步一次 ----
  useEffect(() => {
    if (db === null) return;
    let cancelled = false;

    void (async () => {
      try {
        const stored = await db.repository.getMeta<SyncConfig>(META_CONFIG);
        if (stored === null || cancelled) return;

        keyModeRef.current = stored.keyMode;
        configRef.current = stored;

        /*
         * 先迁移旧版全局同步密码，再更新 React 状态。
         *
         * StrictMode / 并发渲染下，setState 可能让这次 effect 很快进入清理；
         * 把本机迁移放到 setState 之前，才能保证旧用户第一次打开就一定迁移。
         */
        const store = createBrowserKeyStore(stored.keyMode);
        let secret = await store.get(passwordRef);
        if (secret === null) {
          const legacy = await store.get(LEGACY_SYNC_PASSWORD_KEY_REF);
          if (legacy !== null) {
            await store.set(passwordRef, legacy);
            await store.remove(LEGACY_SYNC_PASSWORD_KEY_REF);
            secret = legacy;
          }
        }
        if (cancelled) return;
        setConfig(stored);
        if (secret === null) {
          // 密码没存（用户选了"仅本次会话"，或者换了设备）
          if (!cancelled) setStatus('needs-secret');
          return;
        }

        const meta = await fetchRemoteSpace({ endpoint: stored.endpoint }, stored.spaceHandle);
        if (meta === null) throw new Error('服务端上没有这个空间了（也许数据被清过）。');
        const session = await openWithSecret(meta, secret);
        if (cancelled) return;

        sessionRef.current = session;
        setStatus('ready');
        await doSync(stored, session);
      } catch (syncError) {
        if (cancelled) return;
        setStatus('error');
        setError(syncError instanceof Error ? syncError.message : String(syncError));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [db, doSync, passwordRef]);

  const connect = useCallback(
    async (input: SyncConnectInput): Promise<void> => {
      if (db === null) throw new Error('数据库还没准备好。');
      setBusy(true);
      setError(null);
      try {
        const endpoint = normalizeEndpoint(input.endpoint);
        const secret = input.secret.trim();
        if (secret === '') throw new Error('请填同步密码（已建过空间的话，也可以填恢复码）。');

        const spaceHandle = await deriveSpaceHandle(input.userId);
        const meta = await fetchRemoteSpace({ endpoint }, spaceHandle);

        let session: SyncSession;
        let createdCode: string | null = null;

        if (meta === null) {
          // 服务端上还没有这个空间 → 建一个（并把两份钥匙封装交给服务端保管）
          const created = await createSpaceCredentials({ userId: input.userId, password: secret });
          const registered = await createRemoteSpace(
            { endpoint },
            {
              spaceHandle: created.spaceHandle,
              credentialHash: created.credentialHash,
              recoveryCredentialHash: created.recoveryCredentialHash,
              keyWraps: { password: created.passwordWrap, recovery: created.recoveryWrap },
            },
          );
          if (registered === 'exists') {
            // 刚好被别人抢先建了同一个 id：按"加入"处理，不能覆盖别人的空间
            const fresh = await fetchRemoteSpace({ endpoint }, spaceHandle);
            if (fresh === null) throw new Error('这个 id 刚被占用，但取不到空间信息，稍后再试。');
            session = await openWithSecret(fresh, secret);
          } else {
            session = { credential: created.credential, encKey: created.encKey };
            createdCode = created.recoveryCode;
          }
        } else {
          session = await openWithSecret(meta, secret);
        }

        keyModeRef.current = input.keyMode;
        const next: SyncConfig = {
          endpoint,
          userId: input.userId.trim(),
          spaceHandle,
          keyMode: input.keyMode,
          createdAt: configRef.current?.createdAt ?? new Date().toISOString(),
          lastSyncAt: configRef.current?.lastSyncAt ?? null,
          lastReport: configRef.current?.lastReport ?? null,
        };
        await remember(next, secret);

        sessionRef.current = session;
        setRecoveryCode(createdCode);
        setStatus('ready');
        await doSync(next, session);
      } catch (connectError) {
        setStatus('error');
        const message = connectError instanceof Error ? connectError.message : String(connectError);
        setError(message);
        throw connectError;
      } finally {
        setBusy(false);
      }
    },
    [db, doSync, remember],
  );

  const syncNow = useCallback(async (): Promise<void> => {
    const current = configRef.current;
    const session = sessionRef.current;
    setBusy(true);
    setError(null);
    try {
      if (current === null || session === null) {
        setStatus('needs-secret');
        throw new Error('需要先填同步密码（或恢复码）再同步一次。');
      }
      await doSync(current, session);
      setStatus('ready');
    } catch (syncError) {
      setStatus('error');
      const message = syncError instanceof Error ? syncError.message : String(syncError);
      setError(message);
      throw syncError;
    } finally {
      setBusy(false);
    }
  }, [doSync]);

  const disconnect = useCallback(async (): Promise<void> => {
    if (db === null) return;
    await db.repository.setMeta(META_CONFIG, null);
    await createBrowserKeyStore(keyModeRef.current).remove(passwordRef);
    sessionRef.current = null;
    configRef.current = null;
    setConfig(null);
    setStatus('off');
    setError(null);
    setRecoveryCode(null);
  }, [db, passwordRef]);

  const setKeyMode = useCallback(
    async (mode: KeyStorageMode): Promise<void> => {
      const current = configRef.current;
      if (db === null || current === null) return;
      const store = createBrowserKeyStore(keyModeRef.current);
      const secret = await store.get(passwordRef);

      keyModeRef.current = mode;
      if (secret !== null) await createBrowserKeyStore(mode).set(passwordRef, secret);
      // 从"保存在本机"切回"仅本次会话"时，把落盘那份清掉——否则用户以为收回了，磁盘上还在
      if (mode === 'session') await store.remove(passwordRef);

      await remember({ ...current, keyMode: mode }, null);
    },
    [db, passwordRef, remember],
  );

  const sealSecret = useCallback(
    async (id: string, revision: string, secret: string): Promise<EncryptedRecord | null> => {
      const current = configRef.current;
      const session = sessionRef.current;
      if (current === null || session === null) return null;
      return encryptRecord(
        session.encKey,
        { spaceHandle: current.spaceHandle, collection: 'providerCredentials', id, updatedAt: revision },
        { secret },
      );
    },
    [],
  );

  const openSecret = useCallback(
    async (id: string, revision: string, sealed: EncryptedRecord): Promise<string | null> => {
      const current = configRef.current;
      const session = sessionRef.current;
      if (current === null || session === null) return null;
      const opened = await decryptRecord<{ secret?: unknown }>(
        session.encKey,
        { spaceHandle: current.spaceHandle, collection: 'providerCredentials', id, updatedAt: revision },
        sealed,
      );
      return typeof opened.secret === 'string' ? opened.secret : null;
    },
    [],
  );

  /**
   * 这个空间最近有哪些设备在写（顺序 14）。
   *
   * 顺带把**本机**的 deviceId 一起给出来：界面要标「这台」（不然一串 uuid
   * 用户根本认不出自己）。
   */
  const listDevices = useCallback(async () => {
    const current = configRef.current;
    const session = sessionRef.current;
    if (db === null || current === null || session === null) throw new Error('先连上同步，才能看设备列表。');

    const transport = createHttpSyncTransport({ endpoint: current.endpoint });
    if (transport.devices === undefined) throw new Error('这个客户端版本不支持设备列表。');
    const { devices } = await transport.devices({
      spaceHandle: current.spaceHandle,
      credential: session.credential,
    });
    return { devices, localDeviceId: await db.repository.deviceId() };
  }, [db]);

  /**
   * 换同步密码（顺序 15）。
   *
   * 三件事按顺序做，顺序不能反：
   * 1. 用**服务端上那份封装**把主密钥解出来（本机可能已经拿着，但重新解一次最稳）；
   * 2. 用新密码重新包装、算出新凭证与哈希；
   * 3. 先让服务端换掉（此刻旧密码失效），再更新本机存的那份密码。
   *
   * 第 3 步里「先服务端后本机」是刻意的：服务端换成功、本机存密码失败时，
   * 用户手里还有新密码可以重填；反过来就会出现「本机以为换了、服务端还是旧的」。
   */
  const rotatePassword = useCallback(
    async (newPassword: string): Promise<void> => {
      const current = configRef.current;
      const session = sessionRef.current;
      if (db === null || current === null || session === null) throw new Error('先连上同步，才能换密码。');
      if (newPassword.trim().length < 6) throw new Error('新密码太短了，至少 6 位（它要挡住猜密码的人）。');

      const rotated = await rotateSpacePassword({
        spaceHandle: current.spaceHandle,
        encKey: session.encKey,
        newPassword,
      });

      const transport = createHttpSyncTransport({ endpoint: current.endpoint });
      if (transport.rotate === undefined) throw new Error('这台服务端的版本还不支持换密码，请先更新服务端。');
      await transport.rotate({
        spaceHandle: current.spaceHandle,
        credential: session.credential,
        credentialHash: rotated.credentialHash,
        passwordWrap: rotated.passwordWrap,
      });

      // 服务端换完了：本机的凭证与密码都要跟着换，否则下一次同步自己就 401 了
      sessionRef.current = { credential: rotated.credential, encKey: session.encKey };
      await remember({ ...current, lastReport: current.lastReport }, newPassword);
      await createBrowserKeyStore(current.keyMode).set(passwordRef, newPassword);
    },
    [db, passwordRef, remember],
  );

  /**
   * 把服务端那份拉全（分页拉到追平）并存成一个文件（顺序 17）。
   *
   * 这里刻意**不复用 `runSync`**：那条路会顺手把记录写进本地库、还会推进游标，
   * 而我们要的只是「服务端此刻的原文」——拿去做副本，不碰本地状态。
   */
  const exportSnapshot = useCallback(async () => {
    const current = configRef.current;
    const session = sessionRef.current;
    if (db === null || current === null || session === null) throw new Error('先连上同步，才能存服务端快照。');

    const transport = createHttpSyncTransport({ endpoint: current.endpoint });
    const records: SyncPulledRecord[] = [];
    let cursor = 0;
    let serverHead = 0;
    for (let round = 0; round < 200; round += 1) {
      const page = await transport.pull({
        spaceHandle: current.spaceHandle,
        credential: session.credential,
        since: cursor,
        limit: 500,
      });
      records.push(...page.records);
      serverHead = Math.max(serverHead, page.serverHead ?? page.head);
      const last = page.records[page.records.length - 1];
      cursor = last === undefined ? page.head : last.serverRev;
      if (page.records.length === 0) break;
      if ((page.hasMore ?? cursor < serverHead) !== true) break;
    }

    const snapshot = buildSnapshot({
      spaceHandle: current.spaceHandle,
      deviceId: await db.repository.deviceId(),
      head: serverHead,
      records,
    });
    const saved = await createBrowserFileIO().save(
      snapshotFileName(snapshot),
      new TextEncoder().encode(JSON.stringify(snapshot, null, 2)),
      { mime: 'application/json' },
    );
    if (!saved.saved) return null;

    await remember({ ...current, lastSnapshotAt: snapshot.takenAt }, null);
    return { records: records.length, bytes: saved.bytes, name: saved.name };
  }, [db, remember]);

  /**
   * 把一份快照灌回当前服务端（顺序 17 的恢复路）。
   *
   * 三条约束：① 只灌**属于这个空间**的记录（快照里带着句柄，对不上就拒）；
   * ② 分批推（一次 200 条，与服务端的上限对齐）；③ 不做任何解密——
   * 密文原样搬回去，所以哪怕密码已经忘了、只要有恢复码照样能再读出来。
   */
  const restoreSnapshot = useCallback(async (snapshot: ServerSnapshot): Promise<{ pushed: number; head: number }> => {
    const current = configRef.current;
    const session = sessionRef.current;
    if (current === null || session === null) throw new Error('先连上同步，才能把快照灌回去。');
    if (snapshot.spaceHandle !== current.spaceHandle) {
      throw new Error('这份快照是别的空间的（句柄对不上），不能灌到这里。');
    }

    const transport = createHttpSyncTransport({ endpoint: current.endpoint });
    let pushed = 0;
    let head = 0;
    for (let offset = 0; offset < snapshot.records.length; offset += 200) {
      const batch = snapshot.records.slice(offset, offset + 200).map((record) => ({
        collection: record.collection,
        id: record.id,
        updatedAt: record.updatedAt,
        deletedAt: record.deletedAt,
        sealed: record.sealed,
        ...(record.deviceId === undefined ? {} : { deviceId: record.deviceId }),
      }));
      const result = await transport.push({
        spaceHandle: current.spaceHandle,
        credential: session.credential,
        baseHead: head,
        records: batch,
      });
      pushed += batch.length;
      head = result.head;
    }
    return { pushed, head };
  }, []);

  /**
   * 自动同步（每轮结束）。
   *
   * 与手动同步共用同一条推送路径（`doSync`），区别只有两点：不给界面加
   * busy（一轮一转头整个面板都在转圈很吵），以及失败不抛错——失败会记进
   * 「上次结果」，让用户看得见并自己决定要不要重试。
   */
  const quietRunRef = useRef<() => Promise<void>>(async () => {});
  const autoRef = useRef<ReturnType<typeof createAutoSync> | null>(null);

  quietRunRef.current = async (): Promise<void> => {
    const current = configRef.current;
    const session = sessionRef.current;
    if (db === null || current === null || session === null) return;
    await doSync(current, session);
  };

  if (autoRef.current === null) {
    autoRef.current = createAutoSync({
      // 没连上（没配置 / 没解锁）时静默跳过：每轮都在面板上留一条错没有意义
      run: async () => {
        if (configRef.current === null || sessionRef.current === null) return;
        await quietRunRef.current();
      },
      intervalMs: AUTO_SYNC_INTERVAL_MS,
      onResult: (result) => {
        setError(result.ok ? null : result.error);
      },
      onBusyChange: setAutoSyncPending,
    });
  }

  /**
   * 定期同步（用户要求：把这些数据定期存到服务器上，好让多端接着用）。
   *
   * 「每轮结束自动推一次」已经在了，但那只覆盖「一直在聊」的场景：如果用户挂着页面
   * 慢慢看、或者一轮里后台写入拖了很久，服务端就会落后。所以再加一条低频率的心跳
   * （默认 5 分钟一次，页面可见时才跑），让服务端上的那份始终是"最近的"。
   * 它和每轮那一次走同一个节流实例，不会叠加成两倍流量。
   */
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      autoRef.current?.request();
    }, AUTO_SYNC_HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, []);
  const requestAutoSync = useCallback((): void => {
    if (configRef.current === null) return;
    autoRef.current?.request();
  }, []);

  const resync = useCallback(async (): Promise<void> => {
    const current = configRef.current;
    if (db === null || current === null) throw new Error('还没有连上同步空间。');

    // 只清游标与推送点：本地数据、服务端数据都不动
    await db.repository.writeSyncState({ spaceHandle: current.spaceHandle, pulledHead: 0, pushedAt: null });
    await syncNow();
  }, [db, syncNow]);

  return {
    config,
    status,
    busy,
    error,
    recoveryCode,
    dismissRecoveryCode: () => setRecoveryCode(null),
    connect,
    syncNow,
    resync,
    requestAutoSync,
    autoSyncPending,
    disconnect,
    setKeyMode,
    listDevices,
    rotatePassword,
    spaceFull,
    exportSnapshot,
    restoreSnapshot,
    sealSecret,
    openSecret,
  };
}

/** 给界面用：把上次同步结果写成人话。 */
export function describeReport(report: SyncReport | null): string {
  if (report === null) return '还没同步过';
  if (report.pushed === 0 && report.pulled === 0) return '两端一致，没有要传的';
  const parts = [`推 ${String(report.pushed)} 条`, `拉 ${String(report.pulled)} 条`];
  if (report.skipped > 0) parts.push(`本地更新较新、保留 ${String(report.skipped)} 条`);
  return parts.join(' · ');
}
