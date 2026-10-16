import { type CharacterInstance, type InstanceId, PLAYER, type Presence, type Scene } from '@dramatis/core';
import { useCallback, useEffect, useRef } from 'react';
import { PRESENCE_OPTIONS, signed } from '../lib/labels';
import { type DraftField, type DraftFlush, flushDraftFields, useDraftField } from '../lib/useDraftField';
import { useSerialSave } from '../lib/useSerialSave';
import { DraftSaveFeedback } from './DraftSaveFeedback';

interface Props {
  instances: CharacterInstance[];
  scene: Scene;
  disabled: boolean;
  onSetPresence: (id: InstanceId, presence: Presence) => void | Promise<void>;
  onRename: (id: InstanceId, name: string) => void | Promise<void>;
  onRemove: (id: InstanceId) => void | Promise<void>;
  onOpenDetail?: (id: InstanceId) => void;
  onRegisterFlush?: (flush: DraftFlush | null) => void;
}

function describe(instance: CharacterInstance, scene: Scene): string {
  const inCast = scene.cast.includes(instance.id);
  if (!inCast && instance.presence === 'onstage') return '名单与状态不一致：点了在场但不在名单里';
  return PRESENCE_OPTIONS.find((option) => option.value === instance.presence)?.note ?? '';
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
  onRegisterFlush,
}: {
  instance: CharacterInstance;
  disabled: boolean;
  onRename: (id: InstanceId, name: string) => void | Promise<void>;
  onRegisterFlush: (field: DraftField | null) => void;
}) {
  const nameField = useDraftField({
    value: instance.displayName,
    scope: JSON.stringify([instance.roomId, instance.id]),
    commit: (next) => {
      if (next.trim() === '') throw new Error('显示名不能为空。');
      return onRename(instance.id, next);
    },
  });
  useEffect(() => {
    onRegisterFlush(nameField);
    return () => onRegisterFlush(null);
  }, [onRegisterFlush, nameField]);
  return (
    <div className="cast-edit-field">
      <input type="text" className="cast-name" disabled={disabled} aria-label="显示名" {...nameField.bind} />
      <DraftSaveFeedback field={nameField} label="显示名" />
    </div>
  );
}

function CastPresenceInput({
  instance,
  scene,
  disabled,
  onSetPresence,
  onRegisterFlush,
}: {
  instance: CharacterInstance;
  scene: Scene;
  disabled: boolean;
  onSetPresence: Props['onSetPresence'];
  onRegisterFlush: (field: DraftField | null) => void;
}) {
  const field = useDraftField({
    value: instance.presence,
    scope: JSON.stringify([scene.id, instance.id]),
    delay: 0,
    commit: (next) => onSetPresence(instance.id, next as Presence),
  });
  useEffect(() => {
    onRegisterFlush(field);
    return () => onRegisterFlush(null);
  }, [onRegisterFlush, field]);
  return (
    <div className="cast-edit-field">
      <select aria-label={`「${instance.displayName}」的在场状态`} disabled={disabled} {...field.bind}>
        {PRESENCE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <DraftSaveFeedback field={field} label="在场状态" />
    </div>
  );
}

export function CastPanel({
  instances,
  scene,
  disabled,
  onSetPresence,
  onRename,
  onRemove,
  onOpenDetail,
  onRegisterFlush,
}: Props) {
  const saves = useSerialSave(scene.id);
  const fields = useRef(new Map<string, DraftField>());
  const flush = useCallback(async () => {
    return flushDraftFields([...fields.current.values()], saves.flush);
  }, [saves.flush]);
  useEffect(() => {
    onRegisterFlush?.(flush);
    return () => onRegisterFlush?.(null);
  }, [onRegisterFlush, flush]);
  const register = (key: string, save: DraftField | null) => {
    if (save) fields.current.set(key, save);
    else fields.current.delete(key);
  };
  if (instances.length === 0) return null;

  return (
    <section className="panel">
      <h2>阵容</h2>
      <p className="hint">
        名称和在场状态修改后自动保存。 入场策略「{scene.castPolicy === 'locked' ? '锁定名单' : scene.castPolicy}」决定
        AI 能否自行引入新角色； 这里决定已有角色此刻在不在场。
      </p>

      <ul className="cast-list">
        {instances.map((instance) => (
          <li key={instance.id}>
            <div className="cast-row">
              <CastNameInput
                instance={instance}
                disabled={disabled}
                onRename={(id, name) => saves.run(() => onRename(id, name))}
                onRegisterFlush={(save) => register(`name:${instance.id}`, save)}
              />
              <CastPresenceInput
                instance={instance}
                scene={scene}
                disabled={disabled}
                onSetPresence={(id, presence) => saves.run(() => onSetPresence(id, presence))}
                onRegisterFlush={(save) => register(`presence:${instance.id}`, save)}
              />
              {onOpenDetail === undefined ? null : (
                <button
                  type="button"
                  className="ghost"
                  aria-label={`查看「${instance.displayName}」的角色详情`}
                  onClick={() => onOpenDetail(instance.id)}
                >
                  详情
                </button>
              )}
              <button
                type="button"
                className="ghost danger"
                disabled={disabled || saves.busy || instances.length <= 1}
                title="把这个角色移出这个世界（角色卡会保留）"
                onClick={async () => {
                  if (!window.confirm(`把「${instance.displayName}」移出这个房间？`) || !(await flush())) return;
                  try {
                    await saves.run(() => onRemove(instance.id));
                  } catch {
                    /* The local queue displays the failure. */
                  }
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
      {saves.error ? (
        <p className="hint error" role="alert">
          角色操作未完成：{saves.error}
        </p>
      ) : null}
    </section>
  );
}
