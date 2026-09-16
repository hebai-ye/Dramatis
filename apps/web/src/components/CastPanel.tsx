import type { CharacterInstance, InstanceId, Presence, Scene } from '@dramatis/core';

interface Props {
  instances: CharacterInstance[];
  scene: Scene;
  disabled: boolean;
  onSetPresence: (id: InstanceId, presence: Presence) => void;
  onRename: (id: InstanceId, name: string) => void;
  onRemove: (id: InstanceId) => void;
}

const PRESENCE_OPTIONS: Array<{ value: Presence; label: string; note: string }> = [
  { value: 'onstage', label: '在场', note: '会说话，也会记得发生的事' },
  { value: 'muted', label: '沉默', note: '在场但不发言，仍然记得' },
  { value: 'offscreen', label: '在幕后', note: '不在这个场景，但时间仍在流逝' },
];

function describe(instance: CharacterInstance, scene: Scene): string {
  const inCast = scene.cast.includes(instance.id);
  if (!inCast && instance.presence === 'onstage') return '名单与状态不一致：点了在场但不在名单里';
  return PRESENCE_OPTIONS.find((option) => option.value === instance.presence)?.note ?? '';
}

/**
 * 阵容面板（ROADMAP P0-3 / P0-6）。
 *
 * presence 与场景名单是一对需要保持同步的状态，所以放在同一个面板里操作，
 * 而不是分散到两个地方让用户自己对齐。
 */
export function CastPanel({ instances, scene, disabled, onSetPresence, onRename, onRemove }: Props) {
  if (instances.length === 0) return null;

  return (
    <section className="panel">
      <h2>阵容</h2>
      <p className="hint">
        入场策略「{scene.castPolicy === 'locked' ? '锁定名单' : scene.castPolicy}」决定 AI 能否自行引入新角色；
        这里决定已有角色此刻在不在场。
      </p>

      <ul className="cast-list">
        {instances.map((instance) => (
          <li key={instance.id}>
            <div className="cast-row">
              <input
                type="text"
                className="cast-name"
                value={instance.displayName}
                disabled={disabled}
                onChange={(event) => onRename(instance.id, event.target.value)}
              />
              <select
                value={instance.presence}
                disabled={disabled}
                onChange={(event) => onSetPresence(instance.id, event.target.value as Presence)}
              >
                {PRESENCE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="ghost danger"
                disabled={disabled || instances.length <= 1}
                title="把这个角色移出这个世界（角色卡会保留）"
                onClick={() => {
                  if (window.confirm(`把「${instance.displayName}」移出这个房间？`)) onRemove(instance.id);
                }}
              >
                移除
              </button>
            </div>
            <p className="hint">{describe(instance, scene)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
