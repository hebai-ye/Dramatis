import type { Conversation, ConversationId } from '@dramatis/core';
import { useEffect, useRef, useState } from 'react';
import { formatTime } from '../lib/format';
import { useDialogActions } from './DialogShell';

interface Result {
  ok: boolean;
  message: string;
}
interface Props {
  archivedConversations: Conversation[];
  activeConversationId: ConversationId | null;
  disabled: boolean;
  onOpenArchived: (id: ConversationId) => void;
  onDeleteArchived: (conversation: Conversation) => Promise<Result>;
  onExportTranscript: (id: ConversationId) => Promise<Result | null>;
}

export function ArchivedConversationsPanel(props: Props) {
  const { requestAction, setGuard } = useDialogActions();
  const [confirmId, setConfirmId] = useState<ConversationId | null>(null);
  const [action, setAction] = useState<{ kind: 'delete' | 'export'; id: ConversationId } | null>(null);
  const [notice, setNotice] = useState<Result | null>(null);
  const busyRef = useRef(false);
  const controlsDisabled = props.disabled || action !== null;

  useEffect(() => {
    setGuard(action === null ? null : { kind: 'busy', message: '归档对话正在处理，请等待完成。' });
    return () => setGuard(null);
  }, [action, setGuard]);

  const run = async (conversation: Conversation, kind: 'delete' | 'export'): Promise<void> => {
    if (props.disabled || busyRef.current) return;
    busyRef.current = true;
    setAction({ kind, id: conversation.id });
    setGuard({ kind: 'busy', message: '归档对话正在处理，请等待完成。' });
    setNotice(null);
    try {
      const result =
        kind === 'delete'
          ? await props.onDeleteArchived(conversation)
          : await props.onExportTranscript(conversation.id);
      setNotice(result);
      if (kind === 'delete' && result?.ok === true) setConfirmId(null);
    } catch (error) {
      setNotice({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      busyRef.current = false;
      setAction(null);
      setGuard(null);
    }
  };

  return (
    <section className="panel" aria-busy={action !== null}>
      <h2>已归档对话</h2>
      <p className="hint">
        归档时，情绪、关系与记忆已回滚到这条对话开始前。正文保留在这里供回顾，无法取消归档；继续聊天需要开新对话。正文导出为
        Markdown，与可导入的封存备份不同。
      </p>
      {props.archivedConversations.length === 0 ? (
        <p className="hint">还没有归档的对话。</p>
      ) : (
        <ul className="room-list">
          {props.archivedConversations.map((conversation) => (
            <li
              key={conversation.id}
              className={conversation.id === props.activeConversationId ? 'archive-item active' : 'archive-item'}
            >
              <button
                type="button"
                className="room-open"
                disabled={controlsDisabled}
                onClick={() => requestAction(() => props.onOpenArchived(conversation.id))}
              >
                <span className="room-title">{conversation.title}</span>
                <span className="hint">归档于 {formatTime(conversation.archivedAt ?? conversation.updatedAt)}</span>
              </button>
              <button
                type="button"
                className="ghost"
                disabled={controlsDisabled}
                onClick={() => run(conversation, 'export')}
              >
                {action?.kind === 'export' && action.id === conversation.id ? '导出中…' : '导出正文'}
              </button>
              <button
                type="button"
                className="ghost danger"
                disabled={controlsDisabled}
                onClick={() => {
                  setConfirmId(conversation.id);
                  setNotice(null);
                }}
              >
                删除
              </button>
              {confirmId === conversation.id ? (
                <div className="notice warn archive-delete-confirm">
                  <p>确认彻底删除「{conversation.title}」？正文与相关记录将被永久删除，此操作无法撤销。</p>
                  <div className="save-bar">
                    <button
                      type="button"
                      className="danger"
                      disabled={controlsDisabled}
                      onClick={() => run(conversation, 'delete')}
                    >
                      {action?.kind === 'delete' && action.id === conversation.id ? '删除中…' : '确认彻底删除'}
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      disabled={controlsDisabled}
                      onClick={() => {
                        setConfirmId(null);
                        setNotice(null);
                      }}
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {notice === null ? null : (
        <div className={notice.ok ? 'notice' : 'notice error'} role={notice.ok ? 'status' : 'alert'}>
          <p>{notice.message.replace(/\*\*/g, '')}</p>
        </div>
      )}
    </section>
  );
}
