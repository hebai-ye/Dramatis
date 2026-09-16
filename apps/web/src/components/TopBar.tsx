import type { Persona, RoomId, RoomSummary } from '@dramatis/core';

interface Props {
  rooms: RoomSummary[];
  activeRoomId: RoomId | null;
  personas: Persona[];
  activePersonaId: string | null;
  backendKind: string;
  degraded: boolean;
  canStartNewWorld: boolean;
  disabled: boolean;
  onOpenRoom: (id: RoomId) => void;
  onDeleteRoom: (id: RoomId) => void;
  onNewWorld: () => void;
  onSelectPersona: (persona: Persona) => void;
  onReset: () => void;
}

/**
 * 顶部栏：世界切换与「我是谁」。
 *
 * 这两件事既不属于设定也不属于运行时——它们是**会话导航**，
 * 所以单独放在顶上，随时可达。
 */
export function TopBar({
  rooms,
  activeRoomId,
  personas,
  activePersonaId,
  backendKind,
  degraded,
  canStartNewWorld,
  disabled,
  onOpenRoom,
  onDeleteRoom,
  onNewWorld,
  onSelectPersona,
  onReset,
}: Props) {
  const active = rooms.find((room) => room.id === activeRoomId) ?? null;

  return (
    <header className="topbar">
      <div className="brand-inline">
        <h1>Dramatis</h1>
        <span className="hint">登场</span>
      </div>

      <label className="topbar-field">
        世界
        <select
          value={activeRoomId ?? ''}
          disabled={disabled}
          onChange={(event) => {
            if (event.target.value !== '') onOpenRoom(event.target.value as RoomId);
          }}
        >
          {rooms.length === 0 ? <option value="">还没有世界</option> : null}
          {rooms.map((room) => (
            <option key={room.id} value={room.id}>
              {room.title}（{room.messageCount} 条 · {room.instanceCount} 人）
            </option>
          ))}
        </select>
      </label>

      <button type="button" className="ghost" disabled={disabled || !canStartNewWorld} onClick={onNewWorld}>
        用当前卡开新世界
      </button>

      <label className="topbar-field">
        你是
        <select
          value={activePersonaId ?? ''}
          disabled={disabled}
          onChange={(event) => {
            const next = personas.find((item) => item.id === event.target.value);
            if (next) onSelectPersona(next);
          }}
        >
          {personas.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>

      <div className="topbar-spacer" />

      {degraded ? (
        <span className="tag danger-tag" title="当前浏览器不允许使用 IndexedDB，数据只存在内存里">
          数据不会保存
        </span>
      ) : (
        <span className="hint">存储：{backendKind || '…'}</span>
      )}

      {active ? (
        <button
          type="button"
          className="ghost danger"
          disabled={disabled}
          title="删除这个世界（素材库里的角色卡与世界书会保留）"
          onClick={() => {
            if (window.confirm(`确定删除「${active.title}」？全部对话、角色状态与记忆都会被清空。`)) {
              onDeleteRoom(active.id);
            }
          }}
        >
          删除世界
        </button>
      ) : null}

      <button type="button" className="ghost" disabled={disabled} onClick={onReset}>
        重开
      </button>
    </header>
  );
}
