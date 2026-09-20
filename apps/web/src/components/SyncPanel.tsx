import { useState } from 'react';
import type { KeyStorageMode } from '../lib/keystore';
import { describeReport, type SyncApi } from '../lib/sync';

interface Props {
  api: SyncApi;
  disabled: boolean;
}

function formatTime(iso: string | null): string {
  if (iso === null) return '还没同步过';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * 同步面板（P2-6 第四步·界面）。
 *
 * 界面上只出现三样用户能理解的东西：**服务端地址、用户 id、同步密码**。
 * 空间句柄、凭证、主密钥这些词一个都不露——它们是实现细节。
 *
 * 两件事必须如实告诉用户：
 * 1. 建空间时会显示**一次**恢复码，抄下来才算数（服务端没有第二份，忘了密码只能靠它或封存文件）；
 * 2. 服务端只存密文，解不开内容。
 */
export function SyncPanel({ api, disabled }: Props) {
  const [endpoint, setEndpoint] = useState(api.config?.endpoint ?? '');
  const [userId, setUserId] = useState(api.config?.userId ?? '');
  const [secret, setSecret] = useState('');
  const [keyMode, setKeyMode] = useState<KeyStorageMode>(api.config?.keyMode ?? 'session');
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);

  const connected = api.config !== null;

  const run = async (action: () => Promise<void>): Promise<void> => {
    setNotice(null);
    try {
      await action();
      setSecret('');
    } catch (error) {
      setNotice({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div className="stack">
      <p className="hint">
        让你自己的多台设备看到同一条世界线：所有内容在本机加密后才上传，服务端只存密文与哈希， 解不开也读不到。用户 id
        和密码由你自己定，没有验证码，也没有"找回密码"——所以建空间时 显示的恢复码要抄下来。
      </p>

      <div className="field">
        <label htmlFor="sync-endpoint">服务端地址</label>
        <input
          id="sync-endpoint"
          value={endpoint}
          disabled={disabled || api.busy}
          placeholder="https://dramatis-sync.xxxx.ts.net"
          onChange={(event) => setEndpoint(event.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="sync-user">用户 id</label>
        <input
          id="sync-user"
          value={userId}
          disabled={disabled || api.busy || connected}
          placeholder="自己想一个（别用手机号）"
          onChange={(event) => setUserId(event.target.value)}
        />
        <span className="hint">只在服务端留一个折过的句柄；别填手机号或邮箱。</span>
      </div>

      <div className="field">
        <label htmlFor="sync-secret">{connected ? '同步密码（或恢复码）' : '同步密码'}</label>
        <input
          id="sync-secret"
          type="password"
          value={secret}
          disabled={disabled || api.busy}
          placeholder={connected ? '改了密码/恢复码才需要填' : '自己设一个够长的'}
          onChange={(event) => setSecret(event.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="sync-keymode">密码保存方式</label>
        <select
          id="sync-keymode"
          value={keyMode}
          disabled={disabled || api.busy}
          onChange={(event) => setKeyMode(event.target.value as KeyStorageMode)}
        >
          <option value="session">仅本次会话（最安全，重开要重填）</option>
          <option value="device">保存在本机浏览器（方便，换设备要重填）</option>
        </select>
      </div>

      <div className="save-bar">
        <button
          type="button"
          disabled={disabled || api.busy}
          onClick={() => void run(() => api.connect({ endpoint, userId, secret, keyMode }))}
        >
          {connected ? '用这个密码重新连接' : '开通 / 加入并同步'}
        </button>
        <button
          type="button"
          className="ghost"
          disabled={disabled || api.busy || !connected}
          onClick={() => void run(api.syncNow)}
        >
          {api.busy ? '同步中…' : '立即同步'}
        </button>
        {connected ? (
          <button
            type="button"
            className="ghost"
            disabled={api.busy}
            onClick={() => void run(async () => api.setKeyMode(keyMode))}
          >
            保存方式生效
          </button>
        ) : null}
      </div>

      {connected ? (
        <ul className="usage-list">
          <li>
            <span className="usage-name">状态</span>
            <span className="usage-figure">
              {api.status === 'ready' ? '已连接' : api.status === 'needs-secret' ? '需要重填密码' : '出错'}
            </span>
          </li>
          <li>
            <span className="usage-name">上次同步</span>
            <span className="usage-figure">{formatTime(api.config?.lastSyncAt ?? null)}</span>
          </li>
          <li>
            <span className="usage-name">上次结果</span>
            <span className="usage-figure">{describeReport(api.config?.lastReport ?? null)}</span>
          </li>
          <li>
            <span className="usage-name">自动同步</span>
            <span className="usage-figure">
              {api.autoSyncPending ? '正在推这一轮…' : '每轮对话结束后自动推（最快 20 秒一次）'}
            </span>
          </li>
          <li>
            <span className="usage-name">空间</span>
            <span className="usage-figure">{api.config?.spaceHandle.slice(0, 10)}…</span>
          </li>
        </ul>
      ) : null}

      {api.recoveryCode !== null ? (
        <div className="notice">
          <p>
            <strong>恢复码（只显示这一次，请抄到安全的地方）：</strong>
          </p>
          <p style={{ fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' }}>{api.recoveryCode}</p>
          <p className="hint">
            忘了同步密码时，它就是你的密码（一样能解开数据、一样能登录）。丢了就只剩封存文件那条路。
          </p>
          <button type="button" className="ghost" onClick={api.dismissRecoveryCode}>
            我抄好了
          </button>
        </div>
      ) : null}

      {api.error !== null ? <div className="notice error">{api.error}</div> : null}
      {notice !== null ? <div className={notice.ok ? 'notice' : 'notice error'}>{notice.message}</div> : null}

      {connected ? (
        <div className="save-bar">
          <button
            type="button"
            className="ghost"
            disabled={api.busy}
            title="把本机的拉取游标清掉，从服务端完整拉一遍。本地数据与服务端数据都不会被删。"
            onClick={() => void run(api.resync)}
          >
            重新拉一遍
          </button>
          <button type="button" className="ghost danger" disabled={api.busy} onClick={() => void run(api.disconnect)}>
            断开同步（不影响本机数据，也不会删除服务端的数据）
          </button>
        </div>
      ) : null}
    </div>
  );
}
