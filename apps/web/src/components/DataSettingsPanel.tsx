import type { ConversationId } from '@dramatis/core';
import { useEffect, useRef, useState } from 'react';
import { formatBytes } from '../lib/format';
import type { StorageApi } from '../lib/storage';
import { useDialogActions } from './DialogShell';

interface Result {
  ok: boolean;
  message: string;
}
interface Props {
  activeConversationId: ConversationId | null;
  disabled: boolean;
  onExportArchive: () => Promise<Result | null>;
  onImportArchive: () => Promise<Result | null>;
  storage: StorageApi;
  backendKind: string;
}
type Action = 'export' | 'import' | 'persist' | 'install';

export function DataSettingsPanel(props: Props) {
  const { setGuard } = useDialogActions();
  const [action, setAction] = useState<Action | null>(null);
  const [archiveNotice, setArchiveNotice] = useState<Result | null>(null);
  const [storageNotice, setStorageNotice] = useState<Result | null>(null);
  const busyRef = useRef(false);
  const controlsDisabled = props.disabled || action !== null;

  useEffect(() => {
    setGuard(action === null ? null : { kind: 'busy', message: '数据与备份正在处理，请等待完成。' });
    return () => setGuard(null);
  }, [action, setGuard]);

  const run = async (kind: Action, work: () => Promise<Result | null>): Promise<void> => {
    if (props.disabled || busyRef.current) return;
    busyRef.current = true;
    setGuard({ kind: 'busy', message: '数据与备份正在处理，请等待完成。' });
    setAction(kind);
    const setNotice = kind === 'export' || kind === 'import' ? setArchiveNotice : setStorageNotice;
    setNotice(null);
    try {
      setNotice(await work());
    } catch (error) {
      setNotice({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      busyRef.current = false;
      setAction(null);
      setGuard(null);
    }
  };

  return (
    <div className="settings-panel" aria-busy={action !== null}>
      <section className="panel">
        <h2>封存导出与导入</h2>
        <p className="hint">
          封存是一整个世界的可导入备份，包含对话、角色、记忆、世界书与账单。导入会新建一条世界线，保留本机已有数据。
        </p>
        {props.activeConversationId === null ? <p className="hint">先打开一个世界，再导出它的封存备份。</p> : null}
        <div className="save-bar">
          <button
            type="button"
            disabled={controlsDisabled || props.activeConversationId === null}
            onClick={() => run('export', props.onExportArchive)}
          >
            {action === 'export' ? '导出中…' : '导出这个世界'}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={controlsDisabled}
            onClick={() => run('import', props.onImportArchive)}
          >
            {action === 'import' ? '导入中…' : '导入封存'}
          </button>
        </div>
        {archiveNotice === null ? null : (
          <div className={archiveNotice.ok ? 'notice' : 'notice error'} role={archiveNotice.ok ? 'status' : 'alert'}>
            <p>{archiveNotice.message.replace(/\*\*/g, '')}</p>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>本机浏览器存储</h2>
        <p className="hint">以下是这个浏览器为本站估算的本机存储用量与配额，不代表服务器存储额度。</p>
        <ul className="usage-list">
          <li>
            <span className="usage-name">存储后端</span>
            <span className="usage-figure">{props.backendKind || '未知'}</span>
          </li>
          <li>
            <span className="usage-name">持久化</span>
            <span className="usage-figure">
              {!props.storage.status.supported
                ? '这个浏览器不支持'
                : props.storage.status.persisted === null
                  ? '未知'
                  : props.storage.status.persisted
                    ? '已获得'
                    : '未获得'}
            </span>
          </li>
          <li>
            <span className="usage-name">本机浏览器已用 / 配额</span>
            <span className="usage-figure">
              {props.storage.status.usage === null || props.storage.status.quota === null
                ? '未知'
                : `${formatBytes(props.storage.status.usage)} / ${formatBytes(props.storage.status.quota)}`}
            </span>
          </li>
        </ul>
        <div className="save-bar">
          <button
            type="button"
            disabled={controlsDisabled || !props.storage.status.supported || props.storage.status.persisted === true}
            onClick={() =>
              run('persist', async () => {
                const granted = await props.storage.requestPersist();
                return {
                  ok: granted,
                  message: granted
                    ? '已获得持久化存储。仍建议定期导出封存备份。'
                    : '浏览器这次未授予持久化。可安装应用后再申请；现在仍可使用和导出备份。',
                };
              })
            }
          >
            {action === 'persist' ? '申请中…' : '申请持久化存储'}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={controlsDisabled}
            onClick={() =>
              run('install', async () => {
                const outcome = await props.storage.installApp();
                return {
                  ok: outcome !== 'dismissed',
                  message:
                    outcome === 'accepted'
                      ? '安装开始了。装完后可再次申请持久化存储。'
                      : outcome === 'dismissed'
                        ? '已取消安装。也可从浏览器菜单安装应用或添加到主屏幕。'
                        : '请使用地址栏安装图标或浏览器菜单中的“安装应用 / 添加到主屏幕”。',
                };
              })
            }
          >
            {action === 'install' ? '处理中…' : props.storage.canInstall ? '装成应用' : '怎么装成应用'}
          </button>
        </div>
        {storageNotice === null ? null : (
          <p className={storageNotice.ok ? 'hint' : 'hint warn'} role={storageNotice.ok ? 'status' : 'alert'}>
            {storageNotice.message}
          </p>
        )}
        <p className="hint">浏览器可能回收未持久化的本地数据。持久化有助于保留数据，封存导出提供可带走的备份。</p>
      </section>
    </div>
  );
}
