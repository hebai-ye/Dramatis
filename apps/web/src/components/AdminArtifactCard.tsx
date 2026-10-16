import type { AdminArtifact } from '@dramatis/core';
import { useRef, useState } from 'react';
import type { ArtifactAction, ArtifactActionResult } from '../lib/admin-artifact-actions';
import { AdminDraftPreview } from './AdminDraftPreview';
import { Modal } from './Modal';

const KIND: Record<AdminArtifact['kind'], string> = {
  'character-card': '角色卡',
  'world-book': '世界书',
  'persona-upsert': '身份',
  'persona-delete': '删除身份',
  scene: '场景',
};
const STATUS: Record<AdminArtifact['status'], string> = {
  pending: '草稿已保存 · 待采纳',
  adopted: '已采纳 · 已保存到素材库',
  discarded: '已丢弃',
  applied: '已生效 · 已保存',
};
interface Props {
  artifact: AdminArtifact;
  disabled: boolean;
  exists: boolean;
  scopeKey: string;
  targetLabel?: string;
  onAdopt: (() => void) | (() => Promise<ArtifactActionResult>);
  onDiscard: (() => void) | (() => Promise<ArtifactActionResult>);
  onRevoke?: (() => void) | (() => Promise<ArtifactActionResult>);
  onInspect?: (action: ArtifactAction) => Promise<ArtifactActionResult>;
  onOpenTarget?: () => void;
  onReadHistory?: () => void;
}
export function AdminArtifactCard({
  artifact,
  disabled,
  exists,
  scopeKey,
  targetLabel,
  onAdopt,
  onDiscard,
  onRevoke,
  onInspect,
  onOpenTarget,
  onReadHistory,
}: Props) {
  const identity = `${scopeKey}:${artifact.id}`;
  const owner = useRef({ key: identity, pending: false });
  if (owner.current.key !== identity) owner.current = { key: identity, pending: false };
  const [feedback, setFeedback] = useState<{
    key: string;
    pending: ArtifactAction | null;
    action: ArtifactAction;
    result: ArtifactActionResult | null;
  } | null>(null);
  const [preview, setPreview] = useState<{ key: string; focus: HTMLElement | null } | null>(null);
  const [confirm, setConfirm] = useState<{ key: string; kind: 'revoke' | 'delete' } | null>(null);
  const local = feedback?.key === identity ? feedback : null;
  const result = local?.result;
  const shown = result && 'artifact' in result ? result.artifact : artifact;
  const uncertain = result?.status === 'uncertain';
  const pending = local?.pending ?? null;
  const payload = shown.payload as { description?: unknown; entries?: unknown } | null;
  const summary = typeof payload?.description === 'string' ? payload.description : '';
  const count = Array.isArray(payload?.entries) ? payload.entries.length : 0;
  const canWrite = !disabled && !pending && !uncertain;
  const act = async (action: ArtifactAction, inspect = false) => {
    if (owner.current.pending || disabled || (!inspect && uncertain)) return;
    const token = owner.current;
    token.pending = true;
    setFeedback({ key: identity, pending: action, action, result: null });
    try {
      const response = inspect
        ? await onInspect?.(action)
        : await (action === 'adopt' ? onAdopt() : action === 'discard' ? onDiscard() : onRevoke?.());
      if (owner.current === token)
        setFeedback({
          key: identity,
          pending: null,
          action,
          result: response ?? { status: 'uncertain', reason: '操作结果未确认，请先核对记录。' },
        });
    } catch (error) {
      if (owner.current === token)
        setFeedback({
          key: identity,
          pending: null,
          action,
          result: {
            status: 'uncertain',
            reason: `结果待核对。${error instanceof Error ? error.message : String(error)}`,
          },
        });
    } finally {
      token.pending = false;
    }
  };
  const revokeText =
    shown.kind === 'persona-upsert' && shown.previousPayload !== undefined
      ? `撤回会恢复采纳前的身份内容，并覆盖之后的修改。`
      : `撤回会删除素材库中的「${shown.title}」，包括采纳后对它的修改；草稿会回到待采纳。`;
  return (
    <section className={`artifact ${shown.status}`} aria-label={`${KIND[shown.kind]}：${shown.title}`}>
      <div className="artifact-head">
        <span className="tag accent">{KIND[shown.kind]}</span>
        <strong>{shown.title}</strong>
        <span className="hint">
          {pending
            ? pending === 'adopt'
              ? '采纳中…'
              : pending === 'discard'
                ? '丢弃中…'
                : '撤回中…'
            : shown.kind === 'scene' && shown.status === 'pending'
              ? '未应用'
              : STATUS[shown.status]}
        </span>
      </div>
      <p className="hint">{shown.summary}</p>
      {summary ? (
        <p className="hint artifact-preview">{summary.length > 100 ? `${summary.slice(0, 100)}…` : summary}</p>
      ) : null}
      {count > 0 ? <p className="hint">共 {count} 条词条</p> : null}
      {shown.kind === 'scene' ? (
        <p className="hint">
          {shown.status === 'pending'
            ? '这个世界还没有可应用的主对话，请先新建主对话，再重新设置。'
            : (targetLabel ?? '已生效于当时的主对话')}
        </p>
      ) : (
        <p className="hint">保存位置：当前账户素材库</p>
      )}
      {shown.kind === 'world-book' && exists && shown.status === 'pending' ? (
        <p className="hint warn">采纳会整本替换目标世界书「{shown.title}」，不会追加条目。</p>
      ) : null}
      {shown.conflict ? <p className="hint warn">{shown.conflict}</p> : null}
      {shown.kind === 'persona-delete' && shown.status === 'pending' ? (
        <p className="hint warn">确认后删除这份身份；此处不能撤回。</p>
      ) : null}
      {result && 'reason' in result ? (
        <p className="notice error" role="alert">
          {result.reason}
        </p>
      ) : null}
      <div className="inline admin-artifact-actions">
        <button
          type="button"
          className="ghost"
          onClick={(event) => {
            onReadHistory?.();
            setPreview({ key: identity, focus: event.currentTarget });
          }}
        >
          查看草稿
        </button>
        {shown.status === 'pending' && shown.kind !== 'scene' ? (
          <>
            <button
              type="button"
              disabled={!canWrite || shown.conflict !== undefined}
              className={shown.kind === 'persona-delete' ? 'ghost danger' : undefined}
              onClick={() =>
                shown.kind === 'persona-delete' ? setConfirm({ key: identity, kind: 'delete' }) : act('adopt')
              }
            >
              {shown.kind === 'persona-delete' ? '确认删除身份' : '采纳'}
            </button>
            <button type="button" className="ghost danger" disabled={!canWrite} onClick={() => act('discard')}>
              丢弃
            </button>
          </>
        ) : null}
        {shown.kind === 'scene' && shown.status === 'pending' ? (
          <button type="button" className="ghost danger" disabled={!canWrite} onClick={() => act('discard')}>
            丢弃
          </button>
        ) : null}
        {shown.status === 'adopted' && onRevoke && shown.kind !== 'persona-delete' ? (
          <button
            type="button"
            className="ghost"
            disabled={!canWrite}
            onClick={() => setConfirm({ key: identity, kind: 'revoke' })}
          >
            撤回这次采纳
          </button>
        ) : null}
        {shown.status === 'adopted' && onOpenTarget ? (
          <button type="button" className="ghost" onClick={onOpenTarget}>
            打开素材库
          </button>
        ) : null}
        {(uncertain || result?.status === 'saved-read-failed') && onInspect ? (
          <button type="button" disabled={!!pending || disabled} onClick={() => act(local?.action ?? 'adopt', true)}>
            {uncertain ? '核对保存结果' : '重新读取'}
          </button>
        ) : null}
      </div>
      {preview?.key === identity ? (
        <AdminDraftPreview
          artifact={shown}
          sourceLabel={targetLabel ?? '当前账户素材库'}
          returnFocus={preview.focus}
          onClose={() => setPreview(null)}
        />
      ) : null}
      {confirm?.key === identity ? (
        <Modal
          label={confirm.kind === 'revoke' ? '撤回采纳' : '删除身份'}
          onClose={() => setConfirm(null)}
          head={<strong>{shown.title}</strong>}
          footer={
            <>
              <button type="button" className="ghost" onClick={() => setConfirm(null)}>
                取消
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  const action = confirm.kind === 'revoke' ? 'revoke' : 'adopt';
                  setConfirm(null);
                  void act(action);
                }}
              >
                {confirm.kind === 'revoke' ? '确认撤回采纳' : '确认删除身份'}
              </button>
            </>
          }
        >
          <p>{confirm.kind === 'revoke' ? revokeText : `删除素材库中的身份「${shown.title}」；此处不能撤回。`}</p>
        </Modal>
      ) : null}
    </section>
  );
}
