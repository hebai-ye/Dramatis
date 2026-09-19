import {
  assessAttribution,
  type CharacterInstance,
  type Conversation,
  type ConversationModes,
  type InstanceId,
  type Message,
  type MessageId,
  renderMessageContent,
  type Scene,
} from '@dramatis/core';
import { useEffect, useRef, useState } from 'react';
import { Avatar, MessageBody } from './MessageBody';

interface Props {
  conversation: Conversation;
  scene: Scene | null;
  messages: Message[];
  cast: CharacterInstance[];
  streamText: string;
  streamSpeaker: string;
  reasoningText: string;
  busy: boolean;
  ready: boolean;
  /** 已归档的对话只用于回顾，不能再说话。 */
  archived: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onRegenerate: (id: MessageId) => void;
  onEdit: (id: MessageId, content: string) => void;
  onDelete: (id: MessageId) => void;
  onToggleMode: (key: keyof ConversationModes, value: boolean) => void;
  onOpenScene: () => void;
  /** 从右栏把角色拖进来：进入当前场景。 */
  onDropInstance: (id: InstanceId) => void;
  /** 改归属：这条其实是别人说的（T18）。 */
  onReassign: (id: MessageId, instanceId: InstanceId) => void;
}

const MODE_LABELS: Array<{ key: keyof ConversationModes; label: string; note: string }> = [
  { key: 'playerFirst', label: '角色等我先说', note: '所有角色都必须在你发言之后才能接话' },
  { key: 'silent', label: '静默模式', note: '你连续说话期间，其他角色只能做动作，不能开口' },
  {
    key: 'intentFirst',
    label: '意图先行',
    note: '发言前先花一次便宜调用判断「这一轮谁开口、他想做什么」；关掉可以省一次调用',
  },
];

