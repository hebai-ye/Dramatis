import type { Conversation, ConversationId, Persona } from '@dramatis/core';
import { useState } from 'react';
import type { ProvidersApi } from '../lib/providers';
import { formatBytes, QUOTA_WARN_RATIO, type StorageApi } from '../lib/storage';
import type { SyncApi } from '../lib/sync';
import { PersonaLibrary } from './PersonaLibrary';
import { ProviderPanel } from './ProviderPanel';
import { SyncPanel } from './SyncPanel';

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
  /** 把某条对话的正文导出成可读文件（T12）。 */
  onExportTranscript: (id: ConversationId) => Promise<{ ok: boolean; message: string } | null>;
  /** 本机存储：持久化状态与配额（P2-3）。 */
  storage: StorageApi;
  /** 后端类型（indexeddb / memory），用来如实说明数据存在哪。 */
  backendKind: string;
  /** 多设备同步（P2-6）：服务端地址、用户 id、同步密码。 */
  sync: SyncApi;
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
  onExportTranscript,
  storage,
  backendKind,
  sync,
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
        {/*
          两种用法都摆在这里：填 Key 全自动；不填 Key 也能玩（网页版桥接，
          提示词手动贴）。不给用户「必须先注册一个模型服务」的错觉。
        */}
        <p className="hint">
          填好下面的接口地址、模型名与 API Key 之后，角色回复、记忆抽取、情绪推演都会自动跑。
          <strong>不填也能用</strong>：应用会把每一轮要发的提示词交给你，你贴进 DeepSeek
          网页版，再把回复粘回来——只是每轮多两次复制粘贴。
        </p>
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
        多设备同步（P2-6）：本机加密后上传，服务端只存密文。
        放在「我是谁」之后、封存之前——这三件事是同一条线：
        本机有数据 → 换设备搬 → 多设备自动同步。
      */}
      <section className="panel">
        <h2>同步（多设备）</h2>
        <SyncPanel api={sync} disabled={disabled} />
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

      {/*
        本机存储（P2-3）：数据存在浏览器里，而浏览器默认可以清掉它。
        所以把「有没有拿到持久化」「用掉多少」直接摆出来。
      */}
      <section className="panel">
        <h2>本机存储</h2>
        <ul className="usage-list">
          <li>
            <span className="usage-name">存储后端</span>
            <span className="usage-figure">{backendKind || '…'}</span>
          </li>
          <li>
            <span className="usage-name">持久化</span>
            <span className="usage-figure">
              {storage.status.supported ? (storage.status.persisted ? '已获得' : '未获得') : '这个浏览器不支持'}
            </span>
          </li>
          <li>
            <span className="usage-name">已用 / 配额</span>
            <span className="usage-figure">
              {storage.status.usage === null || storage.status.quota === null
                ? '未知'
                : `${formatBytes(storage.status.usage)} / ${formatBytes(storage.status.quota)}`}
            </span>
          </li>
        </ul>
        <div className="save-bar">
          <button
            type="button"
            disabled={disabled || !storage.status.supported || storage.status.persisted === true}
            onClick={() => void storage.requestPersist()}
          >
            申请持久化存储
          </button>
        </div>
        <p className="hint">
          {storage.status.persisted === true
            ? '已经拿到持久化：浏览器不会因为磁盘紧张或你很久没打开就清掉这些数据。'
            : '没拿到持久化时，浏览器随时可能回收本地数据；拿到它通常要靠「把本站装到桌面 / 加进收藏」——这也是 PWA 那一步在做的事。无论哪种情况，导出封存都是最稳的备份。'}
        </p>
        {storage.ratio !== null && storage.ratio >= QUOTA_WARN_RATIO ? (
          <div className="notice warn">
            <p>浏览器给这个站点的空间已经用掉 {Math.round(storage.ratio * 100)}%，再写可能失败。建议先导出一份封存。</p>
          </div>
        ) : null}
      </section>

      <section className="panel">
        <h2>已归档的对话</h2>
        <p className="hint">
          归档意味着这条时间线没有发生过：情绪、关系与记忆都已经回滚到它开始之前。对话本身保留在这里， 只用于回顾——
          <strong>没有「取消归档」</strong>，要接着往下聊得开一条新对话；但你可以把正文导出带走
          （导出的是当时一句句说了什么，与「封存」那份可再导入的数据文件不是一回事）。
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
                  className="ghost"
                  disabled={disabled || archiveBusy}
                  title="把这条对话的正文导出成 Markdown 文件"
                  onClick={() => void runArchive(() => onExportTranscript(conversation.id))}
                >
                  导出正文
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
