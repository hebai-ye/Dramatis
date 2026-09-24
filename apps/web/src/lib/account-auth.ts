/**
 * 账户的注册与登录（用户 2026-09-24 要求：把「同步密码」并进账户密码）。\
 *
 * 用户的原话与它带来的设计：
 *
 * > 账户允许登录多个账户……而数据同步不设密码，转而在帐户设立时设置密码
 * > （账户登录时也输入密码）；新建账户改为和账户卡片一样的添加账户，
 * > 而添加账户有注册和登录两种选项。
 *
 * 于是「账户」这件事只剩两样东西：
 *
 * - **账户 ID**：设备内唯一、创建后不改，同时也是同步空间的标识（服务端只看到一个折过的句柄）；
 * - **账户密码**：注册时设定、登录时输入；它既解锁本地这份数据（存进本机钥匙库），
 *   也解开服务端上那份主密钥封装。**没有第二套「同步密码」了。**
 *
 * 服务端地址不再让用户填：默认就是**本站自带的 `/sync`**（域名、证书、反代都已经配好），
 * 只有在「高级」里想连别的服务器时才需要改。
 */
import {
  createRemoteSpace,
  createSpaceCredentials,
  deriveSpaceHandle,
  fetchRemoteSpace,
  normalizeRecoveryCode,
  openSpace,
  type RemoteSpaceMeta,
} from '@dramatis/core';
import { createAccount, createIndexedDbEntityStore, type LocalAccount, loadAccountRegistry } from './db';
import { createBrowserKeyStore, type KeyStorageMode } from './keystore';
import { SYNC_CONFIG_META_KEY, type SyncConfig, syncPasswordKeyRef } from './sync';

/** 本站自带的同步服务端（nginx 把 `/sync` 反代到本机 8787）。 */
export function selfEndpoint(): string {
  return `${window.location.origin}/sync`;
}

/** 邮箱那套「至少几位」的门槛照旧：密码要挡住猜密码的人。 */
export const MIN_PASSWORD_LENGTH = 6;

export function assertPassword(password: string): void {
  if (password.trim().length < MIN_PASSWORD_LENGTH) {
    throw new Error(`密码太短了，至少 ${String(MIN_PASSWORD_LENGTH)} 位（它要挡住猜密码的人）。`);
  }
}

/** 把同步配置写进**某个账户自己的库**（注册/登录时那个账户还不是当前账户）。 */
async function writeAccountSyncConfig(dbName: string, config: SyncConfig): Promise<void> {
  const opened = await createIndexedDbEntityStore(dbName);
  try {
    await opened.store.put('meta', { id: SYNC_CONFIG_META_KEY, value: config });
  } finally {
    opened.db.close();
  }
}

/** 读某个账户的同步状态，用来在账户卡片上显示「已连接 / 要输密码」。 */
export async function readAccountSyncInfo(
  account: LocalAccount,
  keyMode: KeyStorageMode = 'session',
): Promise<{ configured: boolean; lastSyncAt: string | null; endpoint: string | null; unlocked: boolean }> {
  let config: SyncConfig | null = null;
  try {
    const opened = await createIndexedDbEntityStore(account.dbName);
    try {
      const row = await opened.store.get<{ value?: SyncConfig }>('meta', SYNC_CONFIG_META_KEY);
      config = row?.value ?? null;
    } finally {
      opened.db.close();
    }
  } catch {
    // 打不开（别的标签页占着、或者库还没建）就当没配置
  }

  if (config === null) return { configured: false, lastSyncAt: null, endpoint: null, unlocked: false };
  const stored = await createBrowserKeyStore(config.keyMode ?? keyMode).get(syncPasswordKeyRef(account.id));
  return {
    configured: true,
    lastSyncAt: config.lastSyncAt ?? null,
    endpoint: config.endpoint,
    unlocked: stored !== null && stored !== '',
  };
}

export interface RegisterAccountInput {
  name: string;
  accountId: string;
  password: string;
  /** 缺省 = 本站自带的 `/sync`。 */
  endpoint?: string;
  /** 密码存哪（与原来的「密码保存方式」同一套语义）。 */
  keyMode?: KeyStorageMode;
}

export interface AccountAuthResult {
  account: LocalAccount;
  /** 注册时才有：建空间那一刻必须抄下来的恢复码。 */
  recoveryCode: string | null;
}

/**
 * 注册一个新账户：建本地容器 + 在服务端建空间（两份钥匙封装：密码一份、恢复码一份）。
 *
 * 顺序是**先建服务端空间、再建本地容器**：反过来的话，服务端失败会在本机留下一个
 * 永远同步不上去的空账户，用户还得手动删。现在失败就是什么都没发生。
 */
