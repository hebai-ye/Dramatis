import { useEffect, useRef, useState } from 'react';
import type { Message } from '@dramatis/core';

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
}: Props) {
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamText]);

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
        {messages.length === 0 && streamText === '' ? (
          <p className="hint">导入一张角色卡，然后开始说话。</p>
        ) : null}

        {messages.map((message) => (
          <article key={message.id} className={`bubble ${message.role}`}>
            <span className="speaker">{message.speakerName}</span>
            <p>{message.content}</p>
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
