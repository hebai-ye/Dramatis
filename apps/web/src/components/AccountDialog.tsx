import { useState } from 'react';
import type { SyncApi } from '../lib/sync';
import { useDialogActions } from './DialogShell';
import { LazyPanel } from './LazyPanel';

const loadAccounts = () => import('./AccountPanel').then((module) => ({ default: module.AccountPanel }));
const loadSync = () => import('./SyncPanel').then((module) => ({ default: module.SyncPanel }));

export function AccountDialog({ sync, disabled }: { sync: SyncApi; disabled: boolean }) {
  const [section, setSection] = useState<'account' | 'sync'>('account');
  const { requestAction } = useDialogActions();
  return (
    <div className="account-dialog-content">
      <nav className="account-mode-switch" aria-label="账户分区">
        <button
          type="button"
          className={section === 'account' ? 'tab active' : 'tab'}
          aria-pressed={section === 'account'}
          onClick={() => requestAction(() => setSection('account'))}
        >
          账户
        </button>
        <button
          type="button"
          className={section === 'sync' ? 'tab active' : 'tab'}
          aria-pressed={section === 'sync'}
          onClick={() => requestAction(() => setSection('sync'))}
        >
          同步与安全
        </button>
      </nav>
      {section === 'account' ? (
        <LazyPanel load={loadAccounts} panelProps={{ sync, disabled }} label="账户" />
      ) : (
        <section className="panel">
          <h2>同步与安全</h2>
          <p className="hint">账户密码就是同步密码。多台设备、快照和密码保存方式可在这里管理。</p>
          <LazyPanel load={loadSync} panelProps={{ api: sync, disabled }} label="同步与安全" />
        </section>
      )}
    </div>
  );
}
