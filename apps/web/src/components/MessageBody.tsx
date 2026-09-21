import { type Message, renderMessageContent } from '@dramatis/core';
import type { ReactNode } from 'react';

interface Props {
  message: Message;
  /** 说话者的显示名，用于剥掉模型偶尔写在开头的人名前缀。 */
  speakerName: string;
  /** 只有多角色同场时需要每段都标名字，单独说话时标一次就够。 */
  showSpeaker: boolean;
  /**
   * 挂在气泡**下面**（不是里面）的操作按钮（重抽 / 编辑 / 删除）。
   *
   * 它们平时是**看不见的**：桌面靠悬停露出来、手机靠长按出菜单
   * （用户 2026-09-21 的要求——常驻在气泡下面既碍眼，在窄屏上还会顶出气泡）。
   * 所以这里包的是 `row-actions` 而不是以前那个 `bubble-actions`：
   * 可见性由样式统一控制，编辑态的「保存 / 取消」不走这条路，永远可见。
   *
   * 位置后来改过一次：以前它们住在最后一段气泡**里面**，于是每个气泡底部都
   * 拖着一块看不见的空白（用户原话「消息框下方空位较大」）。现在挂在气泡外面，
   * 气泡只包住自己的字，那块空位留在气泡与下一条消息之间。
   */
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
export function MessageBody({ message, speakerName, showSpeaker, children }: Props) {
  if (message.role === 'narration' || message.role === 'system') {
    return <p className="narration-line">{message.content}</p>;
  }

  // 角色的动作用名字做主语（「我把手收了回来」→「陈九把手收了回来」）：
  // 界面上的动作是给玩家看的第三方叙述，不是角色在念旁白。玩家的动作保持第一人称
  const segments = renderMessageContent(message.content, {
    speakerName,
    thirdPersonActions: message.role === 'character',
  });
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
          </div>
        ),
      )}

      {/* 操作按钮是气泡的**兄弟**，不在气泡里：放在气泡里的后果是每个气泡底部
          都拖着一块看不见的空白（用户 2026-09-21 指出的「消息框下方空位较大」）。 */}
      {children === undefined ? null : <div className="row-actions">{children}</div>}
    </>
  );
}
