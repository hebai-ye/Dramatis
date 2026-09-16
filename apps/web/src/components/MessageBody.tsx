import { type Message, renderMessageContent } from '@dramatis/core';
import type { ReactNode } from 'react';

interface Props {
  message: Message;
  /** 只有多角色同场时需要每段都标名字，单独说话时标一次就够。 */
  showSpeaker: boolean;
  /** 挂在最后一段上的操作按钮（重抽 / 编辑 / 删除）。 */
  children?: ReactNode;
}

/** 用名字算一个稳定的颜色，省掉头像素材也能把角色区分开。 */
export function avatarColor(name: string): string {
  let hash = 0;
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    hash = (hash * 31 + code) % 360;
  }
  return `hsl(${String(hash)} 45% 38%)`;
}

export function Avatar({ name, size = 34 }: { name: string; size?: number }) {
  return (
    <span className="avatar" style={{ background: avatarColor(name), width: size, height: size }} title={name}>
      {name.trim().slice(0, 1)}
    </span>
  );
}

/**
 * 一条消息的正文（LAYOUT「主对话状态」）。
 *
 * 规格要求在这里做三件容易做错的事：
 * - 角色动作用 `#` 新开一段，**且不在气泡内**
 * - 一段话里掺杂动作时切分成多段：对白 → 动作 → 对白
 * - 长对话拆成多个短气泡，显出真人感
 *
 * 切分规则住在内核（`renderMessageContent`），这里只负责把它画出来。
 */
export function MessageBody({ message, showSpeaker, children }: Props) {
  if (message.role === 'narration' || message.role === 'system') {
    return <p className="narration-line">{message.content}</p>;
  }

  const segments = renderMessageContent(message.content);
  const lastSpeechIndex = segments.reduce((last, segment, index) => (segment.kind === 'speech' ? index : last), -1);

  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === 'action' ? (
          <p className="action-line" key={`action-${String(index)}`}>
            {segment.text}
          </p>
        ) : (
          <div className={`bubble ${message.role}`} key={`speech-${String(index)}`}>
            {showSpeaker && index === 0 ? <span className="speaker">{message.speakerName}</span> : null}
            <p>{segment.text}</p>
            {children !== undefined && index === lastSpeechIndex ? (
              <div className="bubble-actions">{children}</div>
            ) : null}
          </div>
        ),
      )}

      {/* 整条消息只有动作时，操作按钮仍然要有地方可放 */}
      {lastSpeechIndex === -1 && children !== undefined ? (
        <div className="bubble-actions action-only">{children}</div>
      ) : null}
    </>
  );
}