export async function registerAccount(input: RegisterAccountInput): Promise<AccountAuthResult> {
  const accountId = input.accountId.trim();
  if (accountId === '') throw new Error('账户 ID 不能为空。');
  assertPassword(input.password);

  const registry = await loadAccountRegistry();
  if (registry.accounts.some((account) => account.accountId === accountId)) {
    throw new Error(`这个账户 ID「${accountId}」在本机已经有了。换一个，或者直接用「登录」。`);
  }

  const endpoint = (input.endpoint ?? selfEndpoint()).trim().replace(/\/+$/, '');
  const keyMode: KeyStorageMode = input.keyMode ?? 'device';
  const credentials = await createSpaceCredentials({ userId: accountId, password: input.password });

  const result = await createRemoteSpace(
    { endpoint },
    {
      spaceHandle: credentials.spaceHandle,
      credentialHash: credentials.credentialHash,
      recoveryCredentialHash: credentials.recoveryCredentialHash,
      keyWraps: { password: credentials.passwordWrap, recovery: credentials.recoveryWrap },
    },
  );
  if (result === 'exists') {
    throw new Error(`服务端上已经有一个「${accountId}」的空间了。直接「登录」它，或者换一个账户 ID。`);
  }

  const account = createAccount({ accountId, name: input.name.trim() === '' ? accountId : input.name });
  await writeAccountSyncConfig(account.dbName, {
    endpoint,
    userId: accountId,
    spaceHandle: credentials.spaceHandle,
    keyMode,
    createdAt: new Date().toISOString(),
    lastSyncAt: null,
    lastReport: null,
  });
  await createBrowserKeyStore(keyMode).set(syncPasswordKeyRef(account.id), input.password);

  return { account, recoveryCode: credentials.recoveryCode };
}

export interface LoginAccountInput {
  accountId: string;
  /** 账户密码，或者恢复码（两者等价，与原来一致）。 */
  password: string;
  /** 服务端上不存在这个空间时要报错给人看。 */
  endpoint?: string;
  keyMode?: KeyStorageMode;
  /** 本机还没有这个账户时，给它起个显示名；缺省用账户 ID。 */
  name?: string;
}

/**
 * 登录一个已有账户。
 *
 * 两步都要做对才算登进来：**解锁服务端那份主密钥**（密码错在这里失败，报「解不开主密钥」）
 * 与**写下本地的同步配置**。本机已经有同 ID 的账户时只补配置与密码，**不新建容器**
 * （否则会把已经聊了半天的数据换成一个空库）。
 */
export async function loginAccount(input: LoginAccountInput): Promise<AccountAuthResult> {
  const accountId = input.accountId.trim();
  if (accountId === '') throw new Error('账户 ID 不能为空。');
  if (input.password.trim() === '') throw new Error('请输入账户密码（忘了密码就填恢复码）。');

  const endpoint = (input.endpoint ?? selfEndpoint()).trim().replace(/\/+$/, '');
  const keyMode: KeyStorageMode = input.keyMode ?? 'device';

  const spaceHandle = await deriveSpaceHandle(accountId);
  const meta: RemoteSpaceMeta | null = await fetchRemoteSpace({ endpoint }, spaceHandle);
  if (meta === null) {
    throw new Error(`服务端上没有「${accountId}」这个账户。检查账户 ID 有没有打错，或者改用「注册」。`);
  }

  // 密码错时在这里就会失败（GCM 认证过不去），不会留下「登录成功但数据解不开」的状态
  await openWithSecret(meta, input.password);

  const registry = await loadAccountRegistry();
  const existing = registry.accounts.find((account) => account.accountId === accountId);
  const account = existing ?? createAccount({ accountId, name: (input.name ?? '').trim() || accountId });

  await writeAccountSyncConfig(account.dbName, {
    endpoint,
    userId: accountId,
    spaceHandle,
    keyMode,
    createdAt: new Date().toISOString(),
    lastSyncAt: null,
    lastReport: null,
  });
  await createBrowserKeyStore(keyMode).set(syncPasswordKeyRef(account.id), input.password);

  return { account, recoveryCode: null };
}

/** 先用密码试、不行再按恢复码试（与 `sync.ts` 里那条路同一套语义）。 */
async function openWithSecret(meta: RemoteSpaceMeta, secret: string): Promise<void> {
  const byPassword = meta.keyWraps.password;
  if (byPassword !== undefined) {
    try {
      await openSpace({ spaceHandle: meta.spaceHandle, secret, purpose: 'password', wrapped: byPassword as never });
      return;
    } catch {
      // 落到恢复码那条路
    }
  }
  await openSpace({
    spaceHandle: meta.spaceHandle,
    secret: normalizeRecoveryCode(secret),
    purpose: 'recovery',
    wrapped: meta.keyWraps.recovery as never,
  });
}
