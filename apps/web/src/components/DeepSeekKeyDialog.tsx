import { type FormEvent, useEffect, useRef, useState } from 'react';
import { type DeepSeekSetupReceipt, deepseekSetupState } from '../lib/deepseek-setup';
import type { ProvidersApi } from '../lib/providers';
import { DialogShell, useDialogActions } from './DialogShell';

export function DeepSeekKeyDialog({
  providers,
  onClose,
  onRecover,
  returnFocus,
}: {
  providers: ProvidersApi;
  onClose: () => void;
  onRecover: () => void;
  returnFocus: HTMLElement | null;
}) {
  const [owner] = useState(() => providers.setupOwner);
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [awaiting, setAwaiting] = useState<(DeepSeekSetupReceipt & { key: string }) | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const latest = useRef(providers);
  latest.current = providers;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (awaiting === null) return;
    if (
      providers.setupOwner?.context !== owner?.context ||
      (providers.activeId === awaiting.profileId &&
        (providers.active?.baseUrl !== awaiting.baseUrl || providers.active?.keyRef !== awaiting.keyRef)) ||
      (providers.setupOwner?.token !== owner?.token && providers.activeId !== awaiting.profileId)
    ) {
      setError('配置目标已变化，请关闭后重新配置。');
      setAwaiting(null);
      pending.current = false;
    } else if (providers.keyError !== null || providers.vaultLocked) {
      setError('API Key 读取未完成，请核对后重试。');
      pending.current = false;
    } else if (providers.activeId === awaiting.profileId && !providers.keyLoading) {
      if (providers.apiKey === awaiting.key) onClose();
      else {
        setError('API Key 保存结果未确认，请核对后重试。');
        pending.current = false;
      }
    }
  }, [awaiting, providers, owner, onClose]);
  const availability = deepseekSetupState(providers);
  useEffect(() => {
    if (awaiting === null && !saving && key === '' && availability === 'configured') onClose();
  }, [awaiting, saving, key, availability, onClose]);
  const busy = saving || (awaiting !== null && providers.keyLoading);
  const changedOwner = providers.setupOwner?.token !== owner?.token;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending.current || awaiting !== null || key.trim() === '') return;
    if (!owner || changedOwner) {
      setError('配置目标已变化，请关闭后重新配置。');
      return;
    }
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await providers.saveDeepSeekKey(key, owner);
      if (!mounted.current) return;
      const current = latest.current;
      if (
        current.setupOwner?.context !== owner.context ||
        (current.setupOwner?.token !== owner.token && current.activeId !== result.profileId)
      )
        throw new Error('配置目标已变化，请关闭后核对已保存内容。');
      setAwaiting({ ...result, key: key.trim() });
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
      pending.current = false;
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  const recovery =
    key === '' && (availability === 'locked' || availability === 'read-error' || availability === 'waiting');
  return (
    <DialogShell
      label="配置 DeepSeek API Key"
      className="deepseek-key-dialog"
      returnFocus={returnFocus}
      onClose={onClose}
      initialFocus={recovery ? '[data-key-recovery]' : '[data-key-input]'}
      guard={
        busy
          ? { kind: 'busy', message: '正在保存 API Key，请等待完成。' }
          : key !== ''
            ? { kind: 'dirty', message: 'API Key 尚未保存，关闭将放弃输入。' }
            : null
      }
    >
      {recovery ? (
        <section className="deepseek-key-form">
          <p role="alert">
            {availability === 'locked'
              ? '密钥库未解锁。'
              : availability === 'waiting'
                ? '正在读取 API Key…'
                : `API Key 读取失败：${providers.keyError ?? '请重新读取。'}`}
          </p>
          <button
            data-key-recovery
            type="button"
            disabled={availability === 'waiting'}
            onClick={() => {
              if (availability === 'read-error') providers.reloadApiKey();
              else {
                onClose();
                onRecover();
              }
            }}
          >
            {availability === 'locked' ? '解锁已有密钥' : '重新读取'}
          </button>
          <button type="button" className="ghost" onClick={onClose}>
            稍后处理
          </button>
        </section>
      ) : (
        <form className="deepseek-key-form" onSubmit={(event) => void submit(event)}>
          <p className="hint">建议先配置 API Key，直接发送消息。</p>
          <label>
            API Key
            <span className="key-input-row">
              <input
                data-key-input
                autoComplete="off"
                spellCheck={false}
                type={showKey ? 'text' : 'password'}
                value={key}
                disabled={busy || awaiting !== null}
                placeholder="粘贴 DeepSeek API Key"
                onChange={(event) => setKey(event.target.value)}
              />
              <button
                type="button"
                className="ghost"
                disabled={busy}
                aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
                onClick={() => setShowKey((value) => !value)}
              >
                {showKey ? '隐藏' : '显示'}
              </button>
            </span>
          </label>
          <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">
            申请 API Key
          </a>
          {error === null && (!changedOwner || awaiting !== null) ? null : (
            <p className="notice error" role="alert">
              {error ?? '配置目标已变化，请关闭后重新配置。'} 输入已保留。
            </p>
          )}
          <div className="save-bar">
            {awaiting !== null ? (
              <button
                type="button"
                disabled={busy || providers.vaultLocked}
                onClick={() => {
                  setError(null);
                  providers.reloadApiKey();
                }}
              >
                {busy ? '正在读取…' : '重新读取'}
              </button>
            ) : (
              <button type="submit" disabled={busy || changedOwner || key.trim() === ''}>
                {busy ? '保存中…' : error ? '重试保存' : '保存并继续'}
              </button>
            )}
            <LaterButton onClose={onClose} disabled={busy} />
          </div>
          <p className="hint">
            {owner?.keyMode === 'session'
              ? 'Key 仅用于本次会话。'
              : owner?.keyMode === 'encrypted'
                ? 'Key 加密保存在本机浏览器。'
                : 'Key 明文保存在本机浏览器。'}{' '}
            调用费用以 DeepSeek 账单为准。
          </p>
        </form>
      )}
    </DialogShell>
  );
}

function LaterButton({ onClose, disabled }: { onClose: () => void; disabled: boolean }) {
  const { requestAction } = useDialogActions();
  return (
    <button type="button" className="ghost" disabled={disabled} onClick={() => requestAction(onClose)}>
      稍后配置
    </button>
  );
}
