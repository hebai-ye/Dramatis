import type { AdminArtifact, Conversation, Message, MessageId } from '@dramatis/core';
import { useEffect, useRef, useState } from 'react';
import { WebBridgePanel } from './WebBridgePanel';

interface Props {
  conversation: Conversation;
  messages: Message[];
  streamText: string;
  busy: boolean;
  ready: boolean;
  archived: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onAdopt: (messageId: MessageId, artifact: AdminArtifact) => void;
  onDiscard: (messageId: MessageId, artifact: AdminArtifact) => void;
  /** 没有 API Key 时，起草这一步走网页版桥接。 */
  bridge?: { prompt: string } | null;
  /** 没配 API Key：发送按钮改成「生成提示词」，别让人以为点了会直接有回复。 */
  manualMode?: boolean;
  onBridgeCommit?: (text: string) => void;
  onBridgeCancel?: () => void;
}

const STATUS_LABEL: Record<AdminArtifact['status'], string> = {
  pending: '待你决定',
  adopted: '已采纳',
  discarded: '已丢弃',
  applied: '已生效',
};

function ArtifactCard({
  artifact,
  disabled,
  onAdopt,
  onDiscard,
}: {
  artifact: AdminArtifact;
  disabled: boolean;
  onAdopt: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className={`artifact ${artifact.status}`}>
      <div className="artifact-head">
        <span className="tag accent">
          {artifact.kind === 'character-card' ? '角色卡' : artifact.kind === 'world-book' ? '世界书' : '场景'}
        </span>
        <strong>{artifact.title}</strong>
        <span className="hint">{STATUS_LABEL[artifact.status]}</span>
      </div>
      <p className="hint">{artifact.summary}</p>

      {artifact.status === 'pending' ? (
        <div className="inline">
          <button type="button" disabled={disabled} onClick={onAdopt}>
            采纳
          </button>
          <button type="button" className="ghost danger" disabled={disabled} onClick={onDiscard}>
            丢弃
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 副对话（LAYOUT「副对话状态」）。
 *
 * 界面上是「世界管理员与用户」的对话，内容是正常的 AI 工作流：创建角色、
 * 创建设定。**不用气泡**——因为它不是在扮演谁，气泡会让人误以为管理员是
 * 场上的一员。此时 AI 不是任何角色。
 *
 * 管理员产出的角色卡与世界卡由用户决定去留：草稿摆在正文下面，
 * 点「采纳」才进素材库。
 */
export function SideChat({
  conversation,
  messages,
  streamText,
  busy,
  ready,
  archived,
  onSend,
  onStop,
  onAdopt,
  onDiscard,
  bridge = null,
  manualMode = false,
  onBridgeCommit,
  onBridgeCancel,
}: Props) {
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const contentLength = messages.reduce((total, message) => total + message.content.length, 0) + streamText.length;

  useEffect(() => {
    if (contentLength === 0) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [contentLength]);

  const submit = (): void => {
    if (!ready || busy || archived) return;
    const text = input.trim();
    if (text === '') return;
    onSend(text);
    setInput('');
  };

  return (
    <section className="chat-surface side">
      <div className="chat-body">
        <div className="admin-hint">
          <strong>世界管理员</strong>
          <span className="hint">帮你起草角色卡、世界书与场景设置。它不扮演任何角色，产出的素材由你决定去留。</span>
        </div>

        {messages.length === 0 && streamText === '' ? (
          <p className="hint">例如：「按这个世界的风格，起草一个酒馆老板，再补一段旧城的设定。」</p>
        ) : null}

        {messages.map((message) => (
          <article key={message.id} className={`admin-row ${message.role}`}>
            <span className="admin-role">
              {message.role === 'admin' ? '管理员' : message.role === 'player' ? '我' : message.role}
            </span>
            <div className="admin-text">{message.content}</div>

            {message.artifacts?.map((artifact) => (
              <ArtifactCard
                key={artifact.id}
                artifact={artifact}
                disabled={busy || archived}
                onAdopt={() => onAdopt(message.id, artifact)}
                onDiscard={() => onDiscard(message.id, artifact)}
              />
            ))}
          </article>
        ))}

        {streamText !== '' ? (
          <article className="admin-row admin">
            <span className="admin-role">管理员</span>
            <div className="admin-text streaming">{streamText}</div>
          </article>
        ) : null}

        <div ref={bottomRef} />
      </div>

      {bridge === null || onBridgeCommit === undefined ? null : (
        <WebBridgePanel
          bridge={{ stage: 'admin', prompt: bridge.prompt }}
          busy={busy}
          disabled={archived}
          onReply={() => {}}
          onAnalysis={() => {}}
          onAdmin={onBridgeCommit}
          onSkip={onBridgeCancel ?? (() => {})}
        />
      )}

      <div className="composer">
        <textarea
          value={input}
          disabled={!ready || archived}
          placeholder={archived ? '已归档的对话不能再说话' : '告诉管理员你想搭什么……（Enter 发送）'}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-tools">
          <span className="hint">{conversation.title}</span>
          <div className="topbar-spacer" />
          {busy ? (
            <button type="button" onClick={onStop}>
              停止
            </button>
          ) : (
            <button
              type="button"
              disabled={!ready || archived || input.trim() === '' || bridge !== null}
              title={bridge === null ? undefined : '先把这一轮贴回来（或点「放弃这次起草」）再发下一句'}
              onClick={submit}
            >
              {bridge === null && manualMode ? '生成提示词' : '发送'}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
