import type { CharacterInstance, Conversation, Room } from '@dramatis/core';

interface Props {
  world: Room | null;
  conversation: Conversation | null;
  /** 此刻在场景里的人，随快照实时刷新。 */
  cast: CharacterInstance[];
  disabled: boolean;
  panelOpen: boolean;
  /**
   * 窄屏（≤640px）：按钮与在场角色都搬到顶栏去了（用户 2026-09-24 要求），
   * 这里只留「世界名 · 对话名」。桌面一个字没改。
   */
  narrow: boolean;
  onToggleKind: () => void;
  onTogglePanel: () => void;
  onRenameConversation: (title: string) => void;
}

/**
 * 主区标题栏（LAYOUT「主区 · 标题栏」）。
 *
 * 显示当前世界名与对话名、当前场景内的角色（实时刷新），
 * 右上角切换**主对话 / 副对话**——这是两条独立记录，所以它是切换而不是开关。
 */
export function MainHeader({
  world,
  conversation,
  cast,
  disabled,
  panelOpen,
  narrow,
  onToggleKind,
  onTogglePanel,
  onRenameConversation,
}: Props) {
  const isSide = conversation?.kind === 'side';

  return (
    <header className="main-header">
      <div className="main-title">
        <span className="world-name">{world?.title ?? '未载入世界'}</span>
        <span className="dot">·</span>
        <input
          className="conversation-name"
          value={conversation?.title ?? ''}
          disabled={disabled || conversation === null}
          placeholder="对话名"
          aria-label="对话名"
          onChange={(event) => onRenameConversation(event.target.value)}
        />
      </div>

      <div className="cast-inline" title="当前场景里都有谁">
        {/*
          手机上这一块搬到顶栏了（半高的角色条，点一下就能对某人说话）：
          640px 宽的屏里它和按钮抢地方，一多就换行，把对话往下挤。
        */}
        {narrow ? null : isSide ? (
          <span className="hint">世界管理员 · 不扮演任何角色</span>
        ) : cast.length === 0 ? (
          <span className="hint">场景里还没有人</span>
        ) : (
          cast.map((instance) => (
            <span key={instance.id} className="cast-chip">
              {instance.displayName}
            </span>
          ))
        )}
      </div>

      <div className="topbar-spacer" />

      {narrow ? null : (
        <div className="kind-switch">
          <button
            type="button"
            className={isSide ? 'tab' : 'tab active'}
            disabled={disabled}
            onClick={() => {
              if (isSide) onToggleKind();
            }}
          >
            主对话
          </button>
          <button
            type="button"
            className={isSide ? 'tab active' : 'tab'}
            disabled={disabled}
            onClick={() => {
              if (!isSide) onToggleKind();
            }}
          >
            副对话
          </button>
        </div>
      )}

      {narrow ? null : (
        <button
          type="button"
          className={panelOpen ? 'ghost active' : 'ghost'}
          disabled={disabled}
          title="运行时面板：场景、阵容、记忆、Prompt"
          onClick={onTogglePanel}
        >
          面板
        </button>
      )}
    </header>
  );
}
