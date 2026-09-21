import type { AdminArtifact, Conversation, Message, MessageId } from '@dramatis/core';
import { useEffect, useRef, useState } from 'react';
import { IconSend, IconStop } from './Icons';
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
  onRevoke?: (messageId: MessageId, artifact: AdminArtifact) => void;
  /** 素材库里现在有哪些 id（判「整本替换」用：草稿的 payload.id 已经在那儿了）。 */
  existingIds?: readonly string[];
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

const ARTIFACT_LABEL: Record<AdminArtifact['kind'], string> = {
  'character-card': '角色卡',
  'world-book': '世界书',
  'persona-upsert': '玩家身份',
  'persona-delete': '删除身份',
  scene: '场景',
};

function ArtifactCard({
  artifact,
  disabled,
  exists,
  onAdopt,
  onDiscard,
  onRevoke,
}: {
  artifact: AdminArtifact;
  disabled: boolean;
  /** 这个草稿要落成的东西**现在**在不在素材库里（在 = 这是「整本替换」）。 */
  exists: boolean;
  onAdopt: () => void;
  onDiscard: () => void;
  onRevoke?: () => void;
}) {
  /*
   * 草稿预览（顺序 26）：卡片在采纳之前要能看出「它到底长什么样」。
   * 角色卡给开场白（`firstMes`）——那是最能判断「这个角色合不合世界」的一句；
   * 世界书给前几条词条，让人看得到粒度。
   */
  // 字段名跟着 `Card` 走：开场白叫 `firstMessage`（不是 firstMes），别自己造一个
  const payload = artifact.payload as {
    firstMessage?: unknown;
    description?: unknown;
    entries?: unknown;
  } | null;
  const firstMes = typeof payload?.firstMessage === 'string' ? payload.firstMessage.trim() : '';
  const description = typeof payload?.description === 'string' ? payload.description.trim() : '';
  const entryCount = Array.isArray(payload?.entries) ? payload.entries.length : 0;

  return (
    <div className={`artifact ${artifact.status}`}>
      <div className="artifact-head">
        <span className="tag accent">{ARTIFACT_LABEL[artifact.kind]}</span>
        <strong>{artifact.title}</strong>
        <span className="hint">{STATUS_LABEL[artifact.status]}</span>
      </div>
      <p className="hint">{artifact.summary}</p>

      {firstMes === '' ? null : (
        <p className="artifact-preview">
          <span className="hint">开场白：</span>
          {firstMes.length > 64 ? `${firstMes.slice(0, 64)}…` : firstMes}
        </p>
      )}
      {description === '' ? null : (
        <p className="hint artifact-preview">
          设定：{description.length > 56 ? `${description.slice(0, 56)}…` : description}
        </p>
      )}
      {entryCount === 0 ? null : <p className="hint">共 {String(entryCount)} 条词条</p>}

      {/*
        顺序 26：「整本替换」必须说清楚。
        世界书的采纳是**整份覆盖**（id 相同就替换），而用户很容易以为它是「追加几条」。
      */}
      {artifact.kind === 'world-book' && exists ? (
        <p className="hint warn">
          采纳会<strong>整本替换</strong>素材库里同名那一份（不是追加）。
        </p>
      ) : null}

      {artifact.status === 'pending' ? (
        <div className="inline">
          <button
            type="button"
            className={artifact.kind === 'persona-delete' ? 'ghost danger' : undefined}
            disabled={disabled}
            onClick={onAdopt}
          >
            {artifact.kind === 'persona-delete' ? '确认删除' : '采纳'}
          </button>
          <button type="button" className="ghost danger" disabled={disabled} onClick={onDiscard}>
            丢弃
          </button>
        </div>
      ) : null}

      {artifact.status === 'adopted' && onRevoke !== undefined && artifact.kind !== 'persona-delete' ? (
        <div className="inline">
          <span className="hint">已进素材库</span>
          <button
            type="button"
            className="ghost"
            disabled={disabled}
            title="删掉刚进素材库的那一份，草稿退回「待采纳」——当作这次采纳没发生过"
            onClick={onRevoke}
          >
            撤回这次采纳
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
  onRevoke,
  existingIds = [],
  bridge = null,
  manualMode = false,
  onBridgeCommit,
  onBridgeCancel,
}: Props) {
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const contentLength = messages.reduce((total, message) => total + message.content.length, 0) + streamText.length;

  useEffect(() => {
    if (contentLength === 0) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [contentLength]);

  // 与主对话的输入框同一条规则：跟着字数长高，最多 200px
  // biome-ignore lint/correctness/useExhaustiveDependencies: 同上——跟着 input 重跑，但读的是 DOM 的实际高度
  useEffect(() => {
    const node = inputRef.current;
    if (node === null) return;
    node.style.height = 'auto';
    node.style.height = `${String(Math.min(node.scrollHeight, 200))}px`;
  }, [input]);

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
                exists={
                  (artifact.kind === 'character-card' ||
                    artifact.kind === 'world-book' ||
                    artifact.kind === 'persona-upsert') &&
                  typeof (artifact.payload as { id?: unknown } | null)?.id === 'string' &&
                  (existingIds ?? []).includes((artifact.payload as { id: string }).id)
                }
                onAdopt={() => onAdopt(message.id, artifact)}
                onDiscard={() => onDiscard(message.id, artifact)}
                {...(onRevoke === undefined ? {} : { onRevoke: () => onRevoke(message.id, artifact) })}
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

      {/* 与主对话同一个输入区形态（用户 2026-09-21 要求照 Codex 的样子） */}
      <div className="composer">
        <div className="composer-box">
          <textarea
            ref={inputRef}
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
            <span className="composer-location">{conversation.title}</span>
            <div className="topbar-spacer" />
            {busy ? (
              <button
                type="button"
                className="composer-action stop"
                title="停止这一轮"
                aria-label="停止"
                onClick={onStop}
              >
                <IconStop />
              </button>
            ) : (
              <button
                type="button"
                disabled={!ready || archived || input.trim() === '' || bridge !== null}
                title={bridge === null ? undefined : '先把这一轮贴回来（或点「放弃这次起草」）再发下一句'}
                aria-label={bridge === null && manualMode ? '生成提示词' : '发送'}
                className={bridge === null && manualMode ? 'composer-action labelled' : 'composer-action'}
                onClick={submit}
              >
                <IconSend />
                {bridge === null && manualMode ? <span>生成提示词</span> : null}
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
