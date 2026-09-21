import { useEffect, useState } from 'react';
import { accountDbName, type LocalAccount, listLocalDatabases, readActiveAccount, writeActiveAccount } from '../lib/db';

/**
 * 本地账户（顺序 37）。
 *
 * 「账户」在这里的准确含义是：**一份独立的本地数据**（一个 IndexedDB 库）。
 * 用户 2026-09-21 提的「切账户换对话数据」就是这件事——以前所有世界堆在同一个库里，
 * 换同步空间只换「推到哪」，两边会合并。
 *
 * 两条规矩写在这里，也写在界面上：
 *
 * 1. **切换 = 换一份数据**，看不到另一个账户的世界（这正是想要的隔离）；
 * 2. **新建账户默认把现在这份数据带过去**，否则用户会以为「我的世界没了」——
 *    要一份干净的就勾「不带过去」。
 *
 * 切换之后要**整页重载**：库换了，仓储、后台队列、同步状态全都要重新建。
 * 这比在内存里热切换安全得多，也不会留下两套状态。
 */
export function AccountPanel({ disabled }: { disabled: boolean }) {
  const [active, setActive] = useState<LocalAccount | null>(null);
  const [databases, setDatabases] = useState<string[]>([]);
  const [draftId, setDraftId] = useState('');
  const [carryData, setCarryData] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setActive(readActiveAccount());
    void listLocalDatabases().then(setDatabases);
  }, []);

  const openAccount = async (id: string, carry: boolean): Promise<void> => {
    const clean = id.trim();
    if (clean === '') {
      setError('给这个账户起个名字（它就是这台设备上那份数据的名字）。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // 动态导入：切换账户只发生一次，不必让它进主包
      const { copyLocalDatabase, activeDbName } = await import('../lib/db');
      const from = activeDbName();
      const to = accountDbName(clean);
      const exists = databases.includes(to);
      if (!exists && carry) await copyLocalDatabase(from, to);
      writeActiveAccount({ id: clean, label: clean });
      window.location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  const backToLocal = (): void => {
    writeActiveAccount(null);
    window.location.reload();
  };

  return (
    <section className="panel">
      <h2>本地账户</h2>
      <p className="hint">
        一个账户就是<strong>一份独立的本地数据</strong>。切到另一个账户，看到的就是它自己的世界与对话——
        两边不会混在一起。账户与「多设备同步」是两件事：同步负责把当前账户的数据加密送到你的服务器，
        账户负责决定这台设备上有几份数据。
      </p>

      <ul className="usage-list">
        <li>
          <span className="usage-name">当前账户</span>
          <span className="usage-figure">{active === null ? '本机数据（未分账户）' : active.label}</span>
        </li>
        <li>
          <span className="usage-name">这台设备上的账户</span>
          <span className="usage-figure">
            {databases.length === 0
              ? '（正在统计）'
              : databases.map((name) => name.split(':').slice(2).join(':') || '本机数据').join('、')}
          </span>
        </li>
      </ul>

      <label>
        账户名
        <input
          value={draftId}
          disabled={disabled || busy}
          placeholder="例如：我自己 / 朋友的号"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
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
          新建时把当前数据带过去
          <span className="hint">不勾就是一份干净的新数据（想让两个账户彻底互不相干时用）。</span>
        </span>
      </label>

      <div className="save-bar">
        <button type="button" disabled={disabled || busy} onClick={() => void openAccount(draftId, carryData)}>
          {busy ? '切换中…' : '切到这个账户'}
        </button>
        <button type="button" className="ghost" disabled={disabled || busy || active === null} onClick={backToLocal}>
          回到本机数据
        </button>
      </div>

      {error === null ? null : <div className="notice error">{error}</div>}
      <p className="hint">
        切换会<strong>重新加载页面</strong>（库换了，仓储、后台队列、同步都要重新建）。数据不会因为切换而删除：
        每个账户的东西都留在自己的库里，随时切回去就能看到。
      </p>
    </section>
  );
}
