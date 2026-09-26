import { useCallback, useEffect, useState } from 'react';
import { assertPassword, loginAccount, readAccountSyncInfo, registerAccount, selfEndpoint } from '../lib/account-auth';
import {
  type AccountRegistry,
  activeDbName,
  copyLocalDatabase,
  deleteLocalDatabase,
  flushPendingAccountDeletions,
  type LocalAccount,
  listAccountSecretRefs,
  loadAccountRegistry,
  queueAccountDeletion,
  readActiveAccount,
  removeAccount,
  renameAccount,
  writeActiveAccount,
} from '../lib/db';
import { passwordStrengthHint } from '../lib/password-policy';
import { syncPasswordKeyRef } from '../lib/sync';

/** 每个账户卡片上要显示的同步状态（异步读它自己的库）。 */
interface SyncBadge {
  configured: boolean;
  unlocked: boolean;
  lastSyncAt: string | null;
}

type AddMode = 'idle' | 'register' | 'login';

/**
 * 账户中心（用户 2026-09-24 的账户重构）。
 *
 * 用户要的三件事：
 * 1. **界面简洁**：一个账户一张卡片，卡片上只有名字、ID、状态与几个动作；
 * 2. **允许多个账户、挑一个用**：点卡片上的「使用」就切过去（数据完全隔离）；
 * 3. **同步不再单独设密码**：注册账户时设的那个密码就是账户密码，登录时也输入它
 *    （细节见 `lib/account-auth.ts`）；「添加账户」跟卡片长一样，里面分注册与登录两条路。
 */
