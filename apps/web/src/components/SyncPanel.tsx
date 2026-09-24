import type { SyncDeviceSummary } from '@dramatis/core';
import { useRef, useState } from 'react';
import type { KeyStorageMode } from '../lib/keystore';
import { parseSnapshot, type ServerSnapshot, SNAPSHOT_REMIND_MS } from '../lib/snapshot';
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
 * 「挡住旧版本」那行里补一句「是谁写的」。
 *
 * 顺序 19 的细节里带的是设备号，这里只取前 8 位——面板上不需要完整 uuid，
 * 要的是「和别的设备撞过车」这件事本身。
 */
function describeDevices(overridden: readonly { deviceId: string }[]): string {
  const ids = [...new Set(overridden.map((item) => item.deviceId))].filter((id) => id !== '');
  if (ids.length === 0) return '';
  return `（来自 ${ids
    .slice(0, 2)
    .map((id) => `设备 ${id.slice(0, 8)}…`)
    .join('、')}${ids.length > 2 ? ` 等 ${String(ids.length)} 台` : ''}）`;
}

/** 复制恢复码：非 https / 没授权时如实说，别假装成功。 */
async function copyRecoveryCode(code: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(code);
    return true;
  } catch {
    return false;
  }
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
  /** 顺序 14：点一下才去问服务端要设备列表（不想每次打开设置都打一次请求）。 */
  const [devices, setDevices] = useState<{ devices: SyncDeviceSummary[]; localDeviceId: string } | null>(null);
  const [newPassword, setNewPassword] = useState('');
  /** 顺序 17：服务端快照的状态（文件选择走隐藏的 input，与「导入素材」同一套做法）。 */
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [snapshotNotice, setSnapshotNotice] = useState<string | null>(null);
  const snapshotInput = useRef<HTMLInputElement | null>(null);

  /** 上次存快照过去多久了（没存过就是「还没存过」）。 */
  const snapshotAge = ((): string => {
    const at = api.config?.lastSnapshotAt;
    if (at === null || at === undefined) return '还没存过';
    const age = Date.now() - new Date(at).getTime();
    if (Number.isNaN(age)) return '还没存过';
    if (age < 60 * 60 * 1000) return '刚刚';
    if (age < SNAPSHOT_REMIND_MS) return `${String(Math.round(age / 3_600_000))} 小时前`;
    return `${String(Math.floor(age / 86_400_000))} 天前`;
  })();
  const snapshotStale =
    api.config?.lastSnapshotAt === null ||
    api.config?.lastSnapshotAt === undefined ||
    Date.now() - new Date(api.config.lastSnapshotAt).getTime() > SNAPSHOT_REMIND_MS;

  const loadDevices = async (): Promise<void> => {
    try {
      setDevices(await api.listDevices());
    } catch (error) {
      setNotice({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  };
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const [recoveryCopied, setRecoveryCopied] = useState(false);

  const connected = api.config !== null;

  /**
   * 同源推荐地址：`https://本站/sync`。
   *
   * 部署形态就是「同一张证书、同一个端口、网页与 /sync 并排」（deploy/README 第一节），
   * 所以**应用自己就知道**服务端地址该填什么。手机上要用户手打
   * `https://dramatissync.com:8443/sync` 是没道理的——给个一键填。
   * 只在 https 上给：本地开发用 http://127.0.0.1:5273 时同样成立。
   */
  const sameOriginEndpoint = `${window.location.origin}/sync`;

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
          /* 手机上别自动大写、别自动纠正：地址里没有大写，改错了很难看出来 */
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder={sameOriginEndpoint}
          onChange={(event) => setEndpoint(event.target.value)}
        />
        <button
          type="button"
          className="ghost"
          disabled={disabled || api.busy || endpoint === sameOriginEndpoint}
          onClick={() => setEndpoint(sameOriginEndpoint)}
        >
          用本站地址（{sameOriginEndpoint}）
        </button>
      </div>

      <div className="field">
        <label htmlFor="sync-user">用户 id</label>
        <input
          id="sync-user"
          value={userId}
          disabled={disabled || api.busy || connected}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
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
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
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
            <span className="usage-name">上次合并</span>
            <span className="usage-figure">
              {api.config?.lastReport === null || api.config?.lastReport === undefined
                ? '还没同步过'
                : `写进本机 ${String(api.config.lastReport.applied)} 条 · 本机更新较新保留 ${String(
                    api.config.lastReport.skipped,
                  )} 条`}
            </span>
          </li>
          {/*
            覆盖可见性（顺序 19）：LWW 静默覆盖是这个设计里最容易让人不放心的地方，
            所以要能说出「有多少条是别的设备写得更旧、被我这边留住了」。
            只算**来自别的设备**的：自己本机改两遍不叫覆盖。
          */}
          {(api.config?.lastReport?.overriddenCount ?? 0) > 0 ? (
            <li>
              <span className="usage-name">挡住旧版本</span>
              <span className="usage-figure">
                别的设备写得更旧、本机留住的 {String(api.config?.lastReport?.overriddenCount ?? 0)} 条
                {describeDevices(api.config?.lastReport?.overridden ?? [])}
              </span>
            </li>
          ) : null}
          {(api.config?.lastReport?.quarantinedCount ?? 0) > 0 ? (
            <li>
              <span className="usage-name">跳过</span>
              <span className="usage-figure">
                解不开、已跳过 {String(api.config?.lastReport?.quarantinedCount ?? 0)} 条（
                {api.config?.lastReport?.quarantined[0]?.reason.slice(0, 24) ?? ''}…）
              </span>
            </li>
          ) : null}
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
          {/*
            手机上「抄下来」多半是复制粘贴，所以给一键复制 + 等宽大字 + 可选中；
            抄错一位等于丢了这条线，值得把这一步做顺。
          */}
          <p className="recovery-code">{api.recoveryCode}</p>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              void copyRecoveryCode(api.recoveryCode ?? '').then((ok) => {
                setRecoveryCopied(ok);
                if (!ok) {
                  setNotice({
                    ok: false,
                    message: '这个浏览器不让复制（可能是非 https 或没给剪贴板权限），请手动选中上面那串。',
                  });
                }
              });
            }}
          >
            {recoveryCopied ? '已复制 ✓' : '复制恢复码'}
          </button>
          <p className="hint">
            忘了同步密码时，它就是你的密码（一样能解开数据、一样能登录）。丢了就只剩封存文件那条路。
          </p>
          <button type="button" className="ghost" onClick={api.dismissRecoveryCode}>
            我抄好了
          </button>
        </div>
      ) : null}

      {/*
        顺序 11：服务端上的空间没了（被清过库、或者换了服务器），客户端只会报一句
        「服务端上没有这个空间了」——用户不知道下一步该干嘛。这里把路指出来：
        填回同一套 id + 密码再连一次，就会用同样的空间名重新开通，并把本机数据推上去。
      */}
      {/* 判据是状态码 404，不是中文文案（顺序 61）：服务端换一句话这里不会失效 */}
      {api.error !== null && api.errorStatus === 404 ? (
        <div className="notice warn">
          <strong>服务端上的这个空间不在了</strong>
          <p>{api.error}</p>
          <p className="hint">
            本机数据<strong>没有丢</strong>。上面把「用户 id 与同步密码」再填一次，点「开通 / 加入并同步」——
            会用同一个空间名重新开通，然后把本机这份数据推上去（服务端上原本那份已经没了，找不回来）。
          </p>
        </div>
      ) : api.error !== null ? (
        <div className="notice error">{api.error}</div>
      ) : null}

      {/*
        顺序 17 演练发现的洞：撞满之后接下来几次同步往往是「成功的」（没新东西要推），
        于是错误提示被清掉、画面看起来一切正常，而数据其实推不上去了。
        所以这一条**不跟着 error 走**：它只在真的推进去东西之后才消失。
      */}
      {api.spaceFull ? (
        <div className="notice warn">
          <strong>服务端上的这个空间已经存满</strong>
          <p>
            数据推不上去了，但<strong>本机一切都还在</strong>。服务端上的记录只增不减（删掉的会留成墓碑），
            所以「清理本机」不会让它变小。可行的两条路：① 先把本机数据导出一份封存留底 （「数据」那一档）；② 换一个用户
            id 重新开一个空间，本机这份会推过去。
          </p>
        </div>
      ) : null}
      {notice !== null ? <div className={notice.ok ? 'notice' : 'notice error'}>{notice.message}</div> : null}

      {/* ---------- 顺序 17：服务端快照（存一份 / 灌回去）---------- */}
      {connected ? (
        <div className="panel-inner">
          <h3>服务端快照</h3>
          <p className="hint">
            把服务端那份<strong>原文</strong>（密文 + 坐标）存成一个文件拿在手里。它解不开内容
            ——要读还得有同步密码或恢复码——但服务端被清空、换机器时，它能原样灌回去。
            本机数据没了可以让服务端补，服务端没了可以让本机补，只有**两边同时出事**才用得上它。
          </p>
          <p className={snapshotStale ? 'hint warn' : 'hint'}>
            上次存快照：{snapshotAge}
            {snapshotStale ? '（超过一天了，建议再存一份：它很便宜，几秒钟）' : ''}
          </p>
          <div className="save-bar">
            <button
              type="button"
              disabled={api.busy || snapshotBusy}
              title="从服务端把所有记录（密文）拉下来存成一个文件"
              onClick={() => {
                setSnapshotNotice(null);
                setSnapshotBusy(true);
                void api
                  .exportSnapshot()
                  .then((result) => {
                    if (result === null) return;
                    setSnapshotNotice(
                      `存好了：${String(result.records)} 条记录，${(result.bytes / 1024).toFixed(0)} KB`,
                    );
                  })
                  .catch((error: unknown) => setSnapshotNotice(error instanceof Error ? error.message : String(error)))
                  .finally(() => setSnapshotBusy(false));
              }}
            >
              {snapshotBusy ? '正在拉…' : '存一份服务端快照'}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={api.busy || snapshotBusy}
              title="选一个快照文件，把它的记录原样推回服务端（服务端被清空后用）"
              onClick={() => snapshotInput.current?.click()}
            >
              从快照灌回服务端
            </button>
          </div>
          <input
            ref={snapshotInput}
            type="file"
            accept="application/json,.json"
            className="hidden-file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file === undefined) return;
              setSnapshotNotice(null);
              setSnapshotBusy(true);
              void file
                .text()
                .then((text) => parseSnapshot(text))
                .then((snapshot: ServerSnapshot) => api.restoreSnapshot(snapshot))
                .then((result) => setSnapshotNotice(`灌回去了：${String(result.pushed)} 条记录`))
                .catch((error: unknown) => setSnapshotNotice(error instanceof Error ? error.message : String(error)))
                .finally(() => setSnapshotBusy(false));
            }}
          />
          {snapshotNotice === null ? null : <p className="hint">{snapshotNotice}</p>}
        </div>
      ) : null}

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

      {/* ---------- 顺序 14 / 15：设备可见性 + 断开一台设备 ---------- */}
      {connected ? (
        <div className="panel-inner">
          <h3>设备</h3>
          <p className="hint">
            这个空间最近有哪些设备在写。想断掉一台（比如旧手机丢了），做法是**换同步密码**：
            换完之后只知道旧密码的设备再也同步不了，你手上的其它设备用新密码重连即可。 恢复码不受影响。
          </p>
          <div className="save-bar">
            <button type="button" className="ghost" disabled={api.busy} onClick={() => void loadDevices()}>
              {devices === null ? '看有哪些设备' : '刷新设备列表'}
            </button>
          </div>
          {devices === null ? null : devices.devices.length === 0 ? (
            <p className="hint">服务端还没记下任何设备（可能是这台服务端还没更新到带设备列表的版本）。</p>
          ) : (
            <ul className="usage-list">
              {devices.devices.map((device) => (
                <li key={device.deviceId}>
                  <span className="usage-name">
                    {device.deviceId === devices.localDeviceId ? '这台设备' : `设备 ${device.deviceId.slice(0, 8)}…`}
                  </span>
                  <span className="usage-figure">
                    {String(device.records)} 条 · 最后写入 {formatTime(device.lastWriteAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="field">
            <label htmlFor="sync-new-password">换同步密码（= 让旧密码失效）</label>
            <input
              id="sync-new-password"
              type="password"
              value={newPassword}
              disabled={api.busy}
              autoComplete="off"
              placeholder="新密码（至少 6 位）"
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </div>
          <div className="save-bar">
            <button
              type="button"
              disabled={api.busy || newPassword.trim().length < 6}
              title="换完之后只知道旧密码的设备会同步不了；恢复码仍然有效"
              onClick={() => {
                if (
                  !window.confirm(
                    '换同步密码？换完之后，只知道旧密码的设备会同步不了（这就是「断开」）。恢复码仍然有效。',
                  )
                ) {
                  return;
                }
                void run(async () => {
                  await api.rotatePassword(newPassword);
                  setNewPassword('');
                  setNotice({ ok: true, message: '换好了。其它设备请用新密码重新连接。' });
                });
              }}
            >
              换密码
            </button>
            <span className="hint">本机不用重连（凭证已经就地换掉了）</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
