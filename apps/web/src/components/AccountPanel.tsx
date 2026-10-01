import { useCallback, useEffect, useRef, useState } from 'react';
import { assertPassword, loginAccount, readAccountSyncInfo, registerAccount, selfEndpoint } from '../lib/account-auth';
import { deleteAccountLocally } from '../lib/account-deletion';
import {
  type AccountSyncBadge,
  accountLeaveGuard,
  copyRecoveryCode,
  createAccountOperationGate,
  loadAccountBadges,
} from '../lib/account-ui';
import {
  type AccountRegistry,
  type LocalAccount,
  loadAccountRegistry,
  readAccountRegistry,
  readActiveAccount,
  renameAccount,
  writeActiveAccount,
} from '../lib/db';
import { MIN_PASSWORD_LENGTH, passwordStrengthHint } from '../lib/password-policy';
import { protectUnsavedRecovery } from '../lib/recovery-protection';
import type { SyncApi } from '../lib/sync';
import { useDialogActions } from './DialogShell';

type AddMode = 'idle' | 'register' | 'login';

export function AccountPanel({ disabled, sync }: { disabled: boolean; sync?: SyncApi }) {
  const { requestAction, setGuard } = useDialogActions();
  const [registry, setRegistry] = useState<AccountRegistry | null>(null);
  const [active, setActive] = useState<LocalAccount>(() => readActiveAccount());
  const [badges, setBadges] = useState<Record<string, AccountSyncBadge>>({});
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<AddMode>('idle');
  const [operation, setOperation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [registerName, setRegisterName] = useState('');
  const [registerId, setRegisterId] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [registerRepeat, setRegisterRepeat] = useState('');
  const [loginId, setLoginId] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [profileConsent, setProfileConsent] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const recoveryRef = useRef<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const [pendingAccount, setPendingAccount] = useState<LocalAccount | null>(null);
  const [switchTarget, setSwitchTarget] = useState<LocalAccount | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteArmedId, setDeleteArmedId] = useState<string | null>(null);
  const [deleteDraft, setDeleteDraft] = useState('');
  const operationGate = useRef(createAccountOperationGate());
  const badgeVersion = useRef(0);
  const mounted = useRef(true);
  const renameInput = useRef<HTMLInputElement>(null);
  const deleteInput = useRef<HTMLInputElement>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const recoveryRegion = useRef<HTMLElement>(null);
  const switchConfirm = useRef<HTMLButtonElement>(null);
  const errorRegion = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const enterButton = useRef<HTMLButtonElement>(null);
  const busy = operation !== null || sync?.busy === true;
  const blocked = disabled || busy || loading;
  const accounts = registry?.accounts ?? [active];

  const clearRecovery = useCallback(() => {
    recoveryRef.current = null;
    setRecoveryCode(null);
    setCopyNotice(null);
  }, []);

  useEffect(() => protectUnsavedRecovery(() => recoveryRef.current, window), []);

  useEffect(() => {
    setGuard(accountLeaveGuard(operation ?? (sync?.busy ? '正在同步' : null), recoveryCode, clearRecovery));
    return () => setGuard(null);
  }, [operation, sync?.busy, recoveryCode, clearRecovery, setGuard]);

  const refreshBadges = useCallback(async (list: readonly LocalAccount[]): Promise<void> => {
    const version = ++badgeVersion.current;
    const next = await loadAccountBadges(list, readAccountSyncInfo);
    if (mounted.current && version === badgeVersion.current) setBadges(next);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void loadAccountRegistry()
      .then(async (next) => {
        if (!mounted.current) return;
        setRegistry(next);
        setActive(next.accounts.find((account) => account.id === next.activeId) ?? (next.accounts[0] as LocalAccount));
        await refreshBadges(next.accounts);
      })
      .catch((reason: unknown) => {
        if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
    };
  }, [refreshBadges]);

  useEffect(() => {
    if (renamingId !== null) renameInput.current?.focus();
  }, [renamingId]);
  useEffect(() => {
    if (deleteArmedId !== null) deleteInput.current?.focus();
  }, [deleteArmedId]);
  useEffect(() => {
    if (mode !== 'idle') addInput.current?.focus();
  }, [mode]);
  useEffect(() => {
    if (recoveryCode !== null) recoveryRegion.current?.focus();
  }, [recoveryCode]);
  useEffect(() => {
    if (switchTarget !== null) switchConfirm.current?.focus();
  }, [switchTarget]);
  useEffect(() => {
    if (error !== null) errorRegion.current?.focus();
  }, [error]);
  useEffect(() => {
    if (pendingAccount !== null && !blocked && recoveryCode === null) enterButton.current?.focus();
  }, [pendingAccount, blocked, recoveryCode]);

  const restoreFocus = (): void => {
    requestAnimationFrame(() => {
      const target = trigger.current?.isConnected ? trigger.current : addButton.current;
      target?.focus();
    });
  };

  const runOperation = async (label: string, action: () => Promise<void>): Promise<void> => {
    if (disabled || sync?.busy) return;
    try {
      await operationGate.current.run(
        async () => {
          setError(null);
          setNotice(null);
          await action();
        },
        (pending) => {
          setOperation(pending ? label : null);
          setGuard(accountLeaveGuard(pending ? label : null, recoveryRef.current, clearRecovery));
        },
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const activateAccount = (account: LocalAccount): Promise<void> =>
    runOperation('正在切换账户', async () => {
      const latest = readAccountRegistry().accounts.find(
        (item) => item.id === account.id && item.dbName === account.dbName,
      );
      if (latest === undefined) throw new Error('本机账户列表已变化，未切换账户。请重新打开账户页。');
      writeActiveAccount(latest);
      if (readActiveAccount().id !== latest.id)
        throw new Error('浏览器未保存活动账户，未切换账户。请检查本机存储后重试。');
      window.location.reload();
    });

  const runRegister = (): Promise<void> =>
    runOperation('正在注册账户', async () => {
      assertPassword(registerPassword);
      if (registerPassword !== registerRepeat) throw new Error('两次输入的密码不一样。');
      const created = await registerAccount({
        name: registerName,
        accountId: registerId,
        password: registerPassword,
        profileConsent,
        onRecoveryCode: (code) => {
          recoveryRef.current = code;
          setRecoveryCode(code);
        },
        ...(endpoint.trim() === '' ? {} : { endpoint }),
      });
      recoveryRef.current = created.recoveryCode;
      setRecoveryCode(created.recoveryCode);
      const latest = readAccountRegistry();
      if (!latest.accounts.some((account) => account.id === created.account.id))
        throw new Error('同步空间已创建，但本机账户未保存。请先保存恢复码，检查浏览器存储后登录已有账户。');
      setPendingAccount(created.account);
      setRegistry(latest);
      setRegisterPassword('');
      setRegisterRepeat('');
      setNotice(
        `账户「${created.account.name}」已注册。请先安全保存恢复码，再进入账户。${created.profileWarning ?? ''}`,
      );
      await refreshBadges(readAccountRegistry().accounts);
    });

  const runLogin = (): Promise<void> =>
    runOperation('正在登录账户', async () => {
      const logged = await loginAccount({
        accountId: loginId,
        password: loginPassword,
        profileConsent,
        ...(endpoint.trim() === '' ? {} : { endpoint }),
      });
      const latest = readAccountRegistry();
      if (!latest.accounts.some((account) => account.id === logged.account.id))
        throw new Error('已验证账户密码，但本机账户未保存。请检查浏览器存储后重试。');
      setPendingAccount(logged.account);
      setRegistry(latest);
      setLoginPassword('');
      setNotice(`已登录「${logged.account.name}」，进入时会重新加载页面。${logged.profileWarning ?? ''}`);
      await refreshBadges(readAccountRegistry().accounts);
    });

  const commitRename = (account: LocalAccount): Promise<void> =>
    runOperation('正在保存账户名', async () => {
      if (renameDraft.trim() === '') throw new Error('请输入本机账户名。');
      const next = renameAccount(account.id, renameDraft);
      const latest = readAccountRegistry();
      if (!latest.accounts.some((item) => item.id === next.id && item.name === next.name))
        throw new Error('浏览器未保存账户名，本机名称未保存。请检查本机存储后重试。');
      setRegistry(latest);
      if (active.id === next.id) setActive(next);
      setRenamingId(null);
      setRenameDraft('');
      setNotice('本机账户名已保存。已登记的服务器显示名仍以服务器资料为准。');
      restoreFocus();
    });

  const commitDelete = (account: LocalAccount): Promise<void> =>
    runOperation('正在删除本机账户', async () => {
      if (accounts.length <= 1) throw new Error('至少要保留一个账户。');
      if (deleteDraft.trim() !== account.accountId) throw new Error('请输入完整账户 ID 来确认删除。');
      const result = await deleteAccountLocally(account);
      setRegistry(readAccountRegistry());
      setDeleteArmedId(null);
      setDeleteDraft('');
      setNotice(
        result.warning ??
          (result.pending > 0
            ? '账户已从本机列表移除，仍有清理待完成。关闭其他标签页后重新打开应用会继续清理。'
            : `已删除「${account.name}」的本机账户数据。服务器密文副本保留。`),
      );
      if (result.requiresReload) window.location.reload();
      else restoreFocus();
    });

  const openAdd = (next: AddMode): void => {
    requestAction(() => {
      setMode(next);
      setError(null);
      setNotice(null);
      setPendingAccount(null);
      setProfileConsent(false);
      setShowPassword(false);
      if (next === 'login' && loginId === '') setLoginId(active.accountId);
      if (next === 'idle') restoreFocus();
    });
  };

  const requestSwitch = (account: LocalAccount): void => requestAction(() => setSwitchTarget(account));
  const activeEndpoint = sync?.config?.endpoint ?? badges[active.id]?.endpoint ?? selfEndpoint();
  const defaultServer = activeEndpoint.replace(/\/+$/, '') === selfEndpoint();
  const repeatMismatch = registerRepeat !== '' && registerPassword !== registerRepeat;

  return (
    <section className="panel account-panel" aria-busy={busy || loading}>
      <h2>账户</h2>
      <p className="hint">每个账户独立保存世界、对话、卡片、记忆和模型配置。账户密码同时用于多设备同步。</p>
      {loading ? (
        <p role="status" className="hint">
          正在读取本机账户…
        </p>
      ) : null}
      {operation === null ? null : (
        <p role="status" className="notice">
          {operation}…
        </p>
      )}
      <ul className="account-cards">
        {accounts.map((account) => {
          const isActive = account.id === active.id;
          const badge = badges[account.id];
          const liveStatus = isActive && sync !== undefined ? sync.status : null;
          const status =
            liveStatus !== null
              ? liveStatus === 'off'
                ? '仅本机保存'
                : liveStatus === 'needs-secret'
                  ? '需要账户密码'
                  : liveStatus === 'error'
                    ? '同步出错'
                    : sync?.busy || sync?.autoSyncPending
                      ? '正在同步'
                      : '同步已就绪'
              : badge === undefined
                ? '读取中'
                : badge.state === 'unknown'
                  ? '同步状态未知'
                  : badge.configured
                    ? badge.unlocked
                      ? '本机已保存密码'
                      : '需要账户密码'
                    : '仅本机保存';
          const needsUnlock =
            liveStatus === 'needs-secret' ||
            liveStatus === 'error' ||
            (badge?.state === 'known' && badge.configured && !badge.unlocked);
          return (
            <li key={account.id} className={isActive ? 'account-card active' : 'account-card'}>
              <div className="account-card-head">
                {renamingId === account.id ? (
                  <form
                    className="account-card-actions"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void commitRename(account);
                    }}
                  >
                    <label>
                      <span>本机账户名</span>
                      <input
                        ref={renameInput}
                        className="account-rename-input"
                        value={renameDraft}
                        disabled={blocked}
                        onChange={(event) => setRenameDraft(event.target.value)}
                      />
                    </label>
                    <button type="submit" className="ghost" disabled={blocked || renameDraft.trim() === ''}>
                      保存
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      disabled={blocked}
                      onClick={() => {
                        setRenamingId(null);
                        restoreFocus();
                      }}
                    >
                      取消
                    </button>
                  </form>
                ) : (
                  <>
                    <strong>{account.name}</strong>
                    {isActive ? <span className="tag accent">当前账户</span> : null}
                    <span className="tag">{status}</span>
                  </>
                )}
              </div>
              <p className="hint account-card-id">
                ID：<code>{account.accountId}</code>
                {account.legacy ? ' · 旧账户' : ''}
                {(isActive ? sync?.config?.lastSyncAt : badge?.lastSyncAt)
                  ? ` · 上次同步 ${formatWhen((isActive ? sync?.config?.lastSyncAt : badge?.lastSyncAt) as string)}`
                  : ''}
              </p>
              {badge?.state === 'unknown' ? (
                <div className="notice error" role="status">
                  无法读取此账户的同步状态：{badge.error}
                  <button
                    type="button"
                    className="ghost"
                    disabled={blocked}
                    onClick={() => void runOperation('正在读取同步状态', () => refreshBadges(accounts))}
                  >
                    重试读取
                  </button>
                </div>
              ) : null}
              {isActive && sync?.error ? (
                <p className="notice error" role="status">
                  {sync.error}
                </p>
              ) : null}
              <div className="account-card-actions">
                {isActive ? null : (
                  <button
                    type="button"
                    disabled={blocked}
                    onClick={(event) => {
                      trigger.current = event.currentTarget;
                      requestSwitch(account);
                    }}
                  >
                    使用此账户
                  </button>
                )}
                {needsUnlock ? (
                  <button
                    type="button"
                    className="ghost"
                    disabled={blocked}
                    onClick={(event) => {
                      trigger.current = event.currentTarget;
                      requestAction(() => {
                        setMode('login');
                        setLoginId(account.accountId);
                        setEndpoint(badge?.endpoint ?? (isActive ? (sync?.config?.endpoint ?? '') : ''));
                        setProfileConsent(false);
                        setError(null);
                        setNotice('输入此账户的密码或恢复码，登录后重新加载即可解锁同步。');
                      });
                    }}
                  >
                    输入账户密码
                  </button>
                ) : null}
                <button
                  type="button"
                  className="ghost"
                  disabled={blocked}
                  onClick={(event) => {
                    trigger.current = event.currentTarget;
                    requestAction(() => {
                      setRenamingId(account.id);
                      setRenameDraft(account.name);
                      setError(null);
                    });
                  }}
                >
                  改本机名称
                </button>
                <button
                  type="button"
                  className="ghost danger"
                  disabled={blocked || accounts.length <= 1}
                  title={accounts.length <= 1 ? '至少要保留一个账户' : '删除这台设备上的账户数据'}
                  onClick={(event) => {
                    trigger.current = event.currentTarget;
                    requestAction(() => {
                      setDeleteArmedId(account.id);
                      setDeleteDraft('');
                      setNotice(null);
                      setError(null);
                    });
                  }}
                >
                  删除本机账户
                </button>
              </div>
              {deleteArmedId === account.id ? (
                <form
                  className="account-delete-confirm"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void commitDelete(account);
                  }}
                >
                  <p>
                    将从这台设备删除此账户的世界、对话、卡片、记忆、模型配置和独占密钥缓存。
                    <strong>本机删除不可撤销。</strong>
                    {isActive ? ' 删除后会切到另一个账户并重新加载页面。' : ''}
                  </p>
                  <p className="hint">
                    服务器上的密文副本保留。本操作不会删除服务器数据；其他标签页占用时，本机清理会排队继续。
                  </p>
                  <label>
                    <span>
                      输入完整账户 ID「<code>{account.accountId}</code>」确认
                    </span>
                    <input
                      ref={deleteInput}
                      value={deleteDraft}
                      disabled={blocked}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(event) => setDeleteDraft(event.target.value)}
                    />
                  </label>
                  <div className="account-card-actions">
                    <button
                      type="submit"
                      className="danger"
                      disabled={blocked || deleteDraft.trim() !== account.accountId}
                    >
                      确认删除本机数据
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      disabled={blocked}
                      onClick={() => {
                        setDeleteArmedId(null);
                        setDeleteDraft('');
                        restoreFocus();
                      }}
                    >
                      取消
                    </button>
                  </div>
                </form>
              ) : null}
            </li>
          );
        })}
        <li className={mode === 'idle' ? 'account-card add' : 'account-card add open'}>
          {mode === 'idle' ? (
            <button
              type="button"
              className="account-add-button"
              ref={addButton}
              disabled={blocked}
              onClick={(event) => {
                trigger.current = event.currentTarget;
                openAdd('register');
              }}
            >
              ＋ 添加账户
            </button>
          ) : (
            <>
              <nav className="account-mode-switch" aria-label="添加账户方式">
                <button
                  type="button"
                  className={mode === 'register' ? 'tab active' : 'tab'}
                  aria-pressed={mode === 'register'}
                  disabled={blocked}
                  onClick={() => openAdd('register')}
                >
                  注册新账户
                </button>
                <button
                  type="button"
                  className={mode === 'login' ? 'tab active' : 'tab'}
                  aria-pressed={mode === 'login'}
                  disabled={blocked}
                  onClick={() => openAdd('login')}
                >
                  登录已有账户
                </button>
              </nav>
              <form
                className="stack"
                onSubmit={(event) => {
                  event.preventDefault();
                  requestAction(() => {
                    void (mode === 'register' ? runRegister() : runLogin());
                  });
                }}
              >
                {mode === 'register' ? (
                  <>
                    <label>
                      本机账户名
                      <input
                        ref={addInput}
                        value={registerName}
                        disabled={blocked}
                        autoComplete="nickname"
                        placeholder="可重复，之后可以修改"
                        onChange={(event) => setRegisterName(event.target.value)}
                      />
                    </label>
                    <label>
                      账户 ID（本机唯一，创建后不可改）
                      <input
                        value={registerId}
                        disabled={blocked}
                        autoComplete="username"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        required
                        onChange={(event) => setRegisterId(event.target.value)}
                      />
                    </label>
                    <label>
                      账户密码（至少 6 位，同步也用它）
                      <input
                        type={showPassword ? 'text' : 'password'}
                        value={registerPassword}
                        disabled={blocked}
                        autoComplete="new-password"
                        required
                        onChange={(event) => setRegisterPassword(event.target.value)}
                      />
                      {passwordStrengthHint(registerPassword) ? (
                        <span className="hint">{passwordStrengthHint(registerPassword)}</span>
                      ) : null}
                    </label>
                    <label>
                      再次输入密码
                      <input
                        type={showPassword ? 'text' : 'password'}
                        value={registerRepeat}
                        disabled={blocked}
                        autoComplete="new-password"
                        required
                        aria-invalid={repeatMismatch}
                        aria-describedby={repeatMismatch ? 'account-repeat-error' : undefined}
                        onChange={(event) => setRegisterRepeat(event.target.value)}
                      />
                      {repeatMismatch ? (
                        <span id="account-repeat-error" className="hint warn">
                          两次密码不同，请检查。
                        </span>
                      ) : null}
                    </label>
                  </>
                ) : (
                  <>
                    <label>
                      账户 ID
                      <input
                        ref={addInput}
                        value={loginId}
                        disabled={blocked}
                        autoComplete="username"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        required
                        onChange={(event) => setLoginId(event.target.value)}
                      />
                    </label>
                    <label>
                      账户密码或恢复码
                      <input
                        type={showPassword ? 'text' : 'password'}
                        value={loginPassword}
                        disabled={blocked}
                        autoComplete="current-password"
                        required
                        onChange={(event) => setLoginPassword(event.target.value)}
                      />
                    </label>
                  </>
                )}
                <button
                  type="button"
                  className="ghost"
                  disabled={blocked}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((current) => !current)}
                >
                  {showPassword ? '隐藏密码' : '显示密码'}
                </button>
                <label className="hint">
                  <input
                    type="checkbox"
                    checked={profileConsent}
                    disabled={blocked}
                    onChange={(event) => setProfileConsent(event.target.checked)}
                  />
                  同意向此服务器登记账户 ID
                  和显示名。管理员可查看这两项；不包含密码、恢复码或对话。已登记显示名以服务器为准。
                </label>
                <details className="account-advanced">
                  <summary>高级：连接其他服务器</summary>
                  <label>
                    服务端地址
                    <input
                      value={endpoint}
                      disabled={blocked}
                      inputMode="url"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder={selfEndpoint()}
                      onChange={(event) => {
                        const value = event.target.value;
                        requestAction(() => {
                          setEndpoint(value);
                          setProfileConsent(false);
                          setPendingAccount(null);
                        });
                      }}
                    />
                  </label>
                  <p className="hint">留空使用本站同步服务。更换服务器后需重新确认资料登记。</p>
                </details>
                <div className="save-bar">
                  <button
                    type="submit"
                    disabled={
                      blocked ||
                      (mode === 'register'
                        ? registerId.trim() === '' ||
                          registerPassword.trim().length < MIN_PASSWORD_LENGTH ||
                          registerRepeat === '' ||
                          repeatMismatch
                        : loginId.trim() === '' || loginPassword === '')
                    }
                  >
                    {operation ?? (mode === 'register' ? '注册账户' : '登录账户')}
                  </button>
                  <button type="button" className="ghost" disabled={blocked} onClick={() => openAdd('idle')}>
                    取消
                  </button>
                </div>
              </form>
            </>
          )}
        </li>
      </ul>
      {recoveryCode === null ? null : (
        <section ref={recoveryRegion} className="notice warn" tabIndex={-1} aria-label="请安全保存恢复码">
          <strong>恢复码只显示这一次</strong>
          <p className="hint">
            忘记账户密码时，恢复码可用于登录和解开同步数据。请存到安全的地方；此界面关闭或重新加载后不会再显示。
          </p>
          <code className="recovery-code">{recoveryCode}</code>
          <div className="save-bar">
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => {
                void copyRecoveryCode(recoveryCode, navigator.clipboard).then(setCopyNotice);
              }}
            >
              复制恢复码
            </button>
            <button
              type="button"
              disabled={blocked}
              onClick={() => {
                clearRecovery();
                setGuard(null);
                setNotice('已确认安全保存恢复码。现在可以进入账户。');
              }}
            >
              我已安全保存
            </button>
          </div>
          {copyNotice === null ? null : (
            <p role="status" className={copyNotice.ok ? 'hint' : 'hint warn'}>
              {copyNotice.message}
            </p>
          )}
        </section>
      )}
      {pendingAccount === null ? null : (
        <div className="save-bar">
          <button
            ref={enterButton}
            type="button"
            disabled={blocked}
            onClick={(event) => {
              trigger.current = event.currentTarget;
              requestSwitch(pendingAccount);
            }}
          >
            进入「{pendingAccount.name}」
          </button>
          <span className="hint">进入会重新加载页面。</span>
        </div>
      )}
      {switchTarget === null ? null : (
        <fieldset className="notice warn">
          <legend>进入「{switchTarget.name}」？</legend>
          <p>页面将重新加载，并打开此账户独立的数据。当前账户的数据会留在本机，不会自动合并。</p>
          <div className="save-bar">
            <button
              ref={switchConfirm}
              type="button"
              disabled={blocked}
              onClick={() =>
                requestAction(() => {
                  void activateAccount(switchTarget);
                })
              }
            >
              确认进入并重新加载
            </button>
            <button
              type="button"
              className="ghost"
              disabled={blocked}
              onClick={() => {
                setSwitchTarget(null);
                restoreFocus();
              }}
            >
              取消
            </button>
          </div>
        </fieldset>
      )}
      {error === null ? null : (
        <div ref={errorRegion} className="notice error" role="alert" tabIndex={-1}>
          {error}
        </div>
      )}
      {notice === null ? null : (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      <section className="panel-inner">
        <h3>会员与容量</h3>
        <p className="hint">
          {defaultServer
            ? '本站同步空间的默认额度为 96 MiB。实际会员权益、当前额度和已用容量暂不可查询，不能据此判断剩余容量。'
            : '当前账户连接自定义服务器，会员权益和存储额度由该服务器决定。当前额度和已用容量暂不可查询。'}
        </p>
      </section>
    </section>
  );
}

function formatWhen(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '时间未知';
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${String(minutes)} 分钟前`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${String(hours)} 小时前` : `${String(Math.round(hours / 24))} 天前`;
}
