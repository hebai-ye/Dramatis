import type { Conversation, ConversationId, Persona } from '@dramatis/core';
import { useState } from 'react';
import type { ProvidersApi } from '../lib/providers';
import { PersonaLibrary } from './PersonaLibrary';
import { ProviderPanel } from './ProviderPanel';

interface Props {
  providers: ProvidersApi;
  personas: Persona[];
  activePersonaId: string | null;
  archivedConversations: Conversation[];
  activeConversationId: ConversationId | null;
  disabled: boolean;
  onSelectPersona: (persona: Persona) => void;
  onSavePersona: (persona: Persona) => void;
  onDeletePersona: (id: string) => void;
  onOpenArchived: (id: ConversationId) => void;
  onDeleteArchived: (conversation: Conversation) => void;
  /** 导出当前世界；返回给用户看的一句话（取消时是 null）。 */
  onExportArchive: () => Promise<{ ok: boolean; message: string } | null>;
  /** 选一个封存文件导进来。 */
  onImportArchive: () => Promise<{ ok: boolean; message: string } | null>;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * 设置（LAYOUT「左栏 · 底部：设置，用于配置 API 等；已归档的对话也从这里打开」）。
 *
 * 归档后的对话不在主列表里，但没有消失——它被保存在这里。这样「这条时间线
 * 没有发生过」与「我还能回头看看当时聊了什么」两件事可以同时成立。
 */
export function SettingsPanel({
  providers,
  personas,
  activePersonaId,
  archivedConversations,
  activeConversationId,
  disabled,
  onSelectPersona,
  onSavePersona,
  onDeletePersona,
  onOpenArchived,
  onDeleteArchived,
  onExportArchive,
  onImportArchive,
}: Props) {
  const [archiveNotice, setArchiveNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);

  const runArchive = async (action: () => Promise<{ ok: boolean; message: string } | null>): Promise<void> => {
    setArchiveBusy(true);
    setArchiveNotice(null);
    try {
      const result = await action();
      if (result !== null) setArchiveNotice(result);
    } catch (error) {
      setArchiveNotice({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setArchiveBusy(false);
    }
  };

  return (
    <div className="stack">
      <section className="panel">
        <h2>模型接入</h2>
        <ProviderPanel api={providers} disabled={disabled} />
      </section>

      <section className="panel">
        <h2>我是谁</h2>
        <PersonaLibrary
          personas={personas}
          activeId={activePersonaId}
          disabled={disabled}
          onSelect={onSelectPersona}
          onSave={onSavePersona}
          onDelete={onDeletePersona}
        />
      </section>

      {/*
        封存（P2-4）：把一整个世界存成一个文件带走。
        它同时是云同步之前的过渡方案、也是移动端的数据安全网——手机浏览器
        随时可能把本地数据清掉。
      */}
      <section className="panel">
        <h2>封存（导出 / 导入）</h2>
        <p className="hint">
          导出的是一整个世界：对话、场景、角色与角色卡、消息、记忆、情绪关系、前情章节、世界书、账单——一个文件，
          换台设备导进来就能接着用。导入永远是<strong>新建一条世界线</strong>，不会覆盖或改动本机已有的数据。
        </p>
        <div className="save-bar">
          <button
            type="button"
            disabled={disabled || archiveBusy || activeConversationId === null}
            onClick={() => void runArchive(onExportArchive)}
          >
            {archiveBusy ? '处理中…' : '导出这个世界'}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={disabled || archiveBusy}
            onClick={() => void runArchive(onImportArchive)}
          >
            导入封存
          </button>
        </div>
        {activeConversationId === null ? <p className="hint">先打开一个世界，才能导出。</p> : null}
        {archiveNotice === null ? null : (
          <div className={archiveNotice.ok ? 'notice' : 'notice error'}>
            <p>{archiveNotice.message.replace(/\*\*/g, '')}</p>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>已归档的对话</h2>
        <p className="hint">
          归档意味着这条时间线没有发生过：情绪、关系与记忆都已经回滚到它开始之前。对话本身保留在这里，只用于回顾。
        </p>

        {archivedConversations.length === 0 ? (
          <p className="hint">还没有归档的对话。</p>
        ) : (
          <ul className="room-list">
            {archivedConversations.map((conversation) => (
              <li key={conversation.id} className={conversation.id === activeConversationId ? 'active' : ''}>
                <button
                  type="button"
                  className="room-open"
                  disabled={disabled}
                  onClick={() => onOpenArchived(conversation.id)}
                >
                  <span className="room-title">{conversation.title}</span>
                  <span className="hint">归档于 {formatTime(conversation.archivedAt ?? conversation.updatedAt)}</span>
                </button>
                <button
                  type="button"
                  className="ghost danger"
                  disabled={disabled}
                  title="彻底删除，不可恢复"
                  onClick={() => {
                    if (window.confirm(`彻底删除已归档的「${conversation.title}」？`)) onDeleteArchived(conversation);
                  }}
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