export function AccountPanel({ disabled }: { disabled: boolean }) {
  const [registry, setRegistry] = useState<AccountRegistry | null>(null);
  const [active, setActive] = useState<LocalAccount>(() => readActiveAccount());
  const [badges, setBadges] = useState<Record<string, SyncBadge>>({});
  const [mode, setMode] = useState<AddMode>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 注册
  const [registerName, setRegisterName] = useState('');
  const [registerId, setRegisterId] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [registerRepeat, setRegisterRepeat] = useState('');

  // 登录
  const [loginId, setLoginId] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  const [endpoint, setEndpoint] = useState('');

  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  /** 刚注册好、还没进去的那个账户（恢复码下面那个「进入」按钮用它）。 */
  const [pendingAccount, setPendingAccount] = useState<LocalAccount | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteArmedId, setDeleteArmedId] = useState<string | null>(null);
  const [deleteDraft, setDeleteDraft] = useState('');

  const accounts = registry?.accounts ?? [active];

  const refreshBadges = useCallback(async (list: readonly LocalAccount[]): Promise<void> => {
    const entries = await Promise.all(
      list.map(async (account) => {
        const info = await readAccountSyncInfo(account);
        return [
          account.id,
          { configured: info.configured, unlocked: info.unlocked, lastSyncAt: info.lastSyncAt },
        ] as const;
      }),
    );
    setBadges(Object.fromEntries(entries));
  }, []);

  useEffect(() => {
    void loadAccountRegistry()
      .then((next) => {
        setRegistry(next);
        const current =
          next.accounts.find((account) => account.id === next.activeId) ?? (next.accounts[0] as LocalAccount);
        setActive(current);
        void refreshBadges(next.accounts);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [refreshBadges]);

  /** 切到某个账户并刷新（新账户的库还没被应用打开，必须重载）。 */
  /** 切到某个账户并刷新（新账户的库还没被应用打开，必须重载）。名字故意不叫 use*：那不是 hook */
  const activateAccount = async (account: LocalAccount, carry: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (carry && account.dbName !== activeDbName()) {
        await copyLocalDatabase(activeDbName(), account.dbName);
      }
      writeActiveAccount(account);
      window.location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  const runRegister = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      assertPassword(registerPassword);
      if (registerPassword !== registerRepeat) throw new Error('两次输入的密码不一样。');
      if (registerId.trim() === '') throw new Error('账户 ID 不能为空（它是同步空间的标识）。');
      const created = await registerAccount({
        name: registerName,
        accountId: registerId,
        password: registerPassword,
        ...(endpoint.trim() === '' ? {} : { endpoint }),
      });
      setRecoveryCode(created.recoveryCode);
      setPendingAccount(created.account);
      setRegistry(createRegistryPreview(created.account, accounts));
      setNotice(`账户「${created.account.name}」建好了，恢复码只显示这一次，请抄下来。`);
      setBusy(false);
      await refreshBadges([...accounts.filter((item) => item.id !== created.account.id), created.account]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  const runLogin = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const logged = await loginAccount({
        accountId: loginId,
        password: loginPassword,
        ...(endpoint.trim() === '' ? {} : { endpoint }),
      });
      // 登录成功：直接进这个账户（它的数据会在启动后的自动同步里拉下来）
      setNotice(
        logged.recoveryCode === null
          ? `已登录「${logged.account.name}」，正在打开……`
          : `已登录「${logged.account.name}」。`,
      );
      await activateAccount(logged.account, false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  const commitRename = (account: LocalAccount): void => {
    try {
      const next = renameAccount(account.id, renameDraft);
      setRegistry((current) =>
        current === null
          ? current
          : { ...current, accounts: current.accounts.map((item) => (item.id === next.id ? next : item)) },
      );
      if (active.id === next.id) setActive(next);
      setRenamingId(null);
      setRenameDraft('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const commitDelete = async (account: LocalAccount): Promise<void> => {
    if (accounts.length <= 1) {
      setError('至少要保留一个账户。');
      return;
    }
    if (deleteDraft.trim() !== account.accountId) {
      setError(`请输入完整账户 ID「${account.accountId}」来确认删除。`);
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const remaining = accounts.filter((item) => item.id !== account.id);
      const ownRefs = await listAccountSecretRefs(account.dbName);
      const sharedRefs = new Set(
        (await Promise.all(remaining.map((item) => listAccountSecretRefs(item.dbName)))).flat(),
      );
      const refs = ownRefs.filter((ref) => !sharedRefs.has(ref));
      if (account.id === active.id) refs.push(syncPasswordKeyRef(account.id));
      queueAccountDeletion(account, refs);
      removeAccount(account.id);

      if (account.id === active.id) {
        window.location.reload();
        return;
      }

      try {
        await deleteLocalDatabase(account.dbName);
      } catch {
        // 别的标签页占着库时，排队标记会在它们关闭后的下次启动继续清理。
      }
      await flushPendingAccountDeletions().catch(() => undefined);

      setRegistry((current) =>
        current === null
          ? current
          : { ...current, accounts: current.accounts.filter((item) => item.id !== account.id) },
      );
      setDeleteArmedId(null);
      setDeleteDraft('');
      setNotice(`已从这台设备硬删除「${account.name}」的账户容器、模型配置与独占 Key 缓存。`);
      setBusy(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  const openAdd = (next: AddMode): void => {
    setMode(next);
    setError(null);
    setNotice(null);
    setRecoveryCode(null);
    if (next === 'login' && loginId === '') setLoginId(active.accountId);
  };

  return (
    <section className="panel">
      <h2>账户</h2>
      <p className="hint">
        每个账户是一份完全独立的数据（世界、卡片、记忆、模型配置）。注册时会设一个**账户密码**——
        它同时也是同步用的密码，登录别的设备时输入它就行。
      </p>

      <ul className="account-cards">
        {accounts.map((account) => {
          const isActive = account.id === active.id;
          const badge = badges[account.id];
          return (
            <li key={account.id} className={isActive ? 'account-card active' : 'account-card'}>
              <div className="account-card-head">
                {renamingId === account.id ? (
                  <>
                    <input
                      className="account-rename-input"
                      value={renameDraft}
                      disabled={disabled || busy}
                      aria-label="账户名"
                      onChange={(event) => setRenameDraft(event.target.value)}
                    />
                    <button
                      type="button"
                      className="ghost"
                      disabled={disabled || busy}
                      onClick={() => commitRename(account)}
                    >
                      保存
                    </button>
                    <button type="button" className="ghost" onClick={() => setRenamingId(null)}>
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    <strong>{account.name}</strong>
                    {isActive ? <span className="tag accent">当前</span> : null}
                    {badge?.configured ? (
                      badge.unlocked ? (
                        <span className="tag">同步已连接</span>
                      ) : (
                        <span className="tag">要输密码</span>
                      )
                    ) : null}
                  </>
                )}
              </div>
              <p className="hint account-card-id">
                ID：{account.accountId}
                {account.legacy ? ' · 旧账户' : ''}
                {badge?.lastSyncAt === null || badge?.lastSyncAt === undefined
                  ? ''
                  : ` · 上次同步 ${formatWhen(badge.lastSyncAt)}`}
              </p>

              <div className="account-card-actions">
                {isActive ? null : (
                  <button
                    type="button"
                    disabled={disabled || busy}
                    onClick={() => void activateAccount(account, false)}
                  >
                    使用
                  </button>
                )}
                {badge?.configured && badge.unlocked === false ? (
                  <button
                    type="button"
                    className="ghost"
                    disabled={disabled || busy}
                    onClick={() => {
                      setLoginId(account.accountId);
                      openAdd('login');
                      setNotice('输入这个账户的密码（忘了就用恢复码）就能重新解锁同步。');
                    }}
                  >
                    输入密码
                  </button>
                ) : null}
                <button
                  type="button"
                  className="ghost"
                  disabled={disabled || busy}
                  onClick={() => {
                    setRenamingId(account.id);
                    setRenameDraft(account.name);
                  }}
                >
                  改名
                </button>
                <button
                  type="button"
                  className="ghost danger"
                  disabled={disabled || busy || accounts.length <= 1}
                  title={accounts.length <= 1 ? '至少要保留一个账户' : '永久删除这台设备上的账户数据'}
                  onClick={() => {
                    setDeleteArmedId(account.id);
                    setDeleteDraft('');
                    setNotice(null);
                    setError(null);
                  }}
                >
                  删除
                </button>
              </div>

              {deleteArmedId === account.id ? (
                <div className="account-delete-confirm">
                  <p>
                    将从这台设备硬删除：全部世界、对话、卡片、记忆、模型配置，以及只属于这个账户的 Key 缓存。
                    <strong>不可恢复。</strong>
                    {account.id === active.id ? ' 删除后会自动切到另一个账户并刷新。' : ''}
                  </p>
                  <p className="hint">已经建立的同步空间仍会在服务器上保留密文副本，本操作不会删除服务器数据。</p>
                  <label>
                    <span>
                      输入账户 ID「<code>{account.accountId}</code>」确认
                    </span>
                    <input
                      value={deleteDraft}
                      disabled={disabled || busy}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(event) => setDeleteDraft(event.target.value)}
                    />
                  </label>
                  <div className="account-card-actions">
                    <button
                      type="button"
                      className="ghost danger"
                      disabled={disabled || busy || deleteDraft.trim() !== account.accountId}
                      onClick={() => void commitDelete(account)}
                    >
                      {busy ? '删除中…' : '永久删除本机账户'}
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      disabled={disabled || busy}
                      onClick={() => {
                        setDeleteArmedId(null);
                        setDeleteDraft('');
                      }}
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}

        {/*
          「添加账户」本身也是一张卡片（用户要求：和账户卡片一样），
          点开之后分**注册**与**登录**两条路。
        */}
        <li className={mode === 'idle' ? 'account-card add' : 'account-card add open'}>
          {mode === 'idle' ? (
            <button
              type="button"
              className="account-add-button"
              disabled={disabled || busy}
              onClick={() => openAdd('register')}
            >
              ＋ 添加账户
            </button>
          ) : (
            <>
              <div className="account-mode-switch">
                <button
                  type="button"
                  className={mode === 'register' ? 'tab active' : 'tab'}
                  onClick={() => openAdd('register')}
                >
                  注册
                </button>
                <button
                  type="button"
                  className={mode === 'login' ? 'tab active' : 'tab'}
                  onClick={() => openAdd('login')}
                >
                  登录
                </button>
              </div>

              {mode === 'register' ? (
                <div className="stack">
                  <label>
                    账户名（可以重复、随时改）
                    <input
                      value={registerName}
                      disabled={disabled || busy}
                      placeholder="例如：小满"
                      onChange={(event) => setRegisterName(event.target.value)}
                    />
                  </label>
                  <label>
                    账户 ID（设备内唯一、创建后不可改）
                    <input
                      value={registerId}
                      disabled={disabled || busy}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder="例如：xiaoman-01"
                      onChange={(event) => setRegisterId(event.target.value)}
                    />
                  </label>
                  <label>
                    账户密码（至少 6 位，同步也用它）
                    <input
                      type="password"
                      value={registerPassword}
                      disabled={disabled || busy}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(event) => setRegisterPassword(event.target.value)}
                    />
                    {passwordStrengthHint(registerPassword) === null ? null : (
                      <span className="hint">{passwordStrengthHint(registerPassword)}</span>
                    )}
                  </label>
                  <label>
                    再输一次
                    <input
                      type="password"
                      value={registerRepeat}
                      disabled={disabled || busy}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(event) => setRegisterRepeat(event.target.value)}
                    />
                  </label>
                </div>
              ) : (
                <div className="stack">
                  <label>
                    账户 ID
                    <input
                      value={loginId}
                      disabled={disabled || busy}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder="注册时填的那个"
                      onChange={(event) => setLoginId(event.target.value)}
                    />
                  </label>
                  <label>
                    账户密码（忘了密码就填恢复码）
                    <input
                      type="password"
                      value={loginPassword}
                      disabled={disabled || busy}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(event) => setLoginPassword(event.target.value)}
                    />
                  </label>
                </div>
              )}

              <details className="account-advanced">
                <summary>高级：连别的服务器</summary>
                <label>
                  服务端地址
                  <input
                    value={endpoint}
                    disabled={disabled || busy}
                    inputMode="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder={selfEndpoint()}
                    onChange={(event) => setEndpoint(event.target.value)}
                  />
                </label>
                <p className="hint">留空就用本站自带的同步服务端（{selfEndpoint()}）。</p>
              </details>

              <div className="save-bar">
                <button
                  type="button"
                  disabled={
                    disabled ||
                    busy ||
                    (mode === 'register'
                      ? registerId.trim() === '' || registerPassword === ''
                      : loginId.trim() === '' || loginPassword === '')
                  }
                  onClick={() => void (mode === 'register' ? runRegister() : runLogin())}
                >
                  {busy ? '处理中…' : mode === 'register' ? '注册并进入' : '登录并进入'}
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={disabled || busy}
                  onClick={() => {
                    setMode('idle');
                    setRecoveryCode(null);
                  }}
                >
                  取消
                </button>
              </div>
            </>
          )}
        </li>
      </ul>

      {recoveryCode === null ? null : (
        <div className="notice warn">
          <strong>恢复码（只显示这一次）</strong>
          <p className="hint">
            忘了账户密码时，它就是密码：一样能登录、一样能解开数据。抄到安全的地方； 服务端与这台设备都不会再留第二份。
          </p>
          <code className="recovery-code">{recoveryCode}</code>
          <button type="button" className="ghost" onClick={() => void navigator.clipboard?.writeText(recoveryCode)}>
            复制
          </button>
          {/*
            注册完先让用户看到恢复码，再一键进去（不自动进：自动刷新会把恢复码冲掉）。
          */}
          {pendingAccount === null ? null : (
            <button
              type="button"
              disabled={disabled || busy}
              onClick={() => void activateAccount(pendingAccount, false)}
            >
              {busy ? '进入中…' : `进入「${pendingAccount.name}」`}
            </button>
          )}
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setRecoveryCode(null);
              setPendingAccount(null);
            }}
          >
            我抄好了
          </button>
        </div>
      )}

      {error === null ? null : <div className="notice error">{error}</div>}
      {notice === null ? null : <div className="notice">{notice}</div>}
      <p className="hint">切换账户会重新加载页面；每个账户的数据互相隔离，不会自动合并。</p>
    </section>
  );
}

/** 注册成功后先把新账户塞进本地列表，界面上立刻能看到它（真正的注册表由 createAccount 写好了）。 */
function createRegistryPreview(account: LocalAccount, accounts: readonly LocalAccount[]): AccountRegistry | null {
  if (accounts.some((item) => item.id === account.id)) return null;
  return { version: 2, activeId: readActiveAccount().id, accounts: [...accounts, account] };
}

function formatWhen(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '刚刚';
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${String(minutes)} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)} 小时前`;
  return `${String(Math.round(hours / 24))} 天前`;
}
