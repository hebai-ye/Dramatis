import type { Message, MessageId } from '@dramatis/core';
import { useEffect, useRef, useState } from 'react';

interface Props {
  messages: Message[];
  streamText: string;
  reasoningText: string;
  busy: boolean;
  ready: boolean;
  characterName: string;
  onSend: (text: string) => void;
  onStop: () => void;
  onReset: () => void;
  /** 重抽：撤销这一轮的回复再生成一次（P0-7）。 */
  onRegenerate: (id: MessageId) => void;
  onEdit: (id: MessageId, content: string) => void;
  onDelete: (id: MessageId) => void;
}

export function ChatPanel({
  messages,
  streamText,
  reasoningText,
  busy,
  ready,
  characterName,
  onSend,
  onStop,
  onReset,
  onRegenerate,
  onEdit,
  onDelete,
}: Props) {
  const [input, setInput] = useState('');
  const [editingId, setEditingId] = useState<MessageId | null>(null);
  const [editingText, setEditingText] = useState('');
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // 内容总量变化时把视图滚到底部。用总长度而不是数组本身作为依赖，
  // 避免仅仅因为重新渲染就触发一次滚动。
  const contentLength = messages.reduce((total, message) => total + message.content.length, 0) + streamText.length;

  useEffect(() => {
    if (contentLength === 0) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [contentLength]);

  // 只有最后一条角色回复可以重抽：重抽更早的消息会让后面的对话失去前提
  const lastCharacterId = [...messages].reverse().find((message) => message.role === 'character')?.id ?? null;

  const submit = (): void => {
    if (!ready || busy) return;
    const text = input.trim();
    if (text === '') return;
    onSend(text);
    setInput('');
  };

  return (
    <section className="panel chat">
      <header className="chat-header">
        <h2>{ready ? `与「${characterName}」的对话` : '未载入角色卡'}</h2>
        <button type="button" className="ghost" disabled={!ready || busy} onClick={onReset}>
          重开
        </button>
      </header>

      <div className="chat-body">
        {messages.length === 0 && streamText === '' ? <p className="hint">导入一张角色卡，然后开始说话。</p> : null}

        {messages.map((message) => (
          <article key={message.id} className={`bubble ${message.role}`}>
            <span className="speaker">{message.speakerName}</span>

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
              <>
                <p>{message.content}</p>
                <div className="bubble-actions">
                  {message.id === lastCharacterId ? (
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy}
                      title="撤销这条回复，让角色重新说一次"
                      onClick={() => onRegenerate(message.id)}
                    >
                      重抽
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
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
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm('删除这条消息？')) onDelete(message.id);
                    }}
                  >
                    删除
                  </button>
                </div>
              </>
            )}
          </article>
        ))}

        {reasoningText !== '' ? (
          <details className="reasoning">
            <summary>思考过程</summary>
            <pre>{reasoningText}</pre>
          </details>
        ) : null}

        {streamText !== '' ? (
          <article className="bubble character streaming">
            <span className="speaker">{characterName}</span>
            <p>{streamText}</p>
          </article>
        ) : null}

        <div ref={bottomRef} />
      </div>

      <div className="composer">
        <textarea
          value={input}
          disabled={!ready}
          placeholder={ready ? '说点什么……（Enter 发送，Shift+Enter 换行）' : '先导入角色卡'}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        {busy ? (
          <button type="button" onClick={onStop}>
            停止
          </button>
        ) : (
          <button type="button" disabled={!ready || input.trim() === ''} onClick={submit}>
            发送
          </button>
        )}
      </div>
    </section>
  );
}