function shorten(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s*\n\s*/g, ' ');
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}……`;
}

/**
 * 一条回复的用量。
 *
 * 显示成「提示 1.2k / 输出 240」而不是一个总数：BYOK 用户看的是钱，
 * 输入与输出的单价常常不一样（P3-7）。
 */
function formatUsage(usage: Message['usage']): string {
  if (usage === undefined) return '';
  const compact = (value: number): string => (value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value));
  return `提示 ${compact(usage.promptTokens)} / 输出 ${compact(usage.completionTokens)} token`;
}

/**
 * 主对话（LAYOUT「主对话状态」）。
 *
 * 形态是**群聊**：圆形头像、名字、聊天气泡，动作另起一段且不进气泡。
 * 输入区底部那排按钮是规格里点名要有的：加号设置对话模式，场景设置与切换。
 */
export function MainChat({
  conversation,
  scene,
  messages,
  cast,
  streamText,
  streamSpeaker,
  reasoningText,
  busy,
  ready,
  archived,
  onSend,
  onStop,
  onRegenerate,
  onEdit,
  onDelete,
  onToggleMode,
  onOpenScene,
  onDropInstance,
  onReassign,
}: Props) {
  const [input, setInput] = useState('');
  const [editingId, setEditingId] = useState<MessageId | null>(null);
  const [editingText, setEditingText] = useState('');
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const contentLength = messages.reduce((total, message) => total + message.content.length, 0) + streamText.length;

  useEffect(() => {
    if (contentLength === 0) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [contentLength]);

  // 只有最后一条角色回复可以重抽：重抽更早的消息会让后面的对话失去前提
  const lastCharacterId = [...messages].reverse().find((message) => message.role === 'character')?.id ?? null;

  const submit = (): void => {
    if (!ready || busy || archived) return;
    const text = input.trim();
    if (text === '') return;
    onSend(text);
    setInput('');
  };

  const nameOf = (message: Message): string => {
    if (message.role === 'player') return '我';
    const speaker = cast.find((instance) => instance.id === message.speakerInstanceId);
    return speaker?.displayName ?? message.speakerName;
  };

  /**
   * 归属评估（T18）。
   *
   * 纯规则、不调模型；结果只用来提示。每次渲染都算一遍是刻意的——评估很便宜
   * （几次字符串匹配），而缓存它只会让「改了归属之后提示不刷新」这类 bug 有机会出现。
   */
  const attributionOf = (message: Message) =>
    assessAttribution({
      content: message.content,
      speaker: {
        instanceId: message.speakerInstanceId ?? ('' as InstanceId),
        displayName: nameOf(message),
      },
      cast,
    });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 拖拽天生是鼠标动作；键盘路径在角色详情里（在场状态可切换）
    <section
      className={dragOver ? 'chat-surface drop-active' : 'chat-surface'}
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        const dropped = event.dataTransfer.getData('text/dramatis-instance');
        if (dropped !== '') onDropInstance(dropped as InstanceId);
      }}
    >
      <div className="chat-body">
        {archived ? (
          <div className="notice warn">
            <strong>这是一条已归档的对话</strong>
            <p>情绪、关系与记忆已经回滚到它开始之前；这里只用于回顾，不能再接着说话。</p>
          </div>
        ) : null}

        {messages.length === 0 && streamText === '' ? (
          <p className="hint">
            {conversation.kind === 'side'
              ? '让管理员帮你起草角色卡、世界书，或者设置当前场景。'
              : '说点什么。右栏的角色可以直接拖进来。'}
          </p>
        ) : null}

        {messages.map((message) => (
          <article key={message.id} className={`message-row ${message.role}`}>
            {message.role === 'character' ? <Avatar name={nameOf(message)} /> : null}

            <div className="message-column">
              {message.role === 'character' ? <span className="message-name">{nameOf(message)}</span> : null}

              {/*
                他自己声明的意图（P1-6）。放在气泡上方而不是塞进正文：
                它是「为什么这么回」的注解，不是他说出口的话。
              */}
              {message.intent === undefined ? null : (
                <p className="intent-line">
                  {/* 两种来源用不同措辞：他照格式写的，与他实际在想的是两回事 */}
                  {message.intentSource === 'reasoning'
                    ? '盘算：'
                    : message.intentSource === 'planned'
                      ? '他这一轮想：'
                      : '想做：'}
                  {message.intent}
                </p>
              )}

              {/*
                归属可疑提示（T18）。只提示、不自动改：硬改归属比错位更糟，
                所以把「更像是谁说的」摆出来，用户点一下才动数据。
              */}
              {message.role === 'character' && attributionOf(message).suspicious ? (
                <div className="attr-warn">
                  <span>
                    ⚠ 这条可能不是「{nameOf(message)}」说的：{attributionOf(message).reasons[0]}
                  </span>
                  {attributionOf(message).candidates.map((candidate) => (
                    <button
                      key={candidate.instanceId}
                      type="button"
                      className="ghost"
                      disabled={busy || archived}
                      title={candidate.reason}
                      onClick={() => onReassign(message.id, candidate.instanceId)}
                    >
                      改成「{candidate.displayName}」说的
                    </button>
                  ))}
                </div>
              ) : null}

              {editingId === message.id ? (
                <>
                  <textarea rows={4} value={editingText} onChange={(event) => setEditingText(event.target.value)} />
                  <div className="bubble-actions">
                    <button
                      type="button"
                      onClick={() => {
                        onEdit(message.id, editingText);
                        setEditingId(null);
                      }}
                    >
                      保存
                    </button>
                    <button type="button" className="ghost" onClick={() => setEditingId(null)}>
                      取消
                    </button>
                  </div>
                </>
              ) : (
                <MessageBody message={message} speakerName={nameOf(message)} showSpeaker={false}>
                  {message.id === lastCharacterId ? (
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy || archived}
                      title="撤销这条回复，让角色重新说一次"
                      onClick={() => onRegenerate(message.id)}
                    >
                      重抽
                    </button>
                  ) : null}
                  {formatUsage(message.usage) === '' ? null : (
                    <span className="hint usage-hint">{formatUsage(message.usage)}</span>
                  )}
                  {cast.length > 1 && message.role === 'character' ? (
                    <label className="attr-pick">
                      改归属
                      <select
                        value={message.speakerInstanceId ?? ''}
                        disabled={busy || archived}
                        onChange={(event) => onReassign(message.id, event.target.value as InstanceId)}
                      >
                        {cast.map((member) => (
                          <option key={member.id} value={member.id}>
                            {member.displayName}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy || archived}
                    onClick={() => {
                      setEditingId(message.id);
                      setEditingText(message.content);
                    }}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="ghost danger"
                    disabled={busy || archived}
                    onClick={() => {
                      if (window.confirm('删除这条消息？')) onDelete(message.id);
                    }}
                  >
                    删除
                  </button>
                </MessageBody>
              )}
            </div>
          </article>
        ))}

        {reasoningText !== '' ? (
          <details className="reasoning">
            <summary>思考过程</summary>
            <pre>{reasoningText}</pre>
          </details>
        ) : null}

        {streamText !== '' ? (
          <article className="message-row character">
            <Avatar name={streamSpeaker} />
            <div className="message-column streaming">
              <span className="message-name">{streamSpeaker}</span>
              {renderMessageContent(streamText, { speakerName: streamSpeaker }).map((segment, index) =>
                segment.kind === 'action' ? (
                  <p className="action-line" key={`stream-action-${String(index)}`}>
                    {segment.text}
                  </p>
                ) : (
                  <div className="bubble character streaming" key={`stream-speech-${String(index)}`}>
                    <p>{segment.text}</p>
                  </div>
                ),
              )}
            </div>
          </article>
        ) : null}

        <div ref={bottomRef} />
      </div>

      <div className="composer">
        <textarea
          value={input}
          disabled={!ready || archived}
          placeholder={
            archived ? '已归档的对话不能再说话' : ready ? '说点什么……（Enter 发送，Shift+Enter 换行）' : '先导入角色卡'
          }
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />

        <div className="composer-tools">
          <div className="mode-anchor">
            <button
              type="button"
              className="ghost"
              disabled={archived}
              title="设置当前对话的模式"
              onClick={() => setModeMenuOpen((open) => !open)}
            >
              ＋
            </button>
            {modeMenuOpen ? (
              <div className="mode-menu">
                <p className="hint">对话模式（只影响这条对话）</p>
                {MODE_LABELS.map((mode) => (
                  <label key={mode.key} className="mode-option">
                    <input
                      type="checkbox"
                      // 老数据里没有 intentFirst 这个字段，缺省视为开
                      checked={
                        mode.key === 'intentFirst'
                          ? conversation.modes.intentFirst !== false
                          : conversation.modes[mode.key] === true
                      }
                      disabled={archived}
                      onChange={(event) => onToggleMode(mode.key, event.target.checked)}
                    />
                    <span>
                      <strong>{mode.label}</strong>
                      <span className="hint">{mode.note}</span>
                    </span>
                  </label>
                ))}
              </div>
            ) : null}
          </div>

          <button type="button" className="ghost" disabled={archived} title="输入或切换当前场景" onClick={onOpenScene}>
            场景{scene === null ? '' : `：${shorten(scene.title, 10)}`}
          </button>

          <span className="hint">
            {scene === null || scene.location.trim() === '' ? '地点未指定' : shorten(scene.location, 18)}
          </span>

          <div className="topbar-spacer" />

          {busy ? (
            <button type="button" onClick={onStop}>
              停止
            </button>
          ) : (
            <button type="button" disabled={!ready || archived || input.trim() === ''} onClick={submit}>
              发送
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
