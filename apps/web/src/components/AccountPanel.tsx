import { useEffect, useState } from 'react';
import {
  type AccountRegistry,
  activeDbName,
  copyLocalDatabase,
  createAccount,
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
import { syncPasswordKeyRef } from '../lib/sync';

/**
 * 账户中心（账户重构 A1）。
 *
 * 用户看到的两条事实：
 *
 * 1. **账户名**可以重复，也可以随时改；
 * 2. **账户 ID**由用户设置，是设备与同步空间的稳定标识，创建后不能改。
 *
 * 内部 `storageId` 与数据库名不展示。旧版账户会显示一个「旧账户」标记，
 * 它仍然可以改名、切换和继续同步，只是账户 ID 会保持迁移时的值。
 */
export function AccountPanel({ disabled }: { disabled: boolean }) {
  const [registry, setRegistry] = useState<AccountRegistry | null>(null);
  const [active, setActive] = useState<LocalAccount>(() => readActiveAccount());
  const [draftName, setDraftName] = useState('');
  const [draftId, setDraftId] = useState('');
  const [carryData, setCarryData] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteArmedId, setDeleteArmedId] = useState<string | null>(null);
  const [deleteDraft, setDeleteDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void loadAccountRegistry()
      .then((next) => {
        setRegistry(next);
        setActive(next.accounts.find((account) => account.id === next.activeId) ?? (next.accounts[0] as LocalAccount));
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  const switchTo = async (account: LocalAccount, carry: boolean): Promise<void> => {
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

  const createAndSwitch = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const account = createAccount({ accountId: draftId, name: draftName });
      await switchTo(account, carryData);
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

  const accounts = registry?.accounts ?? [active];

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

  return (
    <section className="panel">
      <h2>个人账户</h2>
      <p className="hint">
        一个账户包含你的所有世界、对话、卡片、记忆、模型配置与账户密钥。账户名可以重复； 账户 ID
        用来区分同名账户，创建后不再修改。
      </p>

      <ul className="account-list">
        {accounts.map((account) => {
          const isActive = account.id === active.id;
          return (
            <li key={account.id} className={isActive ? 'account-row active' : 'account-row'}>
              <div>
                {renamingId === account.id ? (
                  <div className="account-rename">
                    <input
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
                      保存名称
                    </button>
                    <button type="button" className="ghost" onClick={() => setRenamingId(null)}>
                      取消
                    </button>
                  </div>
                ) : (
                  <strong>{account.name}</strong>
                )}
                <p className="hint">
                  ID：{account.accountId}
                  {account.legacy ? ' · 旧账户' : ''}
                </p>
              </div>
              <div className="account-actions">
                {isActive ? (
                  <span className="tag accent">当前</span>
                ) : (
                  <button
                    type="button"
                    className="ghost"
                    disabled={disabled || busy}
                    onClick={() => void switchTo(account, false)}
                  >
                    切换
                  </button>
                )}
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
                  <p className="hint">已经启用的同步空间仍会在服务器上保留密文副本，本操作不会删除服务器数据。</p>
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
                  <div className="account-actions">
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
      </ul>

      <details className="account-create">
        <summary>新建账户</summary>
        <label>
          账户名（可以重复）
          <input
            value={draftName}
            disabled={disabled || busy}
            placeholder="例如：小满"
            onChange={(event) => setDraftName(event.target.value)}
          />
        </label>
        <label>
          账户 ID（设备内唯一，创建后不可改）
          <input
            value={draftId}
            disabled={disabled || busy}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="例如：xiaoman-01"
            onChange={(event) => setDraftId(event.target.value)}
          />
        </label>
        <label className="inline-check">
          <input
            type="checkbox"
            checked={carryData}
            disabled={disabled || busy}
            onChange={(event) => setCarryData(event.target.checked)}
          />
          <span>
            复制当前账户的数据
            <span className="hint">高级选项；默认创建一份空白账户。</span>
          </span>
        </label>
        <div className="save-bar">
          <button
            type="button"
            disabled={disabled || busy || draftId.trim() === ''}
            onClick={() => void createAndSwitch()}
          >
            {busy ? '创建中…' : '创建并切换'}
          </button>
        </div>
      </details>

      {error === null ? null : <div className="notice error">{error}</div>}
      {notice === null ? null : <div className="notice">{notice}</div>}
      <p className="hint">切换账户会重新加载页面；每个账户的数据互相隔离，不会自动合并。</p>
    </section>
  );
}
