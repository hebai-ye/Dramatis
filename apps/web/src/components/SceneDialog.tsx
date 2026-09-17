import {
  type CastPolicy,
  type CharacterInstance,
  defaultTravelCast,
  type InstanceId,
  type Scene,
} from '@dramatis/core';
import { useState } from 'react';

interface Props {
  scene: Scene | null;
  instances: CharacterInstance[];
  disabled: boolean;
  onClose: () => void;
  onSave: (patch: Partial<Scene>) => void;
  /** 结束本场、开新场；会写一条旁白式动作记录「谁跟谁去了哪里」。 */
  onStartNewScene: (input: {
    title: string;
    location: string;
    worldTime: string;
    /** 这次带谁走（T17）：没勾的人留在原地，自动转「在幕后」。 */
    cast: InstanceId[];
  }) => void;
}

const CAST_POLICY_OPTIONS: Array<{ value: CastPolicy; label: string; note: string }> = [
  { value: 'locked', label: '锁定名单', note: '不得引入任何新角色' },
  { value: 'invite_only', label: '仅限召唤', note: '只有你点名的角色才能入场' },
  { value: 'triggered', label: '条件触发', note: '设定被触发时才入场' },
  { value: 'open', label: '自由入场', note: '符合条件的角色可自行登场' },
];

/**
 * 场景面板（LAYOUT「输入区 · 场景：输入 / 切换当前场景」）。
 *
 * 输入场景与切换场景是两件事：
 * - 改字段 = 就地修改当前场景，安静地生效
 * - 切换场景 = 结束本场、开一场新的，并留下一条**旁白式动作**
 *   （「××× 与 ××× 进入了 ×××」），记录的是谁跟谁去了哪里
 */
export function SceneDialog({ scene, instances, disabled, onClose, onSave, onStartNewScene }: Props) {
  const [title, setTitle] = useState(scene?.title ?? '');
  const [location, setLocation] = useState(scene?.location ?? '');
  const [worldTime, setWorldTime] = useState(scene?.worldTime ?? '');
  // 默认带走此刻在场上的人；换场前可以逐个取消（长跑里秦娘就是这样被误带走的）
  const [travelCast, setTravelCast] = useState<InstanceId[]>(() => defaultTravelCast(scene, instances));

  const cast = scene === null ? [] : instances.filter((instance) => scene.cast.includes(instance.id));

  return (
    <div className="modal-backdrop">
      <button type="button" className="modal-scrim" aria-label="关闭场景" onClick={onClose} />
      <section className="modal" role="dialog" aria-label="场景">
        <header className="modal-head">
          <strong>场景</strong>
          <span className="hint">
            {scene === null
              ? '这条对话还没有场景'
              : `当前：${scene.title}${scene.location === '' ? '' : ` · ${scene.location}`}`}
          </span>
          <div className="topbar-spacer" />
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="modal-body">
          <label>
            场景名
            <input value={title} disabled={disabled} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            地点
            <input
              value={location}
              disabled={disabled}
              placeholder="例如：旧城东侧的夜间酒馆"
              onChange={(event) => setLocation(event.target.value)}
            />
          </label>
          <label>
            世界内时间
            <input
              value={worldTime}
              disabled={disabled}
              placeholder="例如：第三日 · 黄昏"
              onChange={(event) => setWorldTime(event.target.value)}
            />
          </label>

          {scene !== null ? (
            <>
              <label>
                入场策略
                <select
                  value={scene.castPolicy}
                  disabled={disabled}
                  onChange={(event) => onSave({ castPolicy: event.target.value as CastPolicy })}
                >
                  {CAST_POLICY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="hint">
                {CAST_POLICY_OPTIONS.find((option) => option.value === scene.castPolicy)?.note ?? ''}
              </p>

              <label>
                场景设定
                <textarea
                  rows={4}
                  value={scene.summary}
                  disabled={disabled}
                  onChange={(event) => onSave({ summary: event.target.value })}
                />
              </label>
            </>
          ) : null}

          <p className="hint">
            此刻在场：{cast.length === 0 ? '没有人' : cast.map((instance) => instance.displayName).join('、')}
          </p>

          <fieldset className="picker">
            <legend>这次带谁走</legend>
            <p className="hint">取消勾选的人留在原地，会自动转为「在幕后」；旁白只记跟着走的人。</p>
            {cast.length === 0 ? (
              <p className="hint">此刻场上没有人。</p>
            ) : (
              cast.map((instance) => (
                <label key={instance.id} className="inline-check">
                  <input
                    type="checkbox"
                    checked={travelCast.includes(instance.id)}
                    disabled={disabled}
                    onChange={() =>
                      setTravelCast((previous) =>
                        previous.includes(instance.id)
                          ? previous.filter((id) => id !== instance.id)
                          : [...previous, instance.id],
                      )
                    }
                  />
                  <span>{instance.displayName}</span>
                </label>
              ))
            )}
          </fieldset>
        </div>

        <footer className="modal-foot">
          <button
            type="button"
            className="ghost"
            disabled={disabled}
            onClick={() => {
              onSave({ title, location, worldTime });
              onClose();
            }}
          >
            保存当前场景
          </button>
          <button
            type="button"
            disabled={disabled}
            title="结束本场、开一场新的，并留下一条「谁跟谁去了哪里」的旁白"
            onClick={() => {
              onStartNewScene({
                title: title.trim() === '' ? '新场景' : title.trim(),
                location,
                worldTime,
                cast: travelCast,
              });
              onClose();
            }}
          >
            从这里切换场景
          </button>
        </footer>
      </section>
    </div>
  );
}
