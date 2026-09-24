import { type CharacterInstance, type InstanceId, PLAYER, type Presence, type Scene } from '@dramatis/core';
import { useDraftField } from '../lib/useDraftField';

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

function signed(value: number): string {
  return `${value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(2)}`;
}

function describeState(instance: CharacterInstance): string {
  const { valence, arousal } = instance.affect;
  const mood =
    valence >= 0.5
      ? '心情很好'
      : valence >= 0.15
        ? '心情不错'
        : valence <= -0.5
          ? '情绪低落'
          : valence <= -0.15
            ? '有些不快'
            : '情绪平稳';
  const energy = arousal >= 0.7 ? '很激动' : arousal >= 0.4 ? '有点起伏' : '比较平静';

  const towardPlayer = instance.relationships.find((edge) => edge.target === PLAYER);
  const relationship = towardPlayer
    ? ` · 对玩家 信任 ${signed(towardPlayer.trust)} 好感 ${signed(towardPlayer.affinity)} 敬重 ${signed(towardPlayer.respect)} 紧张 ${signed(towardPlayer.tension)}`
    : '';

  return `${mood}，${energy}（${signed(valence)} / ${arousal.toFixed(2)}）${relationship}`;
}

/**
 * 阵容面板（ROADMAP P0-3 / P0-6）。
 *
 * presence 与场景名单是一对需要保持同步的状态，所以放在同一个面板里操作，
 * 而不是分散到两个地方让用户自己对齐。
 */
/**
 * 一条角色名输入框。
 *
 * 单独抽成组件是因为草稿 hook 必须在**组件顶层**调用，而这里是 `instances.map(...)`——
 * 在循环里调 hook 会破坏 hook 顺序（React 会直接报错）。
 */
function CastNameInput({
  instance,
  disabled,
  onRename,
}: {
  instance: CharacterInstance;
  disabled: boolean;
  onRename: (id: InstanceId, name: string) => void;
}) {
  const nameField = useDraftField({
    value: instance.displayName,
    commit: (next) => {
      if (next.trim() === '') return;
      onRename(instance.id, next);
    },
  });
  return <input type="text" className="cast-name" disabled={disabled} aria-label="显示名" {...nameField.bind} />;
}

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
              <CastNameInput instance={instance} disabled={disabled} onRename={onRename} />
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
            <p className="hint">{describeState(instance)}</p>
            {instance.affect.history.length > 0 ? (
              <details>
                <summary>最近的状态变化</summary>
                <ul className="hint">
                  {instance.affect.history
                    .slice(-3)
                    .reverse()
                    .map((change, index) => (
                      <li key={`${change.turnId}-${String(index)}`}>
                        {change.reason || '未记录原因'}（情绪 {signed(change.deltaValence)} /{' '}
                        {signed(change.deltaArousal)}）
                      </li>
                    ))}
                </ul>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
