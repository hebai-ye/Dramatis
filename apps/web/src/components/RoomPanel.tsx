import type { RoomId, RoomSummary } from '@dramatis/core';

interface Props {
  rooms: RoomSummary[];
  activeRoomId: RoomId | null;
  backendKind: string;
  degraded: boolean;
  playerName: string;
  onPlayerNameChange: (value: string) => void;
  disabled: boolean;
  onOpen: (id: RoomId) => void;
  onDelete: (id: RoomId) => void;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function RoomPanel({
  rooms,
  activeRoomId,
  backendKind,
  degraded,
  playerName,
  onPlayerNameChange,
  disabled,
  onOpen,
  onDelete,
}: Props) {
  return (
    <section className="panel">
      <h2>世界</h2>

      <label>
        你的名字（persona）
        <input
          type="text"
          value={playerName}
          disabled={disabled}
          onChange={(event) => onPlayerNameChange(event.target.value)}
        />
      </label>

      {degraded ? (
        <div className="notice error">
          <strong>数据不会被保存</strong>
          <p>
            当前浏览器不允许使用 IndexedDB（当前后端：{backendKind}），本次对话只存在内存里，
            刷新后就会丢失。请换一个浏览器或退出隐私模式。
          </p>
        </div>
      ) : null}

      {rooms.length === 0 ? (
        <p className="hint">还没有世界。导入一张角色卡就会开始第一条世界线。</p>
      ) : (
        <ul className="room-list">
          {rooms.map((room) => (
            <li key={room.id} className={room.id === activeRoomId ? 'active' : ''}>
              <button type="button" className="room-open" disabled={disabled} onClick={() => onOpen(room.id)}>
                <span className="room-title">{room.title}</span>
                <span className="hint">
                  {room.messageCount} 条 · {room.instanceCount} 名角色 · {formatTime(room.updatedAt)}
                </span>
              </button>
              <button
                type="button"
                className="ghost danger"
                disabled={disabled}
                title="删除这个世界的全部对话与角色状态（角色卡会保留）"
                onClick={() => {
                  if (window.confirm(`确定删除「${room.title}」？这会清空它的全部对话与角色状态。`)) {
                    onDelete(room.id);
                  }
                }}
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
