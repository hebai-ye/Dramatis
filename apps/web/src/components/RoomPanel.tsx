import type { Persona, RoomId, RoomSummary } from '@dramatis/core';

interface Props {
  rooms: RoomSummary[];
  activeRoomId: RoomId | null;
  backendKind: string;
  degraded: boolean;
  personas: Persona[];
  activePersonaId: string | null;
  onUsePersona: (id: string) => void;
  onCreatePersona: () => void;
  onUpdatePersona: (patch: { name?: string; description?: string }) => void;
  onOpenRoom: (id: RoomId) => void;
  onDeleteRoom: (id: RoomId) => void;
  onNewWorld: () => void;
  canStartNewWorld: boolean;
  disabled: boolean;
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
  personas,
  activePersonaId,
  onUsePersona,
  onCreatePersona,
  onUpdatePersona,
  onOpenRoom,
  onDeleteRoom,
  onNewWorld,
  canStartNewWorld,
  disabled,
}: Props) {
  const activePersona = personas.find((persona) => persona.id === activePersonaId) ?? null;

  return (
    <section className="panel">
      <h2>世界</h2>

      {degraded ? (
        <div className="notice error">
          <strong>数据不会被保存</strong>
          <p>
            当前浏览器不允许使用 IndexedDB（当前后端：{backendKind}），本次对话只存在内存里，
            刷新后就会丢失。请换一个浏览器或退出隐私模式。
          </p>
        </div>
      ) : null}

      <label>
        你的身份（persona）
        <select
          value={activePersonaId ?? ''}
          disabled={disabled}
          onChange={(event) => {
            if (event.target.value === '__new__') {
              onCreatePersona();
              return;
            }
            onUsePersona(event.target.value);
          }}
        >
          {personas.map((persona) => (
            <option key={persona.id} value={persona.id}>
              {persona.name}
            </option>
          ))}
          <option value="__new__">＋ 新建身份</option>
        </select>
      </label>

      {activePersona ? (
        <>
          <label>
            名字
            <input
              type="text"
              value={activePersona.name}
              disabled={disabled}
              onChange={(event) => onUpdatePersona({ name: event.target.value })}
            />
          </label>
          <label>
            设定
            <textarea
              rows={3}
              value={activePersona.description}
              disabled={disabled}
              placeholder="你是谁、长什么样、什么来头"
              onChange={(event) => onUpdatePersona({ description: event.target.value })}
            />
          </label>
        </>
      ) : null}

      <button type="button" className="ghost" disabled={disabled || !canStartNewWorld} onClick={onNewWorld}>
        用当前角色开新世界
      </button>

      {rooms.length === 0 ? (
        <p className="hint">还没有世界。导入一张角色卡就会开始第一条世界线。</p>
      ) : (
        <ul className="room-list">
          {rooms.map((room) => (
            <li key={room.id} className={room.id === activeRoomId ? 'active' : ''}>
              <button type="button" className="room-open" disabled={disabled} onClick={() => onOpenRoom(room.id)}>
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
                    onDeleteRoom(room.id);
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
